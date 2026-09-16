// The sniper: arm on a mint that has not launched, fire the moment its pool exists.
//
// THE RACE, AND WHY IT IS SHAPED THIS WAY. A DBC launch is tradeable the instant
// the VirtualPool account is written. Everything that happens after that instant
// and before our bytes reach a leader is lost ground, so the design pushes every
// cost to BEFORE the launch:
//
//   - the pool address is a PDA of (config, base mint, quote mint), so it is
//     known while the pool is still nothing
//   - the vaults and both token accounts are PDAs of that
//   - the quote token account is funded in advance, so no wrapping at fire time
//   - the transaction is compiled and SIGNED in advance, re-signed only when the
//     blockhash rolls
//
// What is left at fire time is a socket write. That is the point.
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
import { verifyPool, snipeInstructions, signSnipe, planFromLivePool, REFUSE } from './snipe.mjs';
import { getAccount, getTokenBalance, sendRawTransaction, getSignatureStatuses, BlockhashCache } from './rpc.mjs';

export const STATE = Object.freeze({
  IDLE: 'idle',
  ARMED: 'armed',
  FIRING: 'firing',
  FILLED: 'filled',
  ABANDONED: 'abandoned',
});

export class DbcSniper extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.wsUrl
   * @param {string} o.httpUrl
   * @param {string[]} [o.sendUrls]   endpoints to fire at; defaults to [httpUrl]
   * @param {PublicKey} o.mint        the token, known in advance
   * @param {PublicKey} o.quoteMint   what we pay in
   * @param {PublicKey} [o.config]    the DBC config; supply it for a pre-signed snipe
   * @param {Keypair} o.keypair       the buyer
   * @param {bigint} o.amountIn       raw quote units to spend
   * @param {bigint} o.minimumAmountOut  raw base units below which the swap must fail
   * @param {boolean} [o.dryRun]      do everything except put bytes on the wire
   */
  constructor({
    wsUrl, httpUrl, sendUrls, mint, quoteMint, config = null, keypair,
    amountIn, minimumAmountOut,
    // The base mint does not exist before the launch, so its token program cannot
    // be read — but it CAN be known, from any earlier launch by the same
    // launchpad. Supplying it is what removes the last round trip from the hot
    // path on the discovery route.
    baseTokenProgram = null,
    computeUnitLimit = 250_000, computeUnitPriceMicroLamports = 1_000_000,
    resendMs = 400, fireWindowMs = 30_000, confirmPollMs = 1000,
    dryRun = false,
    // A seam, so the trigger path can be driven by a fake socket in tests. The
    // race logic is the part most worth testing and the hardest to reach live.
    wsFactory = (url) => new WebSocket(url),
  }) {
    super();
    this.wsUrl = wsUrl;
    this.httpUrl = httpUrl;
    this.sendUrls = sendUrls?.length ? sendUrls : [httpUrl];
    this.mint = mint;
    this.quoteMint = quoteMint;
    this.config = config;
    this.keypair = keypair;
    this.buyer = keypair.publicKey;
    this.amountIn = amountIn;
    this.minimumAmountOut = minimumAmountOut;
    this.computeUnitLimit = computeUnitLimit;
    this.computeUnitPriceMicroLamports = computeUnitPriceMicroLamports;
    this.resendMs = resendMs;
    this.fireWindowMs = fireWindowMs;
    this.confirmPollMs = confirmPollMs;
    this.dryRun = dryRun;
    this.wsFactory = wsFactory;

    this.state = STATE.IDLE;
    this.plan = null;          // pre-armed only
    this.presigned = null;     // pre-armed only
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
    this.timeline = {};        // what happened when, for an honest latency report
  }

  #mark(name) { this.timeline[name] = Date.now(); this.emit('mark', { name, at: this.timeline[name] }); }

  /**
   * Resolve everything that can be resolved before the launch, and refuse to arm
   * if anything needed at fire time is missing.
   *
   * Refusing here is the whole value: every check below is one that would
   * otherwise fail DURING the race, when there is no time to fix it.
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

    // The money has to be sitting in the quote token account already. Wrapping SOL
    // inside the snipe transaction would add instructions and rent to the hot path
    // for something that could have been done an hour earlier.
    const quoteAta = deriveAta(this.buyer, this.quoteMint, this.quoteTokenProgram);
    const balance = await getTokenBalance(this.httpUrl, quoteAta.toBase58(), { commitment: 'confirmed' });
    if (balance === null) {
      throw new Error(`arm: quote token account ${quoteAta.toBase58()} does not exist — run \`npm run snipe -- prepare\` first`);
    }
    if (balance < this.amountIn) {
      throw new Error(`arm: quote token account holds ${balance}, need ${this.amountIn}`);
    }
    this.emit('info', { at: 'arm', quoteAta: quoteAta.toBase58(), balance: balance.toString(), tokenProgram: this.quoteTokenProgram.toBase58() });

    if (this.config) {
      const cfgAccount = await getAccount(this.httpUrl, this.config.toBase58(), { commitment: 'confirmed' });
      if (!cfgAccount) throw new Error(`arm: config ${this.config.toBase58()} does not exist`);
      if (cfgAccount.owner !== DBC_PROGRAM_ID.toBase58()) {
        throw new Error(`arm: config ${this.config.toBase58()} is owned by ${cfgAccount.owner}, not the DBC program`);
      }
      const cfg = decodePoolConfig(cfgAccount.data);

      // The config names the currency the curve trades against. If that is not
      // what we funded, the derived pool is a different pool and the snipe would
      // be aimed at nothing.
      if (cfg.quoteMint.toBase58() !== this.quoteMint.toBase58()) {
        throw new Error(`arm: config quotes ${cfg.quoteMint.toBase58()} but we funded ${this.quoteMint.toBase58()}`);
      }
      this.baseTokenProgram = tokenProgramFor(cfg.tokenType);

      this.plan = planSnipe({
        config: this.config, baseMint: this.mint, quoteMint: this.quoteMint, buyer: this.buyer,
        baseTokenType: cfg.tokenType, quoteTokenType: cfg.quoteTokenFlag,
      });

      // If the pool is already there, we are not sniping a launch — we are late.
      // Say so rather than firing into a curve that has already moved.
      const existing = await getAccount(this.httpUrl, this.plan.pool.toBase58(), { commitment: 'confirmed' });
      if (existing) {
        this.emit('warn', { at: 'arm', message: `pool ${this.plan.pool.toBase58()} ALREADY EXISTS — this launch has happened` });
      }

      this.#resign();
      this.blockhashes.onRefresh = () => { if (!this.fired) this.#resign(); };
      this.emit('armed', {
        mode: 'pre-signed',
        pool: this.plan.pool.toBase58(),
        baseVault: this.plan.baseVault.toBase58(),
        quoteVault: this.plan.quoteVault.toBase58(),
        outputTokenAccount: this.plan.outputTokenAccount.toBase58(),
        txBytes: this.presigned.bytes,
        poolExists: Boolean(existing),
      });
    } else {
      // Discovery path. The pool address is unknowable until it exists, so the
      // transaction cannot be pre-signed and the base token program has to be
      // read at fire time. Slower, and honest about being slower.
      // Everything derivable without the config, derived now. What is left at
      // fire time is: decode the notification, derive two vaults, sign, send.
      this.emit('armed', {
        mode: 'discovery',
        note: 'no config supplied: the pool address is unknowable in advance, so the transaction is built at fire time',
        baseTokenProgram: this.baseTokenProgram?.toBase58() ?? null,
        roundTripsAtFire: this.baseTokenProgram ? 0 : 1,
        advice: this.baseTokenProgram
          ? 'nothing is fetched at fire time'
          : 'set snipe.baseTokenProgram to remove the one remaining fetch from the race',
      });
    }

    this.state = STATE.ARMED;
    this.#mark('armed');
    return this.state;
  }

  /** Re-sign against the current blockhash. Background work, never on the hot path. */
  #resign() {
    if (!this.plan) return;
    const instructions = snipeInstructions({
      plan: this.plan,
      amountIn: this.amountIn,
      minimumAmountOut: this.minimumAmountOut,
      computeUnitLimit: this.computeUnitLimit,
      computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
    });
    this.presigned = signSnipe({
      instructions, payer: this.buyer, blockhash: this.blockhashes.blockhash, keypair: this.keypair,
    });
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

      // Discovery trigger. dataSize plus a memcmp on base_mint is exact: only this
      // token's pool can match, so there is no filtering to do on arrival.
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

      // Pre-armed trigger. accountSubscribe on an account that does not exist yet
      // is legal and fires when it is created.
      if (this.plan) {
        this.#send({
          method: 'accountSubscribe',
          params: [this.plan.pool.toBase58(), { encoding: 'base64', commitment: 'processed' }],
        }, 'account');
      }

      this.emit('open', { triggers: this.plan ? ['programSubscribe', 'accountSubscribe'] : ['programSubscribe'] });
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('error', (e) => this.emit('warn', { at: 'socket', message: e?.message ?? String(e) }));
    ws.addEventListener('close', (ev) => {
      if (this.stopped) return;
      this.stats.reconnects++;
      this.emit('closed', { code: ev.code });
      // Tight backoff: every millisecond disconnected is a millisecond in which
      // the launch cannot be seen at all.
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
      // A provider that refuses programSubscribe is a real operational fact, not
      // a warning to bury: on the discovery path it is the ONLY trigger.
      this.emit('warn', { at: 'subscribe', message: msg.error?.message ?? 'subscribe rejected', via: this.subs.get(msg.id) });
      return;
    }

    const method = msg.method;
    if (method !== 'programNotification' && method !== 'accountNotification') return;

    const seenAt = Date.now();
    const value = msg.params?.result?.value;
    const slot = msg.params?.result?.context?.slot ?? null;
    if (!value) return;

    const poolAddress = method === 'programNotification' ? value.pubkey : this.plan?.pool.toBase58();
    const encoded = method === 'programNotification' ? value.account?.data : value.data;
    if (!poolAddress || !encoded) return;
    const data = Buffer.from(encoded[0], 'base64');

    this.stats.triggers++;
    this.emit('trigger', { via: method, pool: poolAddress, slot, seenAt, bytes: data.length });

    if (this.fired) return;    // both triggers firing on one launch is expected
    this.fired = true;
    this.#mark('trigger');
    this.#fire({ poolAddress, data, slot, seenAt }).catch((e) => {
      this.state = STATE.ABANDONED;
      this.emit('error', { at: 'fire', message: e.message });
    });
  }

  async #fire({ poolAddress, data, slot }) {
    this.state = STATE.FIRING;

    let payload = this.presigned;

    if (this.plan) {
      // Pre-armed: prove the pool is the one we armed against. Byte comparisons,
      // no network.
      const check = verifyPool({ poolAddress, data, plan: this.plan });

      if (!check.ok && (check.reason === REFUSE.POOL_MISMATCH || check.reason === REFUSE.CONFIG_MISMATCH)) {
        // NOT a refusal, and this is the common case on some launchpads.
        //
        // A pool at an address we did not derive, under a config we did not
        // expect, is exactly what happens when the launchpad mints a FRESH config
        // per launch — the config is generated in the same bundle as the pool, so
        // no config supplied in advance can be right. But the mint is right: the
        // memcmp filter cannot match any other token, and verifyPool checks the
        // mint before it checks anything else, so reaching here means the base
        // mint already matched.
        //
        // Refusing here would mean refusing to buy the correct token at the one
        // moment it can be bought, because a speed optimisation guessed wrong.
        // So the plan is thrown away and rebuilt from the pool in front of us.
        this.emit('replanned', {
          why: check.reason,
          armedPool: this.plan.pool.toBase58(),
          actualPool: poolAddress,
          note: 'the config was not the one this launch used — rebuilding from the live pool',
        });
        this.plan = null;
        payload = null;
      } else if (!check.ok) {
        // Wrong mint, or vaults that do not derive from what we funded. These are
        // not guesses that missed; they are the pool not being what it claims.
        this.state = STATE.ABANDONED;
        this.emit('refused', { reason: check.reason, detail: check.detail });
        return;
      } else if (this.blockhashes.ageMs > 45_000) {
        this.emit('warn', { at: 'fire', message: `blockhash is ${this.blockhashes.ageMs}ms old, re-signing` });
        this.#resign();
        payload = this.presigned;
      }
    }

    if (!this.plan) {
      // Discovery. Everything needed is in the notification itself: the pool
      // account carries its config and both vaults, so there is nothing to fetch —
      // PROVIDED the base token program was resolved in advance. When it was not,
      // one read happens here, and it is the only round trip in the hot path.
      if (!this.baseTokenProgram) {
        this.emit('warn', {
          at: 'fire',
          message: 'base token program unknown — fetching it now, which costs a round trip mid-race; set snipe.baseTokenProgram to avoid this',
        });
        const baseMintAccount = await getAccount(this.httpUrl, this.mint.toBase58(), { commitment: 'processed' });
        if (!baseMintAccount) throw new Error(`fire: base mint ${this.mint.toBase58()} not readable`);
        this.baseTokenProgram = new PublicKey(baseMintAccount.owner);
      }

      const plan = planFromLivePool({
        poolAddress, poolData: data, buyer: this.buyer, quoteMint: this.quoteMint,
        tokenBaseProgram: this.baseTokenProgram, tokenQuoteProgram: this.quoteTokenProgram,
        deriveAta,
      });
      this.plan = plan;
      const instructions = snipeInstructions({
        plan, amountIn: this.amountIn, minimumAmountOut: this.minimumAmountOut,
        computeUnitLimit: this.computeUnitLimit, computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
      });
      payload = signSnipe({ instructions, payer: this.buyer, blockhash: this.blockhashes.blockhash, keypair: this.keypair });
    }

    this.#mark('built');
    this.signature = payload.signature;
    this.emit('firing', {
      signature: payload.signature, pool: poolAddress, slot,
      amountIn: this.amountIn.toString(), minimumAmountOut: this.minimumAmountOut.toString(),
      triggerToBuildMs: this.timeline.built - this.timeline.trigger,
      dryRun: this.dryRun,
    });

    if (this.dryRun) {
      this.state = STATE.ABANDONED;
      this.emit('dry-run', { signature: payload.signature, note: 'nothing was sent' });
      return;
    }

    this.#blast(payload.base64);
    this.#mark('sent');

    // Keep re-sending the SAME bytes. A transaction is identified by its
    // signature, so a duplicate that lands twice is still one fill — but a single
    // send that a leader drops is no fill at all, and at a launch the mempool is
    // exactly where drops happen.
    this.resendTimer = setInterval(() => this.#blast(payload.base64), this.resendMs);
    this.confirmTimer = setInterval(() => this.#checkFill(payload.signature), this.confirmPollMs);
    setTimeout(() => {
      if (this.state === STATE.FIRING) {
        clearInterval(this.resendTimer);
        clearInterval(this.confirmTimer);
        this.state = STATE.ABANDONED;
        this.emit('abandoned', { signature: payload.signature, afterMs: this.fireWindowMs });
      }
    }, this.fireWindowMs).unref?.();
  }

  #blast(base64) {
    for (const url of this.sendUrls) {
      sendRawTransaction(url, base64)
        .then(({ signature, error }) => {
          this.stats.sends++;
          if (error) { this.stats.sendErrors++; this.emit('send-error', { url, message: error }); }
          else this.emit('sent', { url, signature });
        })
        .catch((e) => { this.stats.sendErrors++; this.emit('send-error', { url, message: e.message }); });
    }
  }

  async #checkFill(signature) {
    try {
      const [status] = await getSignatureStatuses(this.httpUrl, [signature]);
      if (!status) return;
      clearInterval(this.resendTimer);
      clearInterval(this.confirmTimer);
      this.#mark('landed');
      if (status.err) {
        this.state = STATE.ABANDONED;
        this.emit('failed', { signature, err: status.err, slot: status.slot });
        return;
      }
      this.state = STATE.FILLED;
      this.emit('filled', {
        signature, slot: status.slot, confirmations: status.confirmations,
        triggerToLandedMs: this.timeline.landed - this.timeline.trigger,
        outputTokenAccount: this.plan?.outputTokenAccount.toBase58() ?? null,
      });
    } catch (e) {
      this.emit('warn', { at: 'confirm', message: e.message });
    }
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
