// pump.fun launch sniper: five wallets, one atomic bundle, contract address
// known in advance.
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
// WHY THE BUNDLE GOES TO HELIUS SENDER AND NOT TO JITO DIRECTLY. Three bundles
// posted to Jito's public block engine were accepted by five relays, given an
// id, and silently discarded — Invalid, never Pending, nothing on chain. A probe
// reduced that to a 217-byte transaction carrying only a tip, which was dropped
// the same way, so nothing about what we send was ever the cause: unauthenticated
// submission is not honoured. Sender is authenticated infrastructure that takes
// the same bundle format and fans it across every fast path, Jito included, on
// any Helius plan and without consuming credits.
//
// Five transactions rather than one is deliberate. Solana caps a transaction's
// instruction trace at 64 invocations, and a pump.fun buy costs 8 while its
// token-account create costs 5 — measured. Five wallets in ONE transaction is
// 2 + 5x13 = 67 and fails with MaxInstructionTraceLengthExceeded. Split across
// five transactions each gets its own 64-invocation budget and uses 13.
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
import { MAX_BUNDLE_SIZE, MIN_TIP_LAMPORTS, SENDER_TIP_ACCOUNTS } from './sender.mjs';
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

/** Solana refuses any transaction over this, outright. */
export const MAX_TRANSACTION_BYTES = 1232;

/**
 * How many buys fit in ONE transaction.
 *
 * Byte-limited, not CPI-limited. Measured: one buy with its token-account create
 * is 787 bytes, two are 1002, three are 1217, and four are 1432 — past the
 * 1232-byte ceiling. Three is the most that fits.
 */
export const MAX_BUYS_PER_TRANSACTION = 3;

/**
 * Compute units requested per buy.
 *
 * Measured on mainnet: a buy plus its token-account create burns 88,000-99,000.
 * 130,000 leaves headroom without over-requesting, which is not free — the
 * priority fee is charged on the limit asked for, not the units burned.
 */
export const COMPUTE_UNITS_PER_BUY = 130_000;

/**
 * Spread the buys across as few transactions as the limits allow.
 *
 * Two ceilings meet here and neither is negotiable. Helius Sender refuses a
 * bundle of more than FOUR transactions — measured, it answers "bundle must
 * contain no more than 4 transactions" with HTTP 500 — and one transaction holds
 * at most three buys before it passes 1232 bytes. Five wallets therefore cannot
 * have one transaction each, which is what this assumed and what failed twice
 * while reporting success, because the refusal arrived in an error shape the
 * client was not reading.
 *
 * Order is preserved exactly: transactions execute in bundle order, buys execute
 * in order inside each one. So the ladder is priced as before — every leg
 * against the curve the leg before it leaves behind.
 */
export function packLegs(legs, { maxTransactions = MAX_BUNDLE_SIZE, maxPerTransaction = MAX_BUYS_PER_TRANSACTION } = {}) {
  if (!Array.isArray(legs) || legs.length === 0) throw new Error('packLegs: no legs');
  const perTransaction = Math.ceil(legs.length / maxTransactions);
  if (perTransaction > maxPerTransaction) {
    throw new Error(
      `packLegs: ${legs.length} wallets need ${perTransaction} buys per transaction, but only ` +
      `${maxPerTransaction} fit in ${MAX_TRANSACTION_BYTES} bytes. The ceiling is ` +
      `${maxTransactions * maxPerTransaction} wallets.`,
    );
  }
  const groups = [];
  for (let i = 0; i < legs.length; i += perTransaction) groups.push(legs.slice(i, i + perTransaction));
  return groups;
}

