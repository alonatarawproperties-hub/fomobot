// The Solana JSON-RPC calls the snipe path needs, over plain fetch.
//
// Deliberately not @solana/web3.js Connection. Connection retries, rewrites
// commitment, and re-orders sends in ways that are helpful for an app and wrong
// for a race: here a send must go out exactly once, exactly when told, to exactly
// the endpoint named, and a failure must be visible rather than smoothed over.
// src/solana.mjs already talks to Solana this way, so this matches the house style.

/** One JSON-RPC call. Throws on a transport failure; returns {result, error}. */
export async function rpc(url, method, params, { timeoutMs = 6000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  return { result: json?.result, error: json?.error ?? null };
}

/** An account's data as a Buffer, or null when it does not exist yet. */
export async function getAccount(url, address, { commitment = 'processed', ...opts } = {}) {
  const { result, error } = await rpc(url, 'getAccountInfo', [address, { encoding: 'base64', commitment }], opts);
  if (error) throw new Error(`getAccountInfo ${address}: ${error.message}`);
  const value = result?.value;
  if (!value) return null;
  return { data: Buffer.from(value.data[0], 'base64'), owner: value.owner, lamports: value.lamports };
}

/** An SPL token account's raw amount. The amount is at offset 64 in both token programs. */
export async function getTokenBalance(url, tokenAccount, opts = {}) {
  const acct = await getAccount(url, tokenAccount, opts);
  if (!acct) return null;
  if (acct.data.length < 72) throw new Error(`${tokenAccount} is not a token account`);
  return acct.data.readBigUInt64LE(64);
}

/** Native SOL, in lamports. What actually pays the fees. */
export async function getBalance(url, address, { commitment = 'confirmed', ...opts } = {}) {
  const { result, error } = await rpc(url, 'getBalance', [address, { commitment }], opts);
  if (error) throw new Error(`getBalance ${address}: ${error.message}`);
  return BigInt(result?.value ?? 0);
}

export async function getLatestBlockhash(url, { commitment = 'confirmed', ...opts } = {}) {
  const { result, error } = await rpc(url, 'getLatestBlockhash', [{ commitment }], opts);
  if (error) throw new Error(`getLatestBlockhash: ${error.message}`);
  return { blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight };
}

/**
 * Fire a signed transaction.
 *
 * skipPreflight is ON and maxRetries is 0, both on purpose. Preflight simulates
 * against the CURRENT bank — at the moment we fire, the pool may be one slot from
 * existing, so preflight would reject a transaction that is about to be perfectly
 * valid, and it costs a round trip to do it. Retries are ours to drive, because
 * the RPC's own retry loop gives no way to stop once the fill has landed.
 */
export async function sendRawTransaction(url, base64Tx, opts = {}) {
  const { result, error } = await rpc(url, 'sendTransaction', [
    base64Tx,
    { encoding: 'base64', skipPreflight: true, maxRetries: 0, preflightCommitment: 'processed' },
  ], { timeoutMs: 5000, ...opts });
  if (error) return { signature: null, error: error.message ?? String(error) };
  return { signature: result, error: null };
}

/** Status of signatures we have sent. null for one the cluster has not seen. */
export async function getSignatureStatuses(url, signatures, opts = {}) {
  const { result, error } = await rpc(url, 'getSignatureStatuses', [signatures, { searchTransactionHistory: false }], opts);
  if (error) throw new Error(`getSignatureStatuses: ${error.message}`);
  return result?.value ?? [];
}

/**
 * Keeps a recent blockhash on hand so firing never waits for one.
 *
 * A blockhash lives about 150 slots (~60s), so refreshing every couple of seconds
 * is cheap insurance against firing with one that just expired. The point is that
 * at fire time this is a property read, not a network call.
 */
export class BlockhashCache {
  constructor(httpUrl, { refreshMs = 2000, onError = () => {} } = {}) {
    this.httpUrl = httpUrl;
    this.refreshMs = refreshMs;
    this.onError = onError;
    this.current = null;      // { blockhash, lastValidBlockHeight, at }
    this.timer = null;
    this.refreshes = 0;
    this.failures = 0;
  }

  async refresh() {
    try {
      const got = await getLatestBlockhash(this.httpUrl);
      const changed = got.blockhash !== this.current?.blockhash;
      this.current = { ...got, at: Date.now() };
      this.refreshes++;
      return changed;
    } catch (e) {
      this.failures++;
      this.onError(e);
      return false;
    }
  }

  /** Resolves once a blockhash is actually in hand, so an arm cannot silently be unready. */
  async start() {
    await this.refresh();
    this.timer = setInterval(() => { this.refresh().then((changed) => { if (changed) this.onRefresh?.(); }); }, this.refreshMs);
    this.timer.unref?.();
    return this.current;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  get blockhash() { return this.current?.blockhash ?? null; }
  get ageMs() { return this.current ? Date.now() - this.current.at : Infinity; }
}
