// pump.fun launch sniper: five wallets, ONE TRANSACTION, contract address known
// in advance.
//
// Knowing the mint before the launch changes the architecture completely. The
// usual approach — watch the program's logs for a create, pull the transaction
// back to find out which mint it was, then quote and buy — spends two network
// round trips discovering something we were told in advance. None of that is
// here. Instead:
//
//   1. the bonding curve PDA is derived from the mint at boot, because it is a
//      pure function of the mint and does not need the account to exist
//   2. we subscribe to that exact address and wait for it to be written
//   3. the arithmetic for all five buys is done BEFORE the launch, against the
//      initial curve state, which pump.fun fixes and publishes in its Global
//      account
//
// So the hot path is: decode the account we were just handed, derive one PDA,
// build, sign, submit. No RPC call stands between the launch and the send.
//
// WHY ONE TRANSACTION AND NOT A JITO BUNDLE. The first design put the five buys
// in a bundle. Jito accepted every one of them — five relays, HTTP 200, a bundle
// id — and then silently discarded them: status Invalid, never reaching Pending,
// nothing on chain. That held for a 217-byte transaction containing nothing but
// a tip, which rules out anything about what we were sending. A bundle delegates
// atomicity to a block engine that can decline to forward it, and this one does.
//
// A single transaction needs nobody's permission. It applies completely or not
// at all because the runtime enforces it, and it lands through ordinary RPC with
// a priority fee. Five buys do not fit in 1232 bytes on their own — the fourth
// is 1432 and the fifth will not compile — so an address lookup table carries
// the shared accounts. That is the only reason lookup-table.mjs exists.
//
// The curve state is still re-read from the notification and the plan re-run if
// it is not what we expected — being first is the plan, not an assumption.

import { EventEmitter } from 'node:events';
import {
  ComputeBudgetProgram, PublicKey,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  PUMP_PROGRAM, PUMP_GLOBAL, PUMP_FEE_PROGRAM,
  BUYBACK_DISCRIMINATOR, BUYBACK_ACCOUNT_SIZE,
  decodeGlobal, decodeBondingCurve, deriveBondingCurve,
  buildBuyInstruction, createAtaIdempotentInstruction, planLadder,
  tokenProgramForMintAccount,
} from './pump.mjs';
import { createLookupTable, lookupAddressesFor } from './lookup-table.mjs';
import bs58 from 'bs58';

/** Rent for a token account, in lamports. Held back from every wallet's budget. */
export const ATA_RENT_LAMPORTS = 2_039_280n;
/** Solana's per-signature fee. This transaction carries one per wallet. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** Solana refuses any transaction over this, outright. */
export const MAX_TRANSACTION_BYTES = 1232;

/** How many buys fit in one transaction with a lookup table. Measured, not guessed. */
export const MAX_WALLETS = 5;

/**
 * Compute units requested per buy.
 *
 * Measured on mainnet: a pump.fun buy plus its token-account create costs
 * 88,000-99,000 units. 120,000 leaves headroom without over-requesting, which is
 * not free — the priority fee is charged on the limit asked for, not the units
 * actually burned.
 */
export const COMPUTE_UNITS_PER_BUY = 120_000;

/** The runtime's ceiling for a single transaction. */
export const MAX_COMPUTE_UNITS = 1_400_000;

/** Dust rehearsal: one raw token unit under a 0.001 SOL cap. Same shape, no size. */
export const REHEARSAL_MAX_SOL_COST = 1_000_000n;

/**
 * How old a blockhash may be when we sign with it.
 *
 * Solana accepts a transaction for 150 slots after its blockhash — roughly 60
 * seconds. Past that the cluster does not delay it, it REJECTS it. 30s leaves
 * room to reach a leader and still be inside the window.
 *
 * Measured the hard way: a run whose blockhash refresh had been failing for
 * twelve minutes fired a bundle that five relays accepted and no leader could
 * execute. Nothing in the fire path had checked how old the blockhash was.
 */
export const MAX_BLOCKHASH_AGE_MS = 30_000;