export class PumpSniper extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('@solana/web3.js').Connection} opts.connection
   * @param {object}   opts.sender            HeliusSender
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
      connection, sender, wallets,
      slippageBps, tipLamports, mints = [], tipWalletIndex = wallets.length - 1,
      computeUnitLimit = 250_000, computeUnitPriceMicroLamports = 500_000,
      maxPreBuyLamports = 0n, paper = true, rehearse = false,
    } = opts;

    if (!connection) throw new Error('sniper: connection is required');
    if (!sender) throw new Error('sniper: sender client is required');
    if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('sniper: no wallets');
    const ceiling = MAX_BUNDLE_SIZE * MAX_BUYS_PER_TRANSACTION;
    if (wallets.length > ceiling) {
      throw new Error(
        `sniper: ${wallets.length} wallets exceeds ${ceiling} — Sender takes at most ${MAX_BUNDLE_SIZE} ` +
        `transactions and at most ${MAX_BUYS_PER_TRANSACTION} buys fit in each`,
      );
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
    this.sender = sender;
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
    /** `mint:reason` pairs already reported. A curve is written on EVERY trade,
     *  so an unfiltered refusal is one log line and one Telegram message per
     *  trade on the token for as long as it lives. The first refusal of a kind
     *  carries the information; the rest only repeat that the token is still
     *  trading, and they arrive fast enough to bury the settle report and to
     *  put the chat over its rate limit. Cleared on every arm and every new
     *  target, so each run reports afresh. */
    this.reported = new Set();
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

    // Helius Sender's tip accounts are fixed — there is no getTipAccounts on
    // that endpoint — so they are pinned in sender.mjs rather than fetched.
    // They are NOT Jito's list; a tip to the wrong list is money thrown away.
    this.tipAccounts = SENDER_TIP_ACCOUNTS;
    if (this.tipLamports < MIN_TIP_LAMPORTS) {
      throw new Error(
        `sniper: a tip of ${this.tipLamports} lamports is below Sender's ${MIN_TIP_LAMPORTS} minimum for the ` +
        'fast path. Below it the bundle is sent best-effort through fewer pathways and skips the priority ' +
        'buffer, which is the whole reason for using this endpoint on a launch.',
      );
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
  /**
   * Build the bundle: every wallet's buy, packed into at most four transactions.
   *
   * One transaction per wallet is what a Jito bundle allows and what this did
   * first. Helius Sender takes only four, so five wallets share them — see
   * packLegs. Execution order is unchanged, which is what keeps the ladder
   * correct.
   */
  buildBundle({ mint, curve, planned, tokenProgram }) {
    if (!this.blockhash) throw new Error('sniper: no blockhash in hand');
    const age = Date.now() - this.blockhashAt;
    if (age > MAX_BLOCKHASH_AGE_MS) {
      throw new Error(
        `sniper: the blockhash is ${Math.round(age / 1000)}s old and a transaction is only valid for about 60s. ` +
        'Signing it would produce something no leader can execute. The refresh must be failing — check the RPC.',
      );
    }
    if (!tokenProgram) throw new Error('sniper: token program for the mint is unknown');

    const feeRecipient = this.#pick(this.global.feeRecipients);
    const buybackRecipient = this.#pick(this.buybackRecipients);
    const groups = packLegs(planned.legs);

    const transactions = [];
    const signatures = [];
    const built = [];

    groups.forEach((group, groupIndex) => {
      const signers = group.map((leg) => this.wallets[leg.index].keypair);
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS_PER_BUY * group.length }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.computeUnitPriceMicroLamports }),
      ];

      for (const leg of group) {
        const buyer = this.wallets[leg.index].keypair.publicKey;
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

      // The tip rides in the LAST transaction. The bundle is atomic, so where it
      // sits does not change what is paid — only that it is present.
      if (groupIndex === groups.length - 1) {
        instructions.push(SystemProgram.transfer({
          fromPubkey: signers[signers.length - 1].publicKey,
          toPubkey: new PublicKey(this.#pick(this.tipAccounts)),
          lamports: Number(this.tipLamports),
        }));
      }

      const message = new TransactionMessage({
        payerKey: signers[0].publicKey,
        recentBlockhash: this.blockhash.blockhash,
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);

      if (this.paper) {
        built.push({
          wallets: group.map((l) => l.label),
          size: message.serialize().length + 1 + 64 * message.header.numRequiredSignatures,
          signers: message.header.numRequiredSignatures, signed: false,
        });
        return;
      }

      tx.sign(signers);
      const raw = tx.serialize();
      if (raw.length > MAX_TRANSACTION_BYTES) {
        throw new Error(`sniper: transaction ${groupIndex + 1} is ${raw.length} bytes, over the ${MAX_TRANSACTION_BYTES} limit`);
      }
      transactions.push(Buffer.from(raw).toString('base64'));
      // We signed it, so we know its signature. Sender answers with a hex bundle
      // id, which confirmTransaction rejects as not base58.
      signatures.push(bs58.encode(tx.signatures[0]));
      built.push({ wallets: group.map((l) => l.label), size: raw.length, signers: signers.length, signed: true });
    });

    return { transactions, signatures, built, feeRecipient, buybackRecipient, paper: this.paper };
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
    // Each arming is a fresh intent: whatever we refused last time, the
    // operator wants to hear the reason again rather than infer it from silence.
    this.reported.clear();
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

  /**
   * Stop watching one mint — our own bookkeeping first, the RPC in its own time.
   *
   * The map entries are dropped synchronously and the unsubscribe is left to
   * run unawaited, because this is called from the fire path: waiting on a
   * websocket round trip there would give back the lead the whole program
   * exists to take. Callers that need to know whether anything is still
   * watched can read `subscriptions.size` on the next line and be right.
   *
   * Writes already in flight when this runs are still delivered. That is what
   * the guards at the top of #onCurveWrite are for.
   */
  #stopWatchingMint(key) {
    for (const map of [this.subscriptions, this.mintSubscriptions]) {
      const subId = map.get(key);
      if (subId === undefined) continue;
      map.delete(key);
      Promise.resolve()
        .then(() => this.connection.removeAccountChangeListener(subId))
        .catch(() => { /* the socket may already be gone; there is nothing to undo */ });
    }
  }

  /**
   * This mint is finished with — bought, or gone somewhere we can never buy it.
   *
   * Dropping the subscription is the point: a curve we can no longer act on
   * still emits a write on every trade, and the only thing we could do with
   * one is refuse it. Disarming once the last mint is retired keeps /status
   * honest, so the operator is never shown ARMED over a sniper that is
   * watching nothing.
   */
  #retireMint(key, reason) {
    this.#stopWatchingMint(key);
    this.#disarmIfNothingWatched(key, reason);
  }

  /**
   * Drop the armed flag once the last subscription is gone.
   *
   * Kept apart from #stopWatchingMint because the fire path needs the two at
   * DIFFERENT times. Unsubscribing is safe the instant the budgets are claimed.
   * Disarming is not: `armed` is what refuses a mode change, and a /live
   * arriving between the claim and the send would otherwise turn a paper
   * rehearsal into a real bundle. So the flag holds until the fire is over.
   */
  #disarmIfNothingWatched(key, reason) {
    if (this.subscriptions.size > 0 || !this.armed) return;
    this.armed = false;
    this.emit('disarmed', { mint: key, reason });
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
      const seen = `${key}:${verdict.reason}`;
      if (!this.reported.has(seen)) {
        this.reported.add(seen);
        this.emit('skipped', { mint: key, slot: context?.slot ?? null, ...verdict, repeatsSuppressed: true });
      }
      // A graduated curve has moved to a DEX and will never be buyable here
      // again, so there is nothing left for the subscription to tell us.
      // 'pre-bought' is not terminal — people sell, and a curve that is over
      // the operator's limit now can come back under it — so that one keeps
      // watching, quietly.
      if (verdict.reason === 'graduated') this.#retireMint(key, 'graduated');
      return;
    }

    // Claim the mint before any await. Two writes in quick succession would
    // otherwise both pass assess() and fire two bundles for one launch.
    this.fired.add(key);

    // And stop listening to it, in the same synchronous step as the claim.
    // From here the budgets are committed, so no later write to this curve can
    // produce an action — but writes keep coming for as long as anyone trades
    // the token, and the only use left for them is to drown the settle report
    // that the operator is actually waiting for.
    //
    // Only the subscription goes now. Disarming waits for the finally below,
    // so the mode cannot change under a bundle that is still being built.
    this.#stopWatchingMint(key);

    try {
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

      const result = await this.sender.sendBundle(bundle.transactions);
      // The bundle is atomic, so confirming ANY of its transactions confirms all
      // of them. The first is as good as any and is the one we can name.
      const signature = bundle.signatures[0];
      this.emit('sent', {
        mint: key, slot: context?.slot ?? null,
        signature,
        bundleId: result.bundleId ?? null,
        signatures: bundle.signatures,
        blockhashAgeMs: Date.now() - this.blockhashAt,
        elapsedMs: Date.now() - seenAt,
        rehearsal: this.rehearse,
      });

      // Accepted is not landed, and reporting only the submission is what made
      // three failed attempts look like three successes. Sender answers with a
      // real transaction SIGNATURE rather than a bundle id, so this confirms
      // against the chain itself instead of asking an API that answered "Invalid"
      // for everything.
      const { blockhash, lastValidBlockHeight } = this.blockhash;
      this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight }, 'confirmed',
      ).then((res) => this.emit('settled', {
        mint: key, signature,
        landed: !res.value.err,
        error: res.value.err ? JSON.stringify(res.value.err) : null,
      })).catch((err) => this.emit('settled', {
        // Unconfirmed is a failure to OBSERVE, not a failure to land. Reporting it
        // as failure invites resending something that already executed.
        mint: key, signature, landed: null,
        error: `unconfirmed: ${err?.message ?? err}`,
      }));

      return result;
    } finally {
      // Every exit, including a throw out of the send: a sniper that has
      // spent its budgets and stopped watching must not still read ARMED.
      this.#disarmIfNothingWatched(key, 'fired');
    }
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
    // Unconditionally, not only when something is still subscribed: a mint that
    // has already fired has had its subscription dropped, and the old code
    // would then leave `armed` set over a sniper watching nothing.
    await this.unwatch();
    this.mints = [mint];
    // A new target has not been bought yet, whatever the old one's state was,
    // and none of the old target's refusals say anything about this one.
    this.fired.delete(mint.toBase58());
    this.reported.clear();
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
