// pump.fun launch sniper: five wallets, one bundle, contract addresses known
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
// build, sign, submit. No RPC call stands between the launch and the bundle.
//
// The curve state is still re-read from the notification and the plan re-run if
// it is not what we expected — being first is the plan, not an assumption.

import { EventEmitter } from 'node:events';
import {
  ComputeBudgetProgram, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  PUMP_PROGRAM, PUMP_GLOBAL, PUMP_FEE_PROGRAM,
  BUYBACK_DISCRIMINATOR, BUYBACK_ACCOUNT_SIZE,
  decodeGlobal, decodeBondingCurve, deriveBondingCurve,
  buildBuyInstruction, createAtaIdempotentInstruction, planLadder,
  tokenProgramForMintAccount,
} from './pump.mjs';
import { MAX_BUNDLE_SIZE } from './jito.mjs';
import bs58 from 'bs58';

/** Rent for a token account, in lamports. Held back from every wallet's budget. */
export const ATA_RENT_LAMPORTS = 2_039_280n;
/** Solana's per-signature fee. One signature per transaction here. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** Dust-rehearsal caps. Structurally identical bundle, negligible size. */
export const REHEARSAL_MAX_SOL_COST = 1_000_000n;   // 0.001 SOL
export const REHEARSAL_TIP_LAMPORTS = 1_000_000n;   // 0.001 SOL

