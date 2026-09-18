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
    const body = await res.json();
    if (body.error) {
      const msg = body.error.message ?? JSON.stringify(body.error);
      throw new Error(`jito ${method} @ ${baseUrl}: ${msg}`);
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

  /** Ask the relays what became of a bundle. */
  async getBundleStatus(bundleId) {
    for (const relay of this.relays) {
      try {
        const r = await this.#rpc(relay, 'getInflightBundleStatuses', [[bundleId]]);
        const entry = r?.value?.[0];
        if (entry) return { status: normaliseStatus(entry.status), slot: entry.landed_slot ?? null, relay };
      } catch {
        // fall through
      }
    }
    for (const relay of this.relays) {
      try {
        const r = await this.#rpc(relay, 'getBundleStatuses', [[bundleId]]);
        const entry = r?.value?.[0];
        if (entry) {
          return {
            status: normaliseStatus(entry.confirmation_status),
            slot: entry.slot ?? null,
            error: entry.err ? JSON.stringify(entry.err) : null,
            relay,
          };
        }
      } catch {
        // fall through
      }
    }
    // Not indexed yet is not the same as failed, and must not be reported as one.
    return { status: 'pending', slot: null, relay: null };
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
    default:
      return 'unknown';
  }
}