export class PumpSniper extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('@solana/web3.js').Connection} opts.connection
   * @param {object[]} opts.wallets           from loadSniperWallets, in buy order
   * @param {string[]} opts.mints             target contract addresses
   * @param {bigint}   opts.slippageBps
   * @param {number}   opts.computeUnitLimit
   * @param {number}   opts.computeUnitPriceMicroLamports
   * @param {bigint}   opts.maxPreBuyLamports refuse if the curve already holds more than this
   * @param {boolean}  opts.paper             build and verify, sign nothing, send nothing
   */
  constructor(opts) {
    super();
    const {
      connection, wallets,
      slippageBps, mints = [],
      computeUnitLimit = 250_000, computeUnitPriceMicroLamports = 500_000,
      maxPreBuyLamports = 0n, paper = true, rehearse = false,
    } = opts;

    if (!connection) throw new Error('sniper: connection is required');
    if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('sniper: no wallets');
    // No longer a bundle-slot limit — a byte limit. Five buys compile to about a
    // kilobyte with a lookup table; each further wallet costs ~153 bytes of
    // message plus a 64-byte signature, against 1232 total.
    if (wallets.length > MAX_WALLETS) {
      throw new Error(`sniper: ${wallets.length} wallets will not fit in one transaction (max ${MAX_WALLETS})`);
    }
    // Deliberately allowed to be empty. The contract address is usually not
    // known when the process starts — that is the entire reason the Telegram
    // control plane exists — so "no target yet" is a normal state to boot into,
    // not an error. watch() is where a missing target becomes a refusal.
    if (mints !== undefined && !Array.isArray(mints)) throw new Error('sniper: mints must be an array');

    this.connection = connection;
    this.wallets = wallets;
    this.mints = mints.map((m) => new PublicKey(m));
    this.slippageBps = slippageBps;
    this.computeUnitLimit = computeUnitLimit;
    this.computeUnitPriceMicroLamports = computeUnitPriceMicroLamports;
    this.maxPreBuyLamports = maxPreBuyLamports;
    this.paper = paper;
    /**
     * Dust rehearsal. Fires the REAL path — same transaction, same five signers,
     * same 18-account buys, same token-account creates, same lookup table — but
     * asks for one raw token unit per wallet instead of a real size. pump.fun's
     * buy takes the exact token amount out, so one unit costs essentially
     * nothing while the transaction stays structurally identical.
     *
     * It answers "does this land" without putting half a SOL behind the
     * question.
     */
    this.rehearse = rehearse;

    this.global = null;
    this.buybackRecipients = [];
    this.blockhash = null;
    this.blockhashAt = 0;
    this.blockhashFailures = 0;
    this.blockhashTimer = null;
    this.subscriptions = new Map(); // mint base58 -> subscription id (bonding curve)
    this.mintSubscriptions = new Map(); // mint base58 -> subscription id (mint account)
    /** mint base58 -> token program. Learned from the mint account, never guessed:
     *  most pump.fun mints are Token-2022, and assuming the classic program
     *  derives the wrong ATA and fails the buy. */
    this.tokenPrograms = new Map();
    /** Built when a target is set. Five buys do not compile without it. */
    this.lookupTable = null;
    this.lookupTableAddress = null;
    /** Mints already acted on. A curve account is written on every trade, not
     *  only at creation, so without this the next buy by anyone else would
     *  re-fire us. */
    this.fired = new Set();
    this.armed = false;
  }

  /** Read everything that is fixed for the run: fee rate, recipients, curve constants. */
  async prime() {
    const globalInfo = await this.connection.getAccountInfo(PUMP_GLOBAL, 'confirmed');
    if (!globalInfo) throw new Error('sniper: pump.fun Global account not readable');
    if (!globalInfo.owner.equals(PUMP_PROGRAM)) {
      throw new Error('sniper: pump.fun Global account is not owned by the pump program');
    }
    this.global = decodeGlobal(globalInfo.data);

    const buyback = await this.connection.getProgramAccounts(PUMP_FEE_PROGRAM, {
      commitment: 'confirmed',
      filters: [
        { dataSize: BUYBACK_ACCOUNT_SIZE },
        { memcmp: { offset: 0, bytes: bs58.encode(BUYBACK_DISCRIMINATOR) } },
      ],
      dataSlice: { offset: 0, length: 0 },
    });
    if (buyback.length === 0) throw new Error('sniper: no pump.fun buyback fee recipients found on chain');
    this.buybackRecipients = buyback.map((a) => a.pubkey);

    await this.#refreshBlockhash();
    this.emit('primed', {
      feeBasisPoints: this.global.feeBasisPoints.toString(),
      feeRecipients: this.global.feeRecipients.length,
      buybackRecipients: this.buybackRecipients.length,
      initialVirtualSolReserves: this.global.initialVirtualSolReserves.toString(),
      initialVirtualTokenReserves: this.global.initialVirtualTokenReserves.toString(),
    });
    return this.global;
  }

  /** The curve state pump.fun starts every launch at. */
  initialReserves() {
    if (!this.global) throw new Error('sniper: prime() has not run');
    return {
      virtualTokenReserves: this.global.initialVirtualTokenReserves,
      virtualSolReserves: this.global.initialVirtualSolReserves,
      realTokenReserves: this.global.initialRealTokenReserves,
      realSolReserves: 0n,
      complete: false,
    };
  }

  /** The legs, in execution order, with each wallet's budget in lamports. */
  legs() {
    return this.wallets.map((w) => ({
      label: `w${w.index + 1}`,
      index: w.index,
      address: w.address,
      budgetLamports: w.budgetLamports,
    }));
  }

  /** Plan the ladder against a given curve state. Pure; safe to re-run at fire time. */
  plan(reserves) {
    return planLadder({
      reserves,
      legs: this.legs(),
      feeBasisPoints: this.global.feeBasisPoints,
      slippageBps: this.slippageBps,
    });
  }

  /**
   * Confirm each wallet can actually pay for its leg before anything is armed.
   *
   * A wallet short by a lamport fails its
   * buy makes the WHOLE transaction fail, so all five are lost. Checking now
   * turns that into a startup error instead of a missed launch.
   */
  async checkBalances() {
    const addresses = this.wallets.map((w) => new PublicKey(w.address));
    const infos = await this.connection.getMultipleAccountsInfo(addresses, 'confirmed');
    const report = [];
    for (let i = 0; i < this.wallets.length; i++) {
      const w = this.wallets[i];
      const balance = BigInt(infos[i]?.lamports ?? 0);
      // The priority fee is real lamports and was missing from this sum. At
      // 250k CU and 500k microLamports/CU it is 125,000 lamports per wallet —
      // small, but a wallet that passes this check and then cannot pay fails its
      // buy, and one failing instruction reverts the entire transaction.
      // One transaction now, so ONE fee payer carries every signature and the
      // whole priority fee. The other wallets pay only for their own buy and
      // their own token account.
      let required = w.budgetLamports + ATA_RENT_LAMPORTS;
      if (i === 0) {
        required += SIGNATURE_FEE_LAMPORTS * BigInt(this.wallets.length) + this.priorityFeeLamports();
      }
      report.push({
        address: w.address, balance, required, sufficient: balance >= required,
        shortfall: balance >= required ? 0n : required - balance,
      });
    }
    return report;
  }

  /** What the compute budget instructions will actually cost, in lamports. */
  priorityFeeLamports() {
    return (BigInt(this.computeUnits()) * BigInt(this.computeUnitPriceMicroLamports)) / 1_000_000n;
  }

  /** Total compute units this transaction will request. */
  computeUnits() {
    return Math.min(COMPUTE_UNITS_PER_BUY * this.wallets.length, MAX_COMPUTE_UNITS);
  }

  async #refreshBlockhash() {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    this.blockhash = { blockhash, lastValidBlockHeight };
    this.blockhashAt = Date.now();
    return this.blockhash;
  }

  /**
   * Keep a blockhash ready.
   *
   * Fetching one when the launch fires would put a round trip in the hot path,
   * which is the whole thing we are trying to avoid. A blockhash stays valid for
   * 150 slots — about a minute — so refreshing every few seconds costs nothing
   * and means there is always a usable one in hand.
   */
  startBlockhashRefresh(intervalMs = 2000) {
    if (this.blockhashTimer) return;
    this.blockhashTimer = setInterval(() => {
      this.#refreshBlockhash()
        .then(() => {
          if (this.blockhashFailures > 0) {
            this.emit('warn', { at: 'blockhash', recovered: true, afterFailures: this.blockhashFailures });
            this.blockhashFailures = 0;
          }
        })
        .catch((err) => {
          this.blockhashFailures += 1;
          const age = Date.now() - this.blockhashAt;
          // One failed refresh is noise; a stale blockhash is a bot that cannot
          // land anything. Escalate on AGE, not on the failure count, because
          // that is what actually decides whether a bundle can execute.
          this.emit(age > MAX_BLOCKHASH_AGE_MS ? 'stale' : 'warn', {
            at: 'blockhash',
            error: err.message,
            failures: this.blockhashFailures,
            ageMs: age,
            canFire: age <= MAX_BLOCKHASH_AGE_MS,
          });
        });
    }, intervalMs);
    this.blockhashTimer.unref?.();
  }

  stopBlockhashRefresh() {
    if (this.blockhashTimer) { clearInterval(this.blockhashTimer); this.blockhashTimer = null; }
  }

  #pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /**
   * Build the five signed transactions for one launch.
   *
   * Returns base64 transactions in bundle order. In paper mode the messages are
   * built and checked exactly as they would be, and then not signed — the point
   * is to exercise every step that can throw without producing anything
   * sendable.
   */
  /**
   * Build ONE transaction containing every wallet's buy.
   *
   * This is the redesign. A Jito bundle delegates atomicity to a block engine
   * that can decline to forward it — and did, silently, every time: accepted by
   * five relays, reported Invalid, never reaching the auction, even for a
   * 217-byte transaction carrying nothing but a tip. One transaction needs
   * nobody's permission. It applies completely or not at all because the runtime
   * says so.
   *
   * The five buys still execute in order inside it, so planLadder is priced
   * exactly as before: each leg quoted against the curve the one before it
   * leaves behind.
   */
  buildTransaction({ mint, curve, planned, tokenProgram, lookupTable }) {
    if (!this.blockhash) throw new Error('sniper: no blockhash in hand');
    const age = Date.now() - this.blockhashAt;
    if (age > MAX_BLOCKHASH_AGE_MS) {
      throw new Error(
        `sniper: the blockhash is ${Math.round(age / 1000)}s old and a transaction is only valid for about 60s. ` +
        'Signing it would produce something no leader can execute. The refresh must be failing — check the RPC.',
      );
    }
    if (!tokenProgram) throw new Error('sniper: token program for the mint is unknown');
    if (!lookupTable) {
      throw new Error(
        'sniper: no address lookup table. Five buys are 1432 bytes without one, past the 1232 limit, and the ' +
        'fifth will not even compile. The table is built when the target is set.',
      );
    }

    const feeRecipient = this.#pick(this.global.feeRecipients);
    const buybackRecipient = this.#pick(this.buybackRecipients);

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnits() }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.computeUnitPriceMicroLamports }),
    ];

    for (const leg of planned.legs) {
      const buyer = this.wallets[leg.index].keypair.publicKey;
      // Each wallet opens its own token account and funds its own buy; only the
      // fee payer is charged the transaction fee.
      instructions.push(createAtaIdempotentInstruction({ payer: buyer, owner: buyer, mint, tokenProgram }));
      instructions.push(buildBuyInstruction({
        mint,
        buyer,
        creator: curve.creator,
        amountTokens: this.rehearse ? 1n : leg.requestTokens,
        maxSolCost: this.rehearse ? REHEARSAL_MAX_SOL_COST : leg.maxSolCost,
        feeRecipient,
        buybackRecipient,
        tokenProgram,
      }));
    }

    const message = new TransactionMessage({
      payerKey: this.wallets[0].keypair.publicKey,
      recentBlockhash: this.blockhash.blockhash,
      instructions,
    }).compileToV0Message([lookupTable]);

    const signers = message.header.numRequiredSignatures;
    const transaction = new VersionedTransaction(message);

    // Paper compiles and measures — which exercises message assembly, the
    // lookup table resolving and the size limit — then stops before producing
    // anything sendable.
    if (this.paper) {
      return {
        transaction: null, paper: true, signers, feeRecipient, buybackRecipient,
        size: message.serialize().length + 1 + 64 * signers,
        units: this.computeUnits(),
      };
    }

    // EVERY wallet signs. A missing signature does not degrade the trade, it
    // rejects the transaction — so all five buys are lost together, which is the
    // atomicity working rather than breaking.
    transaction.sign(this.wallets.map((w) => w.keypair));
    const raw = transaction.serialize();
    if (raw.length > MAX_TRANSACTION_BYTES) {
      throw new Error(`sniper: transaction is ${raw.length} bytes, over the ${MAX_TRANSACTION_BYTES} limit`);
    }
    return {
      transaction: raw, paper: false, signers, feeRecipient, buybackRecipient,
      size: raw.length, units: this.computeUnits(),
    };
  }

  /**
   * Decide whether a curve we have just been handed is one we should buy.
   *
   * Three refusals, each for a different failure:
   *   graduated  — the curve is done, buying it here is impossible
   *   fired      — we already acted on this mint; the account is written on
   *                every trade, so later writes are other people's buys
   *   pre-bought — someone got in ahead of us by more than the operator allows
   */
  assess(mintKey, curve) {
    const key = mintKey.toBase58();
    if (this.fired.has(key)) return { act: false, reason: 'already-fired' };
    if (!curve) return { act: false, reason: 'undecodable' };
    if (curve.complete) return { act: false, reason: 'graduated' };
    if (curve.realSolReserves > this.maxPreBuyLamports) {
      return {
        act: false,
        reason: 'pre-bought',
        detail: `curve already holds ${curve.realSolReserves} lamports, limit ${this.maxPreBuyLamports}`,
      };
    }
    return { act: true };
  }

  /**
   * Watch every target mint's bonding curve address.
   *
   * accountSubscribe fires on any write to the account, INCLUDING the write
   * that creates it — which is exactly the moment a pump.fun launch becomes
   * tradeable. Subscribing to an address that does not exist yet is legal and
   * is the whole trick: we are told the instant it does, with the account's
   * data already in the notification, so nothing has to be fetched to decide.
   *
   * 'processed' is the earliest commitment a normal RPC will report. Waiting
   * for 'confirmed' would hand back most of the lead we are here to take.
   */
  async watch() {
    if (!this.global) throw new Error('sniper: prime() has not run');
    if (this.mints.length === 0) throw new Error('sniper: no target set — nothing to watch');
    // Armed BEFORE the first subscription, not after the last. Subscribing is
    // not instant, and a launch landing on the first mint while the second is
    // still being set up would otherwise be dropped by the guard in the handler
    // — the one case the whole program exists for.
    this.armed = true;
    for (const mint of this.mints) {
      const curveAddress = deriveBondingCurve(mint);
      const key = mint.toBase58();
      const subId = this.connection.onAccountChange(
        curveAddress,
        (accountInfo, context) => {
          this.#onCurveWrite(mint, accountInfo, context).catch((err) => {
            this.emit('error', { mint: key, at: 'onCurveWrite', error: err?.message ?? String(err) });
          });
        },
        { commitment: 'processed' },
      );
      this.subscriptions.set(key, subId);

      // Also watch the MINT account, purely to learn which token program owns
      // it. At a launch the mint and the curve are created in the same
      // transaction, so this usually arrives in the same slot as the trigger and
      // the answer is already cached when the bundle is built. When it is not,
      // #resolveTokenProgram falls back to one fetch — correct either way, since
      // the wrong token program fails the buy outright.
      const mintSubId = this.connection.onAccountChange(
        mint,
        (accountInfo) => {
          try {
            this.tokenPrograms.set(key, tokenProgramForMintAccount(accountInfo));
          } catch (err) {
            this.emit('warn', { at: 'mintAccount', mint: key, error: err?.message ?? String(err) });
          }
        },
        { commitment: 'processed' },
      );
      this.mintSubscriptions.set(key, mintSubId);

      // If the mint already exists — testing against a live token rather than
      // waiting for a launch — resolve it now so the hot path never has to.
      this.connection.getAccountInfo(mint, 'processed')
        .then((info) => { if (info) this.tokenPrograms.set(key, tokenProgramForMintAccount(info)); })
        .catch(() => { /* not created yet; the subscription or the fallback covers it */ });

      this.emit('watching', { mint: key, bondingCurve: curveAddress.toBase58() });
    }
  }

  async unwatch() {
    this.armed = false;
    for (const [key, subId] of this.subscriptions) {
      try { await this.connection.removeAccountChangeListener(subId); } catch { /* already gone */ }
      this.subscriptions.delete(key);
    }
    for (const [key, subId] of this.mintSubscriptions) {
      try { await this.connection.removeAccountChangeListener(subId); } catch { /* already gone */ }
      this.mintSubscriptions.delete(key);
    }
  }

  /**
   * The token program that owns a mint, cached.
   *
   * Prefers what the mint subscription already told us so the fire path costs
   * nothing. Falls back to a single read, which is worth the round trip: guessing
   * wrong does not degrade the buy, it fails it.
   */
  async #resolveTokenProgram(mint) {
    const key = mint.toBase58();
    const cached = this.tokenPrograms.get(key);
    if (cached) return { tokenProgram: cached, cached: true };
    const info = await this.connection.getAccountInfo(mint, 'processed');
    const tokenProgram = tokenProgramForMintAccount(info);
    this.tokenPrograms.set(key, tokenProgram);
    return { tokenProgram, cached: false };
  }

  /** A write landed on a curve we are watching. Decide, plan, fire. */
  async #onCurveWrite(mint, accountInfo, context) {
    const key = mint.toBase58();
    const seenAt = Date.now();
    if (!this.armed) return;

    const curve = decodeBondingCurve(accountInfo?.data);
    const verdict = this.assess(mint, curve);
    if (!verdict.act) {
      this.emit('skipped', { mint: key, slot: context?.slot ?? null, ...verdict });
      return;
    }

    // Claim the mint before any await. Two writes in quick succession would
    // otherwise both pass assess() and fire two bundles for one launch.
    this.fired.add(key);

    // Re-plan against what the curve ACTUALLY holds rather than the pre-launch
    // state we planned against at boot. Usually identical; when it is not,
    // somebody moved first and the boot plan would have asked for more tokens
    // than the curve can now give at our cap — which reverts the whole bundle.
    // Re-planning is arithmetic on numbers already in hand, so it costs nothing
    // measurable and removes the failure entirely.
    const planned = this.plan({
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualSolReserves: curve.virtualSolReserves,
      realTokenReserves: curve.realTokenReserves,
      realSolReserves: curve.realSolReserves,
      complete: curve.complete,
    });

    this.emit('firing', {
      mint: key,
      slot: context?.slot ?? null,
      creator: curve.creator.toBase58(),
      legs: planned.legs.map((l) => ({
        wallet: l.address,
        budgetLamports: l.budgetLamports.toString(),
        solIntoCurve: l.solIntoCurve.toString(),
        expectedTokens: l.expectedTokens.toString(),
        requestTokens: l.requestTokens.toString(),
        maxSolCost: l.maxSolCost.toString(),
      })),
    });

    // If the background refresh has fallen behind, try once more here rather
    // than signing something that cannot land. This costs a round trip only in
    // the case that would otherwise waste the whole launch.
    if (Date.now() - this.blockhashAt > MAX_BLOCKHASH_AGE_MS) {
      this.emit('warn', { at: 'blockhash', refreshingInFirePath: true, ageMs: Date.now() - this.blockhashAt });
      await this.#refreshBlockhash().catch(() => {});
    }

    const { tokenProgram, cached } = await this.#resolveTokenProgram(mint);
    const built = this.buildTransaction({ mint, curve, planned, tokenProgram, lookupTable: this.lookupTable });

    if (this.paper) {
      this.emit('paper', {
        mint: key, slot: context?.slot ?? null,
        bytes: built.size, signers: built.signers, computeUnits: built.units,
        tokenProgram: tokenProgram.toBase58(), tokenProgramCached: cached,
        elapsedMs: Date.now() - seenAt,
      });
      return;
    }

    // skipPreflight: preflight is a simulation round trip in the hot path, and
    // this transaction has already been checked — the ladder cannot over-ask,
    // the size is verified at build, the balances were re-read at arm.
    // maxRetries 0: we would rather know it failed than have the RPC quietly
    // retry against a blockhash that is expiring.
    const signature = await this.connection.sendRawTransaction(built.transaction, {
      skipPreflight: true, maxRetries: 0, preflightCommitment: 'processed',
    });

    this.emit('sent', {
      mint: key, slot: context?.slot ?? null, signature,
      bytes: built.size, signers: built.signers,
      blockhashAgeMs: Date.now() - this.blockhashAt,
      elapsedMs: Date.now() - seenAt,
      rehearsal: this.rehearse,
    });

    // Sent is not landed. Reporting only the submission is what made three
    // failed attempts look like three successes.
    const { blockhash, lastValidBlockHeight } = this.blockhash;
    this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
      .then((res) => this.emit('settled', {
        mint: key, signature,
        landed: !res.value.err,
        error: res.value.err ? JSON.stringify(res.value.err) : null,
      }))
      // A confirmation timeout is a failure to OBSERVE, not a failure to land.
      // Reporting it as failure would have the operator resend something that
      // already executed.
      .catch((err) => this.emit('settled', {
        mint: key, signature, landed: null, error: `unconfirmed: ${err?.message ?? err}`,
      }));

    return { signature };
  }

  /**
   * Point the sniper at a contract address, replacing whatever it was watching.
   *
   * Unsubscribes first: leaving the old subscription up would keep a stale
   * launch armed against the same five budgets, and whichever fired first would
   * spend money the other one was still counting on.
   *
   * A Solana address carries NO CHECKSUM — any 32 bytes is syntactically valid —
   * so a typo that still decodes is indistinguishable from the real thing. This
   * cannot be validated away. What saves us is that a wrong address derives a
   * bonding curve that no launch will ever write, so the bot simply waits
   * forever instead of buying the wrong token. The failure mode of a typo here
   * is a miss, not a loss.
   */
  async setTarget(mintString) {
    let mint;
    try {
      mint = new PublicKey(mintString);
    } catch {
      throw new Error(`not a valid contract address: ${mintString}`);
    }
    // A mint must be a real 32-byte key, not something off the ed25519 curve
    // check — PublicKey accepts any 32 bytes, so this only catches length.
    const wasArmed = this.armed;
    if (this.subscriptions.size > 0) await this.unwatch();
    this.mints = [mint];
    // A new target has not been bought yet, whatever the old one's state was.
    this.fired.delete(mint.toBase58());
    // The old table holds the old mint's accounts and is useless for this one.
    this.lookupTable = null;
    this.lookupTableAddress = null;
    this.emit('target', { mint: mint.toBase58(), bondingCurve: deriveBondingCurve(mint).toBase58(), wasArmed });
    return mint;
  }

  /**
   * Switch between paper and live.
   *
   * Refused while armed. Flipping mode under a live subscription means the very
   * next write to that curve is handled under rules the operator set for a
   * different one — and in the paper->live direction that is a real bundle sent
   * by someone who was still rehearsing. Disarm, switch, re-arm.
   */
  setMode(mode) {
    if (mode !== 'paper' && mode !== 'live') throw new Error(`unknown mode: ${mode}`);
    if (this.armed) throw new Error('disarm before changing mode — switching while armed would change the rules mid-launch');
    this.paper = mode === 'paper';
    this.emit('mode', { mode });
    return this.paper;
  }

  get mode() {
    return this.paper ? 'paper' : 'live';
  }

  /** The currently targeted mint, or null. */
  get target() {
    return this.mints.length ? this.mints[0].toBase58() : null;
  }

  /**
   * Build the address lookup table for the current target.
   *
   * Kept out of setTarget because it costs several seconds and a little rent,
   * and out of the fire path because it CANNOT live there: a table's entries are
   * only usable in a slot later than the one that added them. That timing is the
   * reason the contract address has to be known in advance, and why /target and
   * /arm are separate steps rather than one.
   */
  async prepareLookupTable({ log = () => {} } = {}) {
    if (!this.global) throw new Error('sniper: prime() has not run');
    if (this.mints.length === 0) throw new Error('sniper: no target set');
    const mint = this.mints[0];

    const addresses = lookupAddressesFor({
      mint,
      wallets: this.wallets,
      feeRecipients: this.global.feeRecipients,
      buybackRecipients: this.buybackRecipients,
    });
    this.emit('lookupTable', { stage: 'building', mint: mint.toBase58(), addresses: addresses.length });

    const address = await createLookupTable({
      connection: this.connection,
      payer: this.wallets[0].keypair,
      addresses,
      log,
    });

    const res = await this.connection.getAddressLookupTable(address, { commitment: 'confirmed' });
    if (!res?.value) throw new Error(`sniper: lookup table ${address.toBase58()} is not readable after creation`);
    this.lookupTable = res.value;
    this.lookupTableAddress = address;
    this.emit('lookupTable', {
      stage: 'ready', mint: mint.toBase58(),
      address: address.toBase58(), addresses: res.value.state.addresses.length,
    });
    return address;
  }
}