/**
 * How old a blockhash may be when we sign with it.
 *
 * Solana accepts a transaction for 150 slots after its blockhash — roughly 60
 * seconds. Past that the cluster does not delay it, it REJECTS it, and a Jito
 * bundle built from such transactions comes back `Invalid` having never
 * executed. 30s leaves room for the bundle to reach a leader and still be
 * inside the window.
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
   * @param {object}   opts.jito              JitoClient
   * @param {object[]} opts.wallets           from loadSniperWallets, in bundle order
   * @param {string[]} opts.mints             target contract addresses
   * @param {bigint}   opts.slippageBps
   * @param {bigint}   opts.tipLamports
   * @param {number}   opts.tipWalletIndex    which wallet pays the Jito tip
   * @param {number}   opts.computeUnitLimit
   * @param {number}   opts.computeUnitPriceMicroLamports
   * @param {bigint}   opts.maxPreBuyLamports refuse if the curve already holds more than this
   * @param {boolean}  opts.paper             build and verify, sign nothing, send nothing
   */
  constructor(opts) {
    super();
    const {
      connection, jito, wallets,
      slippageBps, tipLamports, mints = [], tipWalletIndex = wallets.length - 1,
      computeUnitLimit = 250_000, computeUnitPriceMicroLamports = 500_000,
      maxPreBuyLamports = 0n, paper = true, rehearse = false,
    } = opts;

    if (!connection) throw new Error('sniper: connection is required');
    if (!jito) throw new Error('sniper: jito client is required');
    if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('sniper: no wallets');
    if (wallets.length > MAX_BUNDLE_SIZE) {
      throw new Error(`sniper: ${wallets.length} wallets exceeds the ${MAX_BUNDLE_SIZE}-transaction bundle limit`);
    }
    // Deliberately allowed to be empty. The contract address is usually not
    // known when the process starts — that is the entire reason the Telegram
    // control plane exists — so "no target yet" is a normal state to boot into,
    // not an error. watch() is where a missing target becomes a refusal.
    if (mints !== undefined && !Array.isArray(mints)) throw new Error('sniper: mints must be an array');
    if (tipWalletIndex < 0 || tipWalletIndex >= wallets.length) {
      throw new Error(`sniper: tipWalletIndex ${tipWalletIndex} is outside the wallet list`);
    }

    this.connection = connection;
    this.jito = jito;
    this.wallets = wallets;
    this.mints = mints.map((m) => new PublicKey(m));
    this.slippageBps = slippageBps;
    this.tipLamports = tipLamports;
    this.tipWalletIndex = tipWalletIndex;
    this.computeUnitLimit = computeUnitLimit;
    this.computeUnitPriceMicroLamports = computeUnitPriceMicroLamports;
    this.maxPreBuyLamports = maxPreBuyLamports;
    this.paper = paper;
    /**
     * Dust rehearsal. Fires the REAL path — same five transactions, same five
     * fee payers, same 18-account buy, same ATA create, same tip placement, same
     * single atomic bundle — but asks for one raw token unit instead of a real
     * size. pump.fun's buy takes the exact token amount out, so one unit costs
     * essentially nothing while remaining structurally identical.
     *
     * The point is to learn whether the bundle reaches the auction at all
     * without putting half a SOL behind the question.
     */
    this.rehearse = rehearse;

    this.global = null;
    this.buybackRecipients = [];
    this.tipAccounts = [];
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
    /** Mints already acted on. A curve account is written on every trade, not
     *  only at creation, so without this the second buy by anyone else would
     *  re-fire the bundle. */
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

    // Tip accounts come from the block engine rather than a constant: Jito
    // rotates them, and a tip paid to a retired account buys nothing.
    this.tipAccounts = await this.jito.getTipAccounts();
    if (!Array.isArray(this.tipAccounts) || this.tipAccounts.length === 0) {
      throw new Error('sniper: no Jito tip accounts available');
    }

    await this.#refreshBlockhash();
    this.emit('primed', {
      feeBasisPoints: this.global.feeBasisPoints.toString(),
      feeRecipients: this.global.feeRecipients.length,
      buybackRecipients: this.buybackRecipients.length,
      tipAccounts: this.tipAccounts.length,
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

  /** The legs, in bundle order, with each wallet's budget in lamports. */
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
   * A wallet short by a lamport fails its transaction, and one failed
   * transaction voids the whole bundle. Checking now turns that into a startup
   * error instead of a missed launch.
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
      // leg, and one failed leg voids the bundle for all five.
      let required = w.budgetLamports + ATA_RENT_LAMPORTS + SIGNATURE_FEE_LAMPORTS + this.priorityFeeLamports();
      if (i === this.tipWalletIndex) required += this.tipLamports;
      report.push({
        address: w.address, balance, required, sufficient: balance >= required,
        shortfall: balance >= required ? 0n : required - balance,
      });
    }
    return report;
  }

  /** What the compute budget instructions will actually cost, in lamports. */
  priorityFeeLamports() {
    return (BigInt(this.computeUnitLimit) * BigInt(this.computeUnitPriceMicroLamports)) / 1_000_000n;
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
  buildBundle({ mint, curve, planned, tokenProgram }) {
    if (!this.blockhash) throw new Error('sniper: no blockhash in hand');
    const age = Date.now() - this.blockhashAt;
    if (age > MAX_BLOCKHASH_AGE_MS) {
      throw new Error(
        `sniper: the blockhash is ${Math.round(age / 1000)}s old and a transaction is only valid for about 60s. ` +
        'Signing it would produce a bundle every relay accepts and no leader can execute. ' +
        'The refresh must be failing — check connectivity to the RPC.',
      );
    }
    if (!tokenProgram) throw new Error('sniper: token program for the mint is unknown');
    const feeRecipient = this.#pick(this.global.feeRecipients);
    const buybackRecipient = this.#pick(this.buybackRecipients);

    const transactions = [];
    const built = [];
    for (const leg of planned.legs) {
      const wallet = this.wallets[leg.index];
      const buyer = wallet.keypair.publicKey;

      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.computeUnitPriceMicroLamports }),
        createAtaIdempotentInstruction({ payer: buyer, owner: buyer, mint, tokenProgram }),
        buildBuyInstruction({
          mint,
          buyer,
          creator: curve.creator,
          // One raw token unit, capped at 0.001 SOL. Everything else about the
          // transaction is untouched, so what is tested is the submission path.
          amountTokens: this.rehearse ? 1n : leg.requestTokens,
          maxSolCost: this.rehearse ? REHEARSAL_MAX_SOL_COST : leg.maxSolCost,
          feeRecipient,
          buybackRecipient,
          tokenProgram,
        }),
      ];

      // The tip rides inside one of the five rather than as a sixth
      // transaction: the bundle limit is five, and five wallets fills it.
      if (leg.index === this.tipWalletIndex) {
        instructions.push(SystemProgram.transfer({
          fromPubkey: buyer,
          toPubkey: new PublicKey(this.#pick(this.tipAccounts)),
          lamports: Number(this.rehearse ? REHEARSAL_TIP_LAMPORTS : this.tipLamports),
        }));
      }

      const message = new TransactionMessage({
        payerKey: buyer,
        recentBlockhash: this.blockhash.blockhash,
        instructions,
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);
      // Serialising an unsigned v0 transaction still exercises message
      // compilation, the account table and the size limit — everything that can
      // reject a bundle before it is sent. Paper mode stops at the signature and
      // returns no transaction, so there is nothing a later bug could submit.
      if (this.paper) {
        built.push({ leg, size: message.serialize().length, signed: false });
        continue;
      }
      tx.sign([wallet.keypair]);
      const serialized = Buffer.from(tx.serialize()).toString('base64');
      transactions.push(serialized);
      built.push({ leg, size: serialized.length, signed: true });
    }
    return { transactions, built, feeRecipient, buybackRecipient, paper: this.paper };
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
    const bundle = this.buildBundle({ mint, curve, planned, tokenProgram });

    if (this.paper) {
      this.emit('paper', {
        mint: key, slot: context?.slot ?? null,
        transactions: bundle.built.length,
        sizes: bundle.built.map((b) => b.size),
        tokenProgram: tokenProgram.toBase58(),
        tokenProgramCached: cached,
        elapsedMs: Date.now() - seenAt,
      });
      return;
    }

    const result = await this.jito.sendBundle(bundle.transactions);
    this.emit('sent', {
      mint: key, slot: context?.slot ?? null,
      bundleId: result.bundleId, acceptedBy: result.acceptedBy,
      blockhashAgeMs: Date.now() - this.blockhashAt,
      elapsedMs: Date.now() - seenAt,
      rehearsal: this.rehearse,
    });

    // Accepted is not landed. Until this existed, the bot reported a bundle id
    // and stopped, and every failure looked exactly like a success. Polling is
    // what distinguishes a bundle dropped before the auction from one that was
    // forwarded and lost — and that distinction is the whole diagnosis.
    this.jito.pollBundle(result.bundleId)
      .then((settled) => this.emit('settled', { mint: key, bundleId: result.bundleId, ...settled }))
      .catch((err) => this.emit('warn', { at: 'pollBundle', error: err?.message ?? String(err) }));

    return result;
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
}
