// The sniper: arm on a mint that has not launched, fire the moment its pool exists.
//
// THE RACE, AND WHY IT IS SHAPED THIS WAY. A DBC launch is tradeable the instant
// the VirtualPool account is written. Everything that happens after that instant
// and before our bytes reach a leader is lost ground, so the design pushes every
// cost to BEFORE the launch:
//
//   - where the config is known, the pool address is a PDA of it, so it and both
//     vaults and every token account are known while the pool is still nothing
//   - the quote token accounts are funded in advance, so no wrapping at fire time
//   - the transactions are compiled and SIGNED in advance, re-signed only when
//     the blockhash rolls
//
// What is left at fire time is a socket write. That is the point.
//
// SEVERAL BUYERS, ONE LAUNCH. A snipe may be split across wallets. They share one
// subscription — the trigger is a property of the mint, not of who is buying —
// and they share the pool facts derived from it, so five wallets cost four PDA
// derivations rather than twenty. What is per-wallet is small and known early:
// two token accounts, an amount, a signature.
//
// Each wallet succeeds or fails ON ITS OWN. Three filling and two missing is a
// normal outcome, not an error, and reporting it as one total would hide which
// wallets actually hold the token.
//
// TWO TRIGGERS, because they fail differently:
//   accountSubscribe on the derived pool  — cheapest and most widely supported,
//     but it needs the config, so it only exists on the pre-armed path
//   programSubscribe with a memcmp on base_mint — needs nothing known in advance
//     and carries the pool's data in the notification, so the config, both vaults
//     and the creator arrive WITH the trigger rather than costing a round trip
//     after it. Some providers disable programSubscribe or refuse `processed`.
// Whichever speaks first wins; the other is ignored for that launch.

import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  DBC_PROGRAM_ID, VIRTUAL_POOL, TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
  planSnipe, decodePoolConfig, deriveAta, tokenProgramFor,
} from './dbc.mjs';
import {
  verifyPool, snipeInstructions, signSnipe, poolFacts, planForBuyer, REFUSE,
} from './snipe.mjs';
import {
  getAccount, getTokenBalance, getBalance, sendRawTransaction, getSignatureStatuses, BlockhashCache,
} from './rpc.mjs';

export const STATE = Object.freeze({
  IDLE: 'idle',
  ARMED: 'armed',
  FIRING: 'firing',
  SETTLED: 'settled',
});

export const BUYER_STATE = Object.freeze({
  WAITING: 'waiting',
  FIRING: 'firing',
  FILLED: 'filled',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
});

/** Rent for a token account, rounded up. What the snipe pays to open its output. */
const ATA_RENT_LAMPORTS = 2_100_000n;
const BASE_FEE_LAMPORTS = 5_000n;

