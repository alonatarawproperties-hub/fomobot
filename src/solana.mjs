// Solana watcher.
//
// Uses `logsSubscribe` with a mentions filter over plain JSON-RPC WebSocket, at
// `processed` commitment — the earliest a normal RPC will tell you anything. That
// is deliberately NOT Yellowstone gRPC: gRPC and shred streaming buy 50-150ms and
// cost $200-500/mo, and the race here is against followers tapping a phone
// notification 3-60 seconds later. Nothing about this target's ~11h average hold
// justifies that bill yet. The interface below is small enough that swapping in a
// gRPC source later touches this file and nothing else.
//
// Two-stage on purpose:
//   1. a log hit fires an alert immediately — signature, slot, nothing else
//   2. getTransaction enriches it afterwards with what was actually traded
// Waiting for stage 2 before alerting would throw away the whole point.

import { EventEmitter } from 'node:events';

export class SolanaWatcher extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   opts.wsUrl      e.g. wss://mainnet.helius-rpc.com/?api-key=...
   * @param {string}   opts.httpUrl    same provider, https:// — used for enrichment
   * @param {string[]} opts.addresses  base58 wallets to watch
   * @param {string}  [opts.commitment]
   */
  constructor({ wsUrl, httpUrl, addresses, commitment = 'processed', silenceMs = 120_000 }) {
    super();
    this.wsUrl = wsUrl;
    this.httpUrl = httpUrl;
    this.addresses = addresses;
    this.commitment = commitment;
    this.silenceMs = silenceMs;

    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.nextId = 1;
    this.subs = new Map();         // rpc id -> address, until the subscription confirms
    this.subToAddress = new Map(); // subscription id -> address
    this.seen = new Set();         // signature dedupe; logs can repeat across commitments
    this.lastMsgAt = 0;
    this.pingTimer = null;

    this.stats = { hits: 0, reconnects: 0, enriched: 0, enrichFailed: 0 };
  }

  start() { this.stopped = false; this.#connect(); }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }

  #connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    this.subs.clear();
    this.subToAddress.clear();

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.lastMsgAt = Date.now();
      // One subscription per address: the mentions filter accepts exactly one.
      for (const address of this.addresses) {
        const id = this.nextId++;
        this.subs.set(id, address);
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id, method: 'logsSubscribe',
          params: [{ mentions: [address] }, { commitment: this.commitment }],
        }));
      }
      this.emit('open', { subscribing: this.addresses.length });
      this.#armWatchdog();
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('error', (e) => this.emit('warn', { at: 'socket', message: e?.message ?? String(e) }));

    ws.addEventListener('close', (ev) => {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.stopped) return;
      this.stats.reconnects++;
      this.emit('closed', { code: ev.code, reason: ev.reason || null });
      const ceiling = Math.min(10_000, 250 * 2 ** this.attempt++);
      setTimeout(() => this.#connect(), Math.random() * ceiling);
    });
  }

  #armWatchdog() {
    clearInterval(this.pingTimer);
    // A quiet wallet is normal here — unlike the sequencer feed, silence is not by
    // itself a fault. So this proves the SOCKET is alive rather than the flow.
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const quiet = Date.now() - this.lastMsgAt;
      if (quiet > this.silenceMs) {
        this.emit('warn', { at: 'watchdog', message: `no traffic for ${quiet}ms, cycling socket` });
        try { this.ws.close(); } catch { /* reconnect handles it */ }
      }
    }, 30_000);
  }

  #onMessage(ev) {
    this.lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    // Subscription confirmation: { id, result: <subscriptionId> }
    if (msg.id !== undefined && typeof msg.result === 'number') {
      const address = this.subs.get(msg.id);
      if (address) {
        this.subToAddress.set(msg.result, address);
        this.subs.delete(msg.id);
        this.emit('subscribed', { address, subscription: msg.result });
      }
      return;
    }
    if (msg.id !== undefined && msg.error) {
      this.emit('warn', { at: 'subscribe', message: msg.error?.message ?? 'subscribe rejected' });
      return;
    }

    if (msg.method !== 'logsNotification') return;

    const seenAt = Date.now();
    const sub = msg.params?.subscription;
    const value = msg.params?.result?.value;
    const slot = msg.params?.result?.context?.slot ?? null;
    const signature = value?.signature;
    if (!signature) return;

    // A failed transaction moved nothing. Acting on one is acting on nothing.
    if (value.err) return;

    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    // Unbounded growth over days would be a slow leak; the window only needs to
    // cover repeats across commitment levels.
    if (this.seen.size > 5000) {
      for (const s of this.seen) { this.seen.delete(s); if (this.seen.size <= 4000) break; }
    }

    this.stats.hits++;
    const hit = {
      chain: 'solana',
      address: this.subToAddress.get(sub) ?? null,
      signature,
      slot,
      seenAt,
      logs: value.logs ?? [],
    };
    this.emit('hit', hit);
    this.#enrich(hit);
  }

  /** Fetch the transaction behind a signature. Never blocks the alert. */
  async #enrich(hit) {
    const body = {
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [hit.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }],
    };
    // `processed` logs can arrive before the transaction is queryable, so a couple
    // of short retries are the normal path here, not an error case.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(this.httpUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(6000),
        });
        const json = await res.json();
        if (json?.result) {
          this.stats.enriched++;
          this.emit('enriched', { ...hit, tx: json.result, enrichedAt: Date.now() });
          return;
        }
      } catch { /* fall through to retry */ }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
    this.stats.enrichFailed++;
    this.emit('warn', { at: 'enrich', message: `could not fetch ${hit.signature}` });
  }
}

