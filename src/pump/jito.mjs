// Jito block-engine client.
//
// Adapted from a working single-transaction implementation. The difference that
// matters: that one always wrapped exactly one transaction, so the bundle was a
// bundle in name only. Five wallets buying one launch need a REAL bundle, and a
// real bundle is what makes the whole thing work:
//
//   * its transactions execute in the order given, back to back, in one slot
//   * it is all-or-nothing — if any transaction fails, none of them land
//
// The second property is why the ladder in pump.mjs has to quote each leg
// against the curve the previous leg leaves behind. Get that wrong and the last
// wallet reverts, which takes the other four down with it.

const TIP_ACCOUNT_FALLBACK = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
];

export const DEFAULT_RELAYS = [
  'https://mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];

export const MAX_BUNDLE_SIZE = 5;

export class JitoClient {
  /**
   * @param {object}  opts
   * @param {string[]} [opts.relays]   block-engine base URLs, tried in parallel
   * @param {string}  [opts.authUuid]  x-jito-auth, raises the rate limit
   * @param {number}  [opts.timeoutMs]
   */
  constructor({ relays = DEFAULT_RELAYS, authUuid = '', timeoutMs = 3000, fetchImpl = fetch } = {}) {
    if (!Array.isArray(relays) || relays.length === 0) throw new Error('jito: no relays configured');
    this.relays = relays;
    this.authUuid = authUuid;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.tipAccounts = [];
    this.tipAccountsAt = 0;
  }

  #headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.authUuid) h['x-jito-auth'] = this.authUuid;
    return h;
  }

  async #rpc(baseUrl, method, params) {
    const res = await this.fetchImpl(`${baseUrl}/api/v1/bundles`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Read as text first. A 429 or a 5xx returns HTML or a bare string, and
    // res.json() on that throws a SyntaxError that reads like a network fault —
    // which is how a rate limit spent this long looking like a connectivity problem.
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`jito ${method} @ ${baseUrl}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (body.error) {
      const msg = body.error.message ?? JSON.stringify(body.error);
      // Ingress rejections are NAMED and arrive as HTTP 400: a bad signature, a
      // missing tip, too many transactions, undecodable bytes. Those are worth
      // telling apart from the limiter, which is retryable.
      const err = new Error(`jito ${method} @ ${baseUrl}: ${msg}`);
      if (body.error.code === -32097 || /rate.?limit/i.test(msg)) err.rateLimited = true;
      if (res.status === 400) err.rejectedAtIngress = true;
      throw err;
    }
    return body.result;
  }

  /**
   * Tip accounts, refreshed from the block engine.
   *
   * The hardcoded list is a fallback for the case where the API is unreachable,
   * not the primary source — Jito rotates these, and tipping an address that is
   * no longer a tip account means paying for an auction we are not entered in.
   */
  async getTipAccounts(ttlMs = 5 * 60 * 1000) {
    const now = Date.now();
    if (this.tipAccounts.length > 0 && now - this.tipAccountsAt < ttlMs) return this.tipAccounts;
    for (const relay of this.relays) {
      try {
        const result = await this.#rpc(relay, 'getTipAccounts', []);
        if (Array.isArray(result) && result.length > 0) {
          this.tipAccounts = result;
          this.tipAccountsAt = now;
          return this.tipAccounts;
        }
      } catch {
        // try the next relay
      }
    }
    if (this.tipAccounts.length > 0) return this.tipAccounts;
    return TIP_ACCOUNT_FALLBACK;
  }

  /**
   * Submit one bundle to every relay at once and take the first acceptance.
   *
   * Relays are geographically separated and their latency to the current leader
   * differs; sending to one is a bet on which of them is closest. Duplicate
   * submissions of the same bundle are not double-executed — the transactions
   * inside carry signatures, so a bundle that lands twice is the same bundle.
   */
  async sendBundle(base64Transactions) {
    if (!Array.isArray(base64Transactions) || base64Transactions.length === 0) {
      throw new Error('jito: empty bundle');
    }
    if (base64Transactions.length > MAX_BUNDLE_SIZE) {
      throw new Error(
        `jito: ${base64Transactions.length} transactions exceeds the ${MAX_BUNDLE_SIZE}-transaction bundle limit`,
      );
    }

    const results = await Promise.allSettled(
      this.relays.map(async (relay) => ({
        relay,
        bundleId: await this.#rpc(relay, 'sendBundle', [base64Transactions, { encoding: 'base64' }]),
      })),
    );

    const accepted = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (accepted.length > 0) {
      return { bundleId: accepted[0].bundleId, acceptedBy: accepted.map((a) => a.relay) };
    }

    const errors = results.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    throw new Error(`jito: all ${this.relays.length} relays refused the bundle — ${errors[0]}`);
  }

  /**
   * Poll a bundle to a terminal state, recording every sample.
   *
   * The ONLY question worth asking about a bundle that did not land is whether
   * it ever reached Pending, because that splits the two causes that look
   * identical from the outside:
   *
   *   never Pending, straight to Invalid  -> the engine dropped it before the
   *                                          auction; it was never in the running
   *   Pending, then Failed/Invalid        -> it was forwarded and then lost or reverted
   *
   * A single status check cannot tell those apart, and a single check is all
   * this client used to do. It returned on the first relay that answered, and
   * since the inflight endpoint answers for ANY well-formed id, the historical
   * endpoint below it was unreachable.
   *
   * Relays are polled round-robin with exponential backoff. The limiter is one
   * request per second PER REGION and getInflightBundleStatuses shares a bucket
   * with sendBundle — so polling the region we just sent to, within a second,
   * locks us out of the only endpoint that can answer.
   */
  async pollBundle(bundleId, { forMs = 40_000, onSample = () => {} } = {}) {
    const startedAt = Date.now();
    const samples = [];
    let attempt = 0;
    let delay = 1000;

    while (Date.now() - startedAt < forMs) {
      const relay = this.relays[attempt % this.relays.length];
      attempt += 1;
      try {
        const r = await this.#rpc(relay, 'getInflightBundleStatuses', [[bundleId]]);
        const entry = r?.value?.[0];
        const sample = {
          tMs: Date.now() - startedAt,
          relay,
          // The RAW string, never the normalised one. Normalising here would
          // throw away the distinction this whole method exists to capture.
          raw: entry?.status ?? null,
          landedSlot: entry?.landed_slot ?? null,
        };
        samples.push(sample);
        onSample(sample);
        if (sample.raw === 'Landed' || sample.raw === 'Failed') {
          return this.#settle(samples, sample, startedAt);
        }
      } catch (err) {
        samples.push({
          tMs: Date.now() - startedAt, relay,
          error: err.message, rateLimited: !!err.rateLimited,
        });
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.78, 30_000);
    }
    return this.#settle(samples, samples.filter((x) => x.raw).at(-1) ?? null, startedAt);
  }

  #settle(samples, final, startedAt) {
    const everPending = samples.some((x) => x.raw === 'Pending' || x.raw === 'InFlight');
    return {
      samples,
      final,
      everPending,
      status: final ? normaliseStatus(final.raw) : 'unknown',
      landedSlot: final?.landedSlot ?? null,
      elapsedMs: Date.now() - startedAt,
      // The verdict, stated rather than left to be inferred from the samples.
      verdict: final?.raw === 'Landed'
        ? 'landed'
        : everPending
          ? 'forwarded-then-lost'
          : 'dropped-before-auction',
    };
  }
}

/**
 * Map the block engine's status strings onto ours.
 *
 * The inflight and historical endpoints do not answer in the same vocabulary —
 * one says "Landed", the other returns Solana commitment levels. Anything
 * unrecognised becomes 'unknown' rather than being optimistically read as
 * landed, because the caller uses this to decide whether money moved.
 */
export function normaliseStatus(raw) {
  switch (raw) {
    case 'Pending':
    case 'InFlight':
      return 'pending';
    case 'Landed':
    case 'finalized':
    case 'confirmed':
    case 'processed':
      return 'landed';
    case 'Failed':
    case 'Dropped':
      return 'failed';
    case 'Invalid':
      // NOT a rejection. Jito means "I have no record of this bundle id", which
      // is what you get both for a bundle that was dropped before the auction
      // and for one that never existed. Mapping it to 'unknown' hid the single
      // most important signal this client produces.
      return 'invalid';
    default:
      return 'unknown';
  }
}
