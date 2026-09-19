// Helius Sender — the submission path that actually accepts our bundles.
//
// WHY THIS EXISTS, AND WHY NOT JITO DIRECTLY. Three bundles sent to Jito's
// public block engine were accepted by five relays, given a bundle id, and
// silently discarded: status Invalid, never reaching Pending, nothing on chain.
// A probe reduced that to a 217-byte transaction containing nothing but a tip,
// to one relay, and it was dropped too — which rules out everything about what
// was being sent. Unauthenticated submission is simply not honoured.
//
// Helius Sender is authenticated infrastructure that forwards on our behalf. It
// takes the SAME bundle format as Jito — params [[base64 transactions], {encoding}]
// — and fans the bundle across every fast pathway at once, Jito included. It is
// available on every Helius plan including the free tier and consumes no API
// credits; the cost is the tip.
//
// The tip goes to a HELIUS tip account, not a Jito one. The lists are different
// and a tip to the wrong list is money thrown away.

/** Global endpoint; it auto-routes to the nearest region. */
export const SENDER_URL = 'https://sender.helius-rpc.com/fast';

/**
 * Sender's tip accounts, taken from Helius's own documentation and
 * cross-checked against the dashboard. There is no getTipAccounts method on
 * this endpoint — it answers "Unknown method" — so unlike Jito these cannot be
 * refreshed at runtime and are pinned here.
 */
export const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

/**
 * The minimum tip that buys the fast path.
 *
 * Helius: tips between 0.000005 and 0.001 SOL are accepted but do NOT enter the
 * priority buffer — they go best-effort through fewer pathways. 0.001 is the
 * threshold for every routing path and top-of-block priority, which is the
 * entire reason for using this endpoint on a launch.
 */
export const MIN_TIP_LAMPORTS = 1_000_000n;

/**
 * Sender's bundle limit is FOUR, not Jito's five.
 *
 * Measured, because it is not in the documentation we could find: a five-
 * transaction bundle is refused with HTTP 500 and
 * "Invalid Request: bundle must contain no more than 4 transactions", while one,
 * two and three all return a bundle id. Five wallets therefore have to share
 * four transactions — see packLegs in sniper.mjs.
 */
export const MAX_BUNDLE_SIZE = 4;

export class HeliusSender {
  constructor({ url = SENDER_URL, apiKey = '', timeoutMs = 5000, fetchImpl = fetch, swqosOnly = false } = {}) {
    // The API key is optional on Sender — it is credit-free and open to every
    // plan — but sending it keeps the request attributed to this account.
    const qs = [];
    if (apiKey) qs.push(`api-key=${apiKey}`);
    if (swqosOnly) qs.push('swqos_only=true');
    this.url = qs.length ? `${url}?${qs.join('&')}` : url;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async #rpc(method, params) {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Read as text first: a 429 or a 5xx returns a non-JSON body, and res.json()
    // on that throws a SyntaxError that reads like a network fault.
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`sender ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    // Sender reports errors in TWO shapes and this cost two live runs to find:
    // the JSON-RPC {error:{code,message}}, and a bare {code,message} at the top
    // level served with HTTP 500. Checking only the first returned body.result —
    // undefined — as if it were a success, so "bundle must contain no more than
    // 4 transactions" was swallowed and reported as a sent bundle.
    const problem = body.error ?? (body.code !== undefined && body.message !== undefined ? body : null);
    if (problem) {
      const msg = problem.message ?? JSON.stringify(problem);
      const err = new Error(`sender ${method}: ${msg}`);
      if (res.status === 429 || /rate.?limit/i.test(msg)) err.rateLimited = true;
      // Sender validates synchronously, so a rejection NAMES the fault — which
      // is the whole advantage over Jito's accept-then-discard.
      if (!res.ok || problem.code === -32602) err.rejectedAtIngress = true;
      throw err;
    }
    // A 200 with no result is not a success either. Returning undefined here is
    // what let a refused bundle look like a sent one.
    if (body.result === undefined) {
      throw new Error(`sender ${method}: HTTP ${res.status} returned no result — ${text.slice(0, 200)}`);
    }
    return body.result;
  }

  /**
   * Submit an atomic bundle. Same wire format as Jito's sendBundle.
   *
   * Returns the BUNDLE ID Sender answers with — a 64-character hex string, not
   * a base58 signature. Measured, not assumed: posting a well-formed bundle
   * returns {"result":"9b5ad868...c704"}. Passing that to confirmTransaction
   * fails with "signature must be base58 encoded", so the caller confirms using
   * the signatures it produced when it signed, which it already has.
   */
  async sendBundle(base64Transactions) {
    if (!Array.isArray(base64Transactions) || base64Transactions.length === 0) {
      throw new Error('sender: empty bundle');
    }
    if (base64Transactions.length > MAX_BUNDLE_SIZE) {
      throw new Error(
        `sender: ${base64Transactions.length} transactions exceeds the ${MAX_BUNDLE_SIZE}-transaction bundle limit`,
      );
    }
    const result = await this.#rpc('sendBundle', [base64Transactions, { encoding: 'base64' }]);
    return { bundleId: typeof result === 'string' ? result : JSON.stringify(result), raw: result };
  }

  /** Submit a single transaction down the same fast paths. */
  async sendTransaction(base64Transaction) {
    // skipPreflight must be true: Sender answers a preflight request with
    // "running preflight check is not supported" and an HTTP 500.
    const signature = await this.#rpc('sendTransaction', [
      base64Transaction,
      { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
    ]);
    return { signature };
  }

  pickTipAccount(random = Math.random) {
    return SENDER_TIP_ACCOUNTS[Math.floor(random() * SENDER_TIP_ACCOUNTS.length)];
  }
}