/**
 * Net SPL token movement for one owner, from a confirmed transaction.
 * Derived from pre/post balances rather than by decoding instructions: a swap may
 * route through any number of programs, but the balance delta is the truth and is
 * the same shape whatever venue filled it.
 */
export function tokenDeltas(tx, owner) {
  const pre = tx?.meta?.preTokenBalances ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];
  if (!pre.length && !post.length) return [];

  const key = (b) => `${b.mint}:${b.owner}`;
  const amounts = new Map();

  for (const b of pre) {
    if (b.owner !== owner) continue;
    amounts.set(key(b), { mint: b.mint, pre: BigInt(b.uiTokenAmount?.amount ?? '0'), post: 0n, decimals: b.uiTokenAmount?.decimals ?? 0 });
  }
  for (const b of post) {
    if (b.owner !== owner) continue;
    const k = key(b);
    const e = amounts.get(k) ?? { mint: b.mint, pre: 0n, post: 0n, decimals: b.uiTokenAmount?.decimals ?? 0 };
    e.post = BigInt(b.uiTokenAmount?.amount ?? '0');
    amounts.set(k, e);
  }

  const out = [];
  for (const e of amounts.values()) {
    const delta = e.post - e.pre;
    if (delta !== 0n) out.push({ mint: e.mint, delta, decimals: e.decimals });
  }
  return out;
}

const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/**
 * Classify what a transaction did for one owner.
 *
 *   buy / sell  — a non-quote token's balance changed. A real position change.
 *   funding     — ONLY quote currency moved, and it left or entered the wallet.
 *   null        — nothing of ours moved.
 *
 * `funding` exists because of what the target's history actually looks like:
 * 19 of his 25 most recent Solana signatures move only USDC, through fomo's
 * program, into one omnibus-sized account. Those are not trades and must never be
 * alerted as one — but calling them "nothing" throws away a signal, since fomo
 * settles a single USD balance across six chains and a wallet topping that balance
 * up may be about to trade somewhere this watcher cannot see.
 *
 * Whether funding actually leads a trade on another chain is NOT established. It
 * is recorded so the question can be answered from data rather than assumed.
 */
export function classifyTrade(tx, owner) {
  const deltas = tokenDeltas(tx, owner);
  if (!deltas.length) return { side: null, mint: null, amount: 0n, decimals: 0 };

  // The traded asset is whatever moved that is not the currency it was paid in.
  const subject = deltas.find((d) => !QUOTE_MINTS.has(d.mint));
  if (subject) {
    return {
      side: subject.delta > 0n ? 'buy' : 'sell',
      mint: subject.mint,
      amount: subject.delta > 0n ? subject.delta : -subject.delta,
      decimals: subject.decimals,
    };
  }

  // Quote-only movement. Report the largest leg — a wrap shows up here too, and
  // telling those apart needs the counterparty, which the caller has and this
  // function deliberately does not.
  const biggest = deltas.reduce((a, b) => ((a.delta < 0n ? -a.delta : a.delta) >= (b.delta < 0n ? -b.delta : b.delta) ? a : b));
  return {
    side: 'funding',
    direction: biggest.delta > 0n ? 'in' : 'out',
    mint: biggest.mint,
    amount: biggest.delta > 0n ? biggest.delta : -biggest.delta,
    decimals: biggest.decimals,
  };
}

/** True only for a real position change — what the executor may act on. */
export const isTrade = (t) => t.side === 'buy' || t.side === 'sell';