export class DbcSniper extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.wsUrl
   * @param {string} o.httpUrl
   * @param {string[]} [o.sendUrls]   endpoints to fire at; defaults to [httpUrl]
   * @param {PublicKey} o.mint        the token, known in advance
   * @param {PublicKey} o.quoteMint   what we pay in
   * @param {PublicKey} [o.config]    the DBC config; supply it for a pre-signed snipe
   * @param {Array<{keypair: Keypair, amountIn: bigint, minimumAmountOut: bigint, label?: string}>} o.buyers
   * @param {boolean} [o.dryRun]      do everything except put bytes on the wire
   */
  constructor({
    wsUrl, httpUrl, sendUrls, mint, quoteMint, config = null,
    buyers,
    // Single-buyer shorthand, so the common case does not have to build a list.
    keypair, amountIn, minimumAmountOut,
    baseTokenProgram = null,
    computeUnitLimit = 250_000, computeUnitPriceMicroLamports = 1_000_000,
    resendMs = 400, fireWindowMs = 30_000, confirmPollMs = 1000,
    dryRun = false,
    wsFactory = (url) => new WebSocket(url),
    // A seam, like wsFactory: partial outcomes across wallets are the part most
    // worth testing and the hardest to stage live.
    statusFetcher = null,
  }) {
    super();

    const list = buyers?.length
      ? buyers
      : (keypair ? [{ keypair, amountIn, minimumAmountOut }] : []);
    if (!list.length) throw new Error('DbcSniper: no buyers — pass buyers[], or keypair + amountIn');

    this.buyers = list.map((b, i) => {
      if (!b.keypair) throw new Error(`buyer ${i}: no keypair`);
      if (typeof b.amountIn !== 'bigint' || b.amountIn <= 0n) throw new Error(`buyer ${i}: amountIn must be a positive bigint`);
      if (typeof b.minimumAmountOut !== 'bigint' || b.minimumAmountOut < 0n) throw new Error(`buyer ${i}: minimumAmountOut must be a non-negative bigint`);
      return {
        index: i,
        label: b.label ?? `w${i + 1}`,
        keypair: b.keypair,
        address: b.keypair.publicKey,
        amountIn: b.amountIn,
        minimumAmountOut: b.minimumAmountOut,
        plan: null,
        presigned: null,
        signature: null,
        quoteAta: null,
        state: BUYER_STATE.WAITING,
      };
    });

    // The same wallet twice would sign two transactions spending the same
    // wrapped balance; the second fails on chain having paid a fee.
    const seen = new Set();
    for (const b of this.buyers) {
      const k = b.address.toBase58();
      if (seen.has(k)) throw new Error(`DbcSniper: wallet ${k} appears more than once`);
      seen.add(k);
    }

    this.wsUrl = wsUrl;
    this.httpUrl = httpUrl;
    this.sendUrls = sendUrls?.length ? sendUrls : [httpUrl];
    this.mint = mint;
    this.quoteMint = quoteMint;
    this.config = config;
    this.computeUnitLimit = computeUnitLimit;
    this.computeUnitPriceMicroLamports = computeUnitPriceMicroLamports;
    this.resendMs = resendMs;
    this.fireWindowMs = fireWindowMs;
    this.confirmPollMs = confirmPollMs;
    this.dryRun = dryRun;
    this.wsFactory = wsFactory;
    this.statusFetcher = statusFetcher ?? ((sigs) => getSignatureStatuses(this.httpUrl, sigs));

    this.state = STATE.IDLE;
    this.quoteTokenProgram = null;
    this.baseTokenProgram = baseTokenProgram;
    this.blockhashes = new BlockhashCache(httpUrl, { onError: (e) => this.emit('warn', { at: 'blockhash', message: e.message }) });

    this.ws = null;
    this.stopped = false;
    this.nextId = 1;
    this.subs = new Map();
    this.fired = false;
    this.attempt = 0;

    this.stats = { sends: 0, sendErrors: 0, reconnects: 0, triggers: 0, resigns: 0 };
    this.timeline = {};
  }

  /** The priority fee this budget costs if every unit is consumed. */
  get priorityFeeLamports() {
    return BigInt(this.computeUnitLimit) * BigInt(this.computeUnitPriceMicroLamports) / 1_000_000n;
  }

  /** What one wallet needs in plain SOL, beyond its wrapped balance. */
  get perWalletLamportsNeeded() {
    return this.priorityFeeLamports + BASE_FEE_LAMPORTS + ATA_RENT_LAMPORTS;
  }

  #mark(name) { this.timeline[name] = Date.now(); this.emit('mark', { name, at: this.timeline[name] }); }

  /**
   * Resolve everything that can be resolved before the launch, and refuse to arm
   * if anything needed at fire time is missing — for EVERY wallet.
   *
   * One underfunded wallet is not a reason to abandon the launch, but it is a
   * reason to say so now rather than discover it mid-race. Arming refuses only
   * when no wallet is usable; the rest are reported and dropped, because a snipe
   * with four of five wallets is still a snipe and silently firing a fifth that
   * cannot pay is not.
   */
  async arm() {
    await this.blockhashes.start();
    if (!this.blockhashes.blockhash) throw new Error('arm: could not fetch a blockhash — check httpUrl');

    // The quote mint exists now, so its token program is knowable now. Reading it
    // from the mint's owner is the fact itself, not an inference from a config.
    const quoteMintAccount = await getAccount(this.httpUrl, this.quoteMint.toBase58(), { commitment: 'confirmed' });
    if (!quoteMintAccount) throw new Error(`arm: quote mint ${this.quoteMint.toBase58()} does not exist`);
    this.quoteTokenProgram = new PublicKey(quoteMintAccount.owner);
    if (![TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58()].includes(this.quoteTokenProgram.toBase58())) {
      throw new Error(`arm: quote mint is owned by ${this.quoteTokenProgram.toBase58()}, which is not a token program`);
    }

    // The config, if we have one, decides the base token program and must agree
    // with the currency every wallet funded.
    let poolConfig = null;
    if (this.config) {
      const cfgAccount = await getAccount(this.httpUrl, this.config.toBase58(), { commitment: 'confirmed' });
      if (!cfgAccount) throw new Error(`arm: config ${this.config.toBase58()} does not exist`);
      if (cfgAccount.owner !== DBC_PROGRAM_ID.toBase58()) {
        throw new Error(`arm: config ${this.config.toBase58()} is owned by ${cfgAccount.owner}, not the DBC program`);
      }
      poolConfig = decodePoolConfig(cfgAccount.data);
      if (poolConfig.quoteMint.toBase58() !== this.quoteMint.toBase58()) {
        throw new Error(`arm: config quotes ${poolConfig.quoteMint.toBase58()} but we funded ${this.quoteMint.toBase58()}`);
      }
      this.baseTokenProgram = tokenProgramFor(poolConfig.tokenType);
    }

    const needed = this.perWalletLamportsNeeded;
    const usable = [];

    for (const b of this.buyers) {
      const quoteAta = deriveAta(b.address, this.quoteMint, this.quoteTokenProgram);
      b.quoteAta = quoteAta;

      const [wrapped, lamports] = await Promise.all([
        getTokenBalance(this.httpUrl, quoteAta.toBase58(), { commitment: 'confirmed' }),
        getBalance(this.httpUrl, b.address.toBase58(), { commitment: 'confirmed' }),
      ]);

      const problems = [];
      if (wrapped === null) problems.push(`quote token account ${quoteAta.toBase58()} does not exist — run prepare`);
      else if (wrapped < b.amountIn) problems.push(`quote account holds ${wrapped}, needs ${b.amountIn}`);
      if (lamports < needed) problems.push(`holds ${lamports} lamports of native SOL, needs ${needed} (${ATA_RENT_LAMPORTS} rent + ${this.priorityFeeLamports} priority + ${BASE_FEE_LAMPORTS} base fee)`);

      if (problems.length) {
        b.state = BUYER_STATE.ABANDONED;
        this.emit('wallet-unusable', {
          label: b.label, address: b.address.toBase58(), problems,
        });
        continue;
      }

      this.emit('wallet-ready', {
        label: b.label,
        address: b.address.toBase58(),
        amountIn: b.amountIn.toString(),
        quoteAta: quoteAta.toBase58(),
        wrapped: wrapped.toString(),
        nativeLamports: lamports.toString(),
        headroom: (lamports - needed).toString(),
      });

      if (this.config && poolConfig) {
        b.plan = planSnipe({
          config: this.config, baseMint: this.mint, quoteMint: this.quoteMint, buyer: b.address,
          baseTokenType: poolConfig.tokenType, quoteTokenType: poolConfig.quoteTokenFlag,
        });
      }
      usable.push(b);
    }

    if (!usable.length) {
      throw new Error('arm: no wallet is usable — every one is short of wrapped quote, native SOL, or both');
    }

    if (this.config) {
      const existing = await getAccount(this.httpUrl, usable[0].plan.pool.toBase58(), { commitment: 'confirmed' });
      if (existing) {
        this.emit('warn', { at: 'arm', message: `pool ${usable[0].plan.pool.toBase58()} ALREADY EXISTS — this launch has happened` });
      }
      this.#resignAll();
      this.blockhashes.onRefresh = () => { if (!this.fired) this.#resignAll(); };
      this.emit('armed', {
        mode: 'pre-signed',
        wallets: usable.length,
        skipped: this.buyers.length - usable.length,
        pool: usable[0].plan.pool.toBase58(),
        totalAmountIn: usable.reduce((s, b) => s + b.amountIn, 0n).toString(),
      });
    } else {
      this.emit('armed', {
        mode: 'discovery',
        wallets: usable.length,
        skipped: this.buyers.length - usable.length,
        note: 'no config supplied: the pool address is unknowable in advance, so transactions are built at fire time',
        baseTokenProgram: this.baseTokenProgram?.toBase58() ?? null,
        roundTripsAtFire: this.baseTokenProgram ? 0 : 1,
        totalAmountIn: usable.reduce((s, b) => s + b.amountIn, 0n).toString(),
        advice: this.baseTokenProgram
          ? 'nothing is fetched at fire time'
          : 'set snipe.baseTokenProgram to remove the one remaining fetch from the race',
      });
    }

    this.state = STATE.ARMED;
    this.#mark('armed');

    // Warm the paths that will run at fire time. They are JIT-cold otherwise, and
    // the first live fill measured 48ms to build and sign one transaction — work
    // that takes a few milliseconds once the code is hot. This costs nothing now
    // and is the cheapest latency available.
    this.#warm();

    return this.state;
  }

  /**
   * Run one throwaway derivation and signature so the hot path is compiled.
   *
   * Uses a plan that cannot be confused with a real one: the buyer's own key as a
   * stand-in config, and the result discarded. Nothing is sent.
   */
  #warm() {
    try {
      const b = this.buyers.find((x) => x.state !== BUYER_STATE.ABANDONED);
      if (!b || !this.blockhashes.blockhash) return;
      const started = Date.now();
      const throwaway = planSnipe({
        config: b.address, baseMint: this.mint, quoteMint: this.quoteMint, buyer: b.address,
        baseTokenType: 0, quoteTokenType: 0,
      });
      signSnipe({
        instructions: snipeInstructions({
          plan: throwaway, amountIn: 1n, minimumAmountOut: 0n,
          computeUnitLimit: this.computeUnitLimit,
          computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
        }),
        payer: b.address, blockhash: this.blockhashes.blockhash, keypair: b.keypair,
      });
      this.emit('info', { at: 'warm', message: 'hot path compiled', ms: Date.now() - started });
    } catch (e) {
      // Warming is an optimisation. Failing it must not stop an armed sniper.
      this.emit('warn', { at: 'warm', message: e.message });
    }
  }

  #resignAll() {
    for (const b of this.buyers) {
      if (!b.plan || b.state === BUYER_STATE.ABANDONED) continue;
      b.presigned = signSnipe({
        instructions: snipeInstructions({
          plan: b.plan, amountIn: b.amountIn, minimumAmountOut: b.minimumAmountOut,
          computeUnitLimit: this.computeUnitLimit,
          computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
        }),
        payer: b.address, blockhash: this.blockhashes.blockhash, keypair: b.keypair,
      });
      b.signature = b.presigned.signature;
    }
    this.stats.resigns++;
  }

  start() {
    if (this.state !== STATE.ARMED) throw new Error('start: arm() first');
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.blockhashes.stop();
    clearInterval(this.resendTimer);
    clearInterval(this.confirmTimer);
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }

  #connect() {
    if (this.stopped) return;
    const ws = this.wsFactory(this.wsUrl);
    this.ws = ws;
    this.subs.clear();

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.#send({
        method: 'programSubscribe',
        params: [
          DBC_PROGRAM_ID.toBase58(),
          {
            encoding: 'base64',
            commitment: 'processed',
            filters: [
              { dataSize: VIRTUAL_POOL.SIZE },
              { memcmp: { offset: VIRTUAL_POOL.BASE_MINT, bytes: this.mint.toBase58() } },
            ],
          },
        ],
      }, 'program');

      const armedPlan = this.buyers.find((b) => b.plan)?.plan;
      if (armedPlan) {
        this.#send({
          method: 'accountSubscribe',
          params: [armedPlan.pool.toBase58(), { encoding: 'base64', commitment: 'processed' }],
        }, 'account');
      }

      this.emit('open', { triggers: armedPlan ? ['programSubscribe', 'accountSubscribe'] : ['programSubscribe'] });
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('error', (e) => this.emit('warn', { at: 'socket', message: e?.message ?? String(e) }));
    ws.addEventListener('close', (ev) => {
      if (this.stopped) return;
      this.stats.reconnects++;
      this.emit('closed', { code: ev.code });
      const ceiling = Math.min(2000, 100 * 2 ** this.attempt++);
      setTimeout(() => this.#connect(), Math.random() * ceiling);
    });
  }

  #send(msg, tag) {
    const id = this.nextId++;
    this.subs.set(id, tag);
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...msg }));
  }

  #onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.id !== undefined && typeof msg.result === 'number') {
      this.emit('subscribed', { via: this.subs.get(msg.id), subscription: msg.result });
      return;
    }
    if (msg.id !== undefined && msg.error) {
      this.emit('warn', { at: 'subscribe', message: msg.error?.message ?? 'subscribe rejected', via: this.subs.get(msg.id) });
      return;
    }

    const method = msg.method;
    if (method !== 'programNotification' && method !== 'accountNotification') return;

    const seenAt = Date.now();
    const value = msg.params?.result?.value;
    const slot = msg.params?.result?.context?.slot ?? null;
    if (!value) return;

    const armedPlan = this.buyers.find((b) => b.plan)?.plan;
    const poolAddress = method === 'programNotification' ? value.pubkey : armedPlan?.pool.toBase58();
    const encoded = method === 'programNotification' ? value.account?.data : value.data;
    if (!poolAddress || !encoded) return;
    const data = Buffer.from(encoded[0], 'base64');

    this.stats.triggers++;
    this.emit('trigger', { via: method, pool: poolAddress, slot, seenAt, bytes: data.length });

    if (this.fired) return;
    this.fired = true;
    this.#mark('trigger');
    this.#fire({ poolAddress, data, slot }).catch((e) => {
      this.state = STATE.SETTLED;
      this.emit('error', { at: 'fire', message: e.message });
    });
  }

  async #fire({ poolAddress, data, slot }) {
    this.state = STATE.FIRING;
    const live = this.buyers.filter((b) => b.state !== BUYER_STATE.ABANDONED);

    // Was the pool the one we armed against? Checked once — every wallet armed
    // against the same config, so they agree or they all disagree.
    const armed = live.find((b) => b.plan);
    let replan = !armed;

    if (armed) {
      const check = verifyPool({ poolAddress, data, plan: armed.plan });
      if (!check.ok && (check.reason === REFUSE.POOL_MISMATCH || check.reason === REFUSE.CONFIG_MISMATCH)) {
        // The launchpad minted a config we could not have known. The mint still
        // matched — verifyPool checks that first — so this is the right token at
        // an address we did not predict. Rebuild rather than refuse.
        this.emit('replanned', {
          why: check.reason,
          armedPool: armed.plan.pool.toBase58(),
          actualPool: poolAddress,
          note: 'the config was not the one this launch used — rebuilding from the live pool',
        });
        replan = true;
      } else if (!check.ok) {
        this.state = STATE.SETTLED;
        for (const b of live) b.state = BUYER_STATE.ABANDONED;
        this.emit('refused', { reason: check.reason, detail: check.detail });
        return;
      } else if (this.blockhashes.ageMs > 45_000) {
        this.emit('warn', { at: 'fire', message: `blockhash is ${this.blockhashes.ageMs}ms old, re-signing` });
        this.#resignAll();
      }
    }

    if (replan) {
      if (!this.baseTokenProgram) {
        this.emit('warn', {
          at: 'fire',
          message: 'base token program unknown — fetching it now, which costs a round trip mid-race; set snipe.baseTokenProgram to avoid this',
        });
        const baseMintAccount = await getAccount(this.httpUrl, this.mint.toBase58(), { commitment: 'processed' });
        if (!baseMintAccount) throw new Error(`fire: base mint ${this.mint.toBase58()} not readable`);
        this.baseTokenProgram = new PublicKey(baseMintAccount.owner);
      }

      // Derived ONCE and shared: the pool, its config and both vaults are the
      // same for every wallet buying this launch.
      const facts = poolFacts({ poolAddress, poolData: data, quoteMint: this.quoteMint });
      for (const b of live) {
        b.plan = planForBuyer({
          facts, buyer: b.address,
          tokenBaseProgram: this.baseTokenProgram,
          tokenQuoteProgram: this.quoteTokenProgram,
          deriveAta,
        });
        b.presigned = signSnipe({
          instructions: snipeInstructions({
            plan: b.plan, amountIn: b.amountIn, minimumAmountOut: b.minimumAmountOut,
            computeUnitLimit: this.computeUnitLimit,
            computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
          }),
          payer: b.address, blockhash: this.blockhashes.blockhash, keypair: b.keypair,
        });
        b.signature = b.presigned.signature;
      }
    }

    this.#mark('built');
    for (const b of live) b.state = BUYER_STATE.FIRING;

    this.emit('firing', {
      wallets: live.length,
      pool: poolAddress,
      slot,
      totalAmountIn: live.reduce((s, b) => s + b.amountIn, 0n).toString(),
      triggerToBuildMs: this.timeline.built - this.timeline.trigger,
      dryRun: this.dryRun,
      signatures: live.map((b) => ({ label: b.label, signature: b.signature, amountIn: b.amountIn.toString() })),
    });

    if (this.dryRun) {
      this.state = STATE.SETTLED;
      for (const b of live) b.state = BUYER_STATE.ABANDONED;
      this.emit('dry-run', { wallets: live.length, note: 'nothing was sent' });
      return;
    }

    this.#blastAll(live);
    this.#mark('sent');

    this.resendTimer = setInterval(() => {
      const pending = this.buyers.filter((b) => b.state === BUYER_STATE.FIRING);
      if (!pending.length) { clearInterval(this.resendTimer); return; }
      this.#blastAll(pending);
    }, this.resendMs);

    this.confirmTimer = setInterval(() => this.#checkFills(), this.confirmPollMs);

    setTimeout(() => {
      const pending = this.buyers.filter((b) => b.state === BUYER_STATE.FIRING);
      if (pending.length) {
        for (const b of pending) b.state = BUYER_STATE.ABANDONED;
        this.emit('abandoned', {
          wallets: pending.map((b) => ({ label: b.label, signature: b.signature })),
          afterMs: this.fireWindowMs,
        });
      }
      this.#settleIfDone();
    }, this.fireWindowMs).unref?.();
  }

  #blastAll(buyers) {
    for (const b of buyers) {
      for (const url of this.sendUrls) {
        sendRawTransaction(url, b.presigned.base64)
          .then(({ signature, error }) => {
            this.stats.sends++;
            if (error) { this.stats.sendErrors++; this.emit('send-error', { label: b.label, url, message: error }); }
            else this.emit('sent', { label: b.label, url, signature });
          })
          .catch((e) => { this.stats.sendErrors++; this.emit('send-error', { label: b.label, url, message: e.message }); });
      }
    }
  }

  async #checkFills() {
    const pending = this.buyers.filter((b) => b.state === BUYER_STATE.FIRING);
    if (!pending.length) { this.#settleIfDone(); return; }
    try {
      const statuses = await this.statusFetcher(pending.map((b) => b.signature));
      statuses.forEach((status, i) => {
        if (!status) return;
        const b = pending[i];
        if (status.err) {
          b.state = BUYER_STATE.FAILED;
          this.emit('wallet-failed', { label: b.label, address: b.address.toBase58(), signature: b.signature, err: status.err, slot: status.slot });
          return;
        }
        b.state = BUYER_STATE.FILLED;
        b.filledSlot = status.slot;
        this.emit('wallet-filled', {
          label: b.label,
          address: b.address.toBase58(),
          signature: b.signature,
          slot: status.slot,
          amountIn: b.amountIn.toString(),
          outputTokenAccount: b.plan?.outputTokenAccount.toBase58() ?? null,
          triggerToLandedMs: Date.now() - this.timeline.trigger,
        });
      });
      this.#settleIfDone();
    } catch (e) {
      this.emit('warn', { at: 'confirm', message: e.message });
    }
  }

  /** Report once, when no wallet is still in flight. */
  #settleIfDone() {
    if (this.state === STATE.SETTLED) return;
    if (this.buyers.some((b) => b.state === BUYER_STATE.FIRING)) return;

    clearInterval(this.resendTimer);
    clearInterval(this.confirmTimer);
    this.state = STATE.SETTLED;
    this.#mark('settled');

    const filled = this.buyers.filter((b) => b.state === BUYER_STATE.FILLED);
    const failed = this.buyers.filter((b) => b.state === BUYER_STATE.FAILED);
    const missed = this.buyers.filter((b) => b.state === BUYER_STATE.ABANDONED);

    this.emit('settled', {
      filled: filled.length,
      failed: failed.length,
      missed: missed.length,
      totalSpent: filled.reduce((s, b) => s + b.amountIn, 0n).toString(),
      wallets: this.buyers.map((b) => ({
        label: b.label,
        address: b.address.toBase58(),
        state: b.state,
        amountIn: b.amountIn.toString(),
        signature: b.signature,
        slot: b.filledSlot ?? null,
      })),
    });
  }
}

/** Parse a base58 address, failing loudly rather than watching an address nobody uses. */
export function parseAddress(label, value) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  let decoded;
  try { decoded = bs58.decode(value); } catch { throw new Error(`${label} is not valid base58: ${value}`); }
  if (decoded.length !== 32) throw new Error(`${label} decodes to ${decoded.length} bytes, not 32: ${value}`);
  return new PublicKey(value);
}
