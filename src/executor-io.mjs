// Everything executor.mjs deliberately does not know how to do.
//
// The split is the same one the rest of this codebase uses: the decisions are
// pure and testable, the network is here. Nothing in this file decides whether a
// trade is safe — it only fetches, signs and sends what it is told to.
//
// THE KEY NEVER COMES FROM CONFIG. `config.json` is gitignored, which protects
// against one mistake and not the others: it is copied to the VM, it ends up in
// backups, and `git add -f` is one keystroke. The private key is read from the
// environment and from nowhere else, and a key found in the config file is a hard
// startup failure rather than a warning — a warning is something a running
// process prints once and nobody sees again.

import { JsonRpcProvider, Wallet } from 'ethers';
import { KYBER, quoteSwap, buildSwap } from './aggregator.mjs';
import { encodeAllowance, encodeBalanceOf, encodeDecimals, decodeUint } from './executor.mjs';

export const KEY_ENV = 'FIRSTFILL_PRIVATE_KEY';

const jsonFetch = async (url, init, timeoutMs) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  if (body === null) throw new Error(`${url}: response was not JSON (status ${res.status})`);
  return body;
};

/**
 * Wait for a transaction to be mined.
 *
 * Polled rather than subscribed, at an interval set for this chain: Robinhood
 * Chain produces blocks about every 100ms, so ethers' 4s default would spend most
 * of the wait asleep, and even 150ms throws away most of a block. The cap is a
 * real bound — a transaction that never lands must surface as a timeout, not hang
 * the position that is waiting on it.
 */
export async function waitForReceipt(provider, hash, { intervalMs = 75, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`receipt for ${hash} did not arrive within ${timeoutMs}ms`);
}

/**
 * The transaction behind a sequencer-feed sighting, once it exists.
 *
 * The feed sees a transaction BEFORE it is executed, so a receipt is necessarily
 * a moment behind it. That gap is the whole reason detection is two-stage: the
 * alert fires on the feed, and this decides what it was.
 */
export async function fetchReceipt(provider, hash, { intervalMs = 75, timeoutMs = 15_000 } = {}) {
  try {
    return await waitForReceipt(provider, hash, { intervalMs, timeoutMs });
  } catch {
    return null;
  }
}

/**
 * A periodic probe of the aggregator and the RPC.
 *
 * ITS PROVEN JOB IS REACHABILITY. A failing probe says the aggregator is
 * unreachable BEFORE a signal needs it, rather than at the one moment that costs
 * something. That value does not depend on anything below.
 *
 * IT WAS BUILT FOR LATENCY, AND THAT PART IS NOT ESTABLISHED. The reasoning was
 * sound and the first half of it measured: this bot idles for hours and then has
 * to be fast once, and a cold connection is expensive. Measured 2026-09-14
 * against the aggregator, same query, one process:
 *
 *   back to back      941ms -> 628 -> 591 -> 413     (warm, settling)
 *   after 10s idle    1291ms
 *   after 30s idle    1021ms
 *   after 60s idle    1631ms
 *
 * So the cold penalty is real. What is NOT shown is that warming it away helps.
 * An alternating A/B — four pairs, 30s idle before each buy, warmup on and off —
 * came out genuinely ambiguous rather than positive:
 *
 *   off  1506 / 1417 / 1425 / 8252 ms     median 1506
 *   on   1157 / 1925 / 1566 / 2861 ms     median 1925
 *
 * The medians favour leaving it OFF. The worst cases favour leaving it ON — and
 * the 8252ms outlier sits on the off side, which is exactly the blowup a warm
 * connection is supposed to prevent. Four pairs cannot separate those.
 *
 * There is also a confound: the machine those numbers were taken on routes all outbound HTTPS through an agent proxy
 * (HTTPS_PROXY is set), so the proxy owns the connection to the aggregator and a
 * client-side keep-alive cannot reach the hop that costs. A production box with
 * a direct connection is a different measurement, and it has not been taken.
 *
 * So: this is ON by default for the reachability probe, which is worth its keep
 * on its own. DO NOT repeat the latency claim until someone has run that A/B on
 * the VM. If it turns out not to help there either, `warmupMs: 0` and the only
 * thing lost is the probe.
 *
 * The cost either way is one cheap query per interval, identified by client id —
 * about 5,760 requests a day at the 15s default.
 */
export function startWarmup({
  provider,
  base = KYBER.base,
  chain = KYBER.chain,
  clientId = 'firstfill',
  quoteToken,
  probeToken,
  intervalMs = 15_000,
  onResult = () => {},
}) {
  const stats = { ticks: 0, failures: 0, lastMs: null, lastError: null };
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const started = Date.now();
    try {
      // One request per endpoint that matters, in parallel: the aggregator is
      // the expensive one, the RPC is on the receipt path.
      await Promise.all([
        fetch(`${base}/${chain}/api/v1/routes?tokenIn=${quoteToken}&tokenOut=${probeToken}&amountIn=1000000`,
          { headers: { 'x-client-id': clientId }, signal: AbortSignal.timeout(8000) }).then((r) => r.text()),
        provider ? provider.send('eth_blockNumber', []) : Promise.resolve(null),
      ]);
      stats.lastMs = Date.now() - started;
      stats.lastError = null;
    } catch (err) {
      stats.failures += 1;
      stats.lastError = err?.message ?? String(err);
      stats.lastMs = Date.now() - started;
    }
    stats.ticks += 1;
    onResult(stats);
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick();

  return { stats, stop: () => { stopped = true; clearInterval(timer); } };
}

/**
 * Bind the executor's dependencies to a real chain and a real key.
 *
 * @param {object} opts
 * @param {string} opts.rpcUrl
 * @param {string} [opts.privateKey]  omit for a read-only (paper) executor
 */
export function makeExecutorDeps({
  rpcUrl,
  privateKey = null,
  aggregatorBase = KYBER.base,
  aggregatorChain = KYBER.chain,
  clientId = 'firstfill',
  httpTimeoutMs = 8000,
}) {
  if (!rpcUrl) throw new Error('executor: rpcUrl is required');

  const provider = new JsonRpcProvider(rpcUrl);
  provider.pollingInterval = 250;

  const signer = privateKey ? new Wallet(privateKey, provider) : null;

  // A token's decimals never change, so this is read once per token. Off the hot
  // path entirely: it is only used to make an alert readable, never to decide
  // anything, so a failure degrades the message rather than the trade.
  const decimalsCache = new Map();

  const readUint = async (to, data) => {
    const value = decodeUint(await provider.call({ to, data }));
    // An unreadable read is null all the way up. The executor treats null as a
    // refusal; coercing it to 0n here would turn "we could not check" into "you
    // have nothing", which reads as a different and much more confident failure.
    return value;
  };

  return {
    provider,
    signer,
    address: signer?.address ?? null,

    quote: (args) => quoteSwap(
      { fetchJson: (url) => jsonFetch(url, { headers: { 'x-client-id': clientId } }, httpTimeoutMs) },
      { ...args, base: aggregatorBase, chain: aggregatorChain },
    ),

    build: (args) => buildSwap(
      {
        postJson: (url, body) => jsonFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-client-id': clientId },
          body: JSON.stringify(body),
        }, httpTimeoutMs),
      },
      { ...args, slippageBps: args.slippageBps, base: aggregatorBase, chain: aggregatorChain, source: clientId },
    ),

    getTokenBalance: ({ token, owner }) => readUint(token, encodeBalanceOf(owner)),

    async getTokenDecimals(token) {
      const key = String(token).toLowerCase();
      if (decimalsCache.has(key)) return decimalsCache.get(key);
      const raw = await readUint(token, encodeDecimals()).catch(() => null);
      const dp = raw === null || raw > 36n ? null : Number(raw);
      decimalsCache.set(key, dp);
      return dp;
    },
    getAllowance: ({ token, owner, spender }) => readUint(token, encodeAllowance(owner, spender)),
    getNativeBalance: (owner) => provider.getBalance(owner),

    async getGasPrice() {
      const fees = await provider.getFeeData();
      // maxFeePerGas is the ceiling we would actually be charged against, so it
      // is the honest number for an affordability check. gasPrice is the legacy
      // fallback for a node that reports no 1559 data.
      const price = fees.maxFeePerGas ?? fees.gasPrice;
      return typeof price === 'bigint' && price > 0n ? price : null;
    },

    simulate: async ({ from, calls }) => {
      const result = await provider.send('eth_simulateV1', [{
        blockStateCalls: [{ calls }],
        // No state overrides: the wallet's real balances are what the decision
        // must be made against. Overriding them here would simulate a trade for
        // a wallet we do not have.
        validation: false,
        traceTransfers: false,
        returnFullTransactions: false,
      }, 'latest']);
      return result?.[0]?.calls ?? null;
    },

    send: async ({ to, data, gasLimit }) => {
      if (!signer) throw new Error(`executor: no signer — set ${KEY_ENV} to trade`);
      const tx = await signer.sendTransaction({ to, data, value: 0n, ...(gasLimit ? { gasLimit } : {}) });
      return { hash: tx.hash };
    },

    waitReceipt: (hash) => waitForReceipt(provider, hash),
  };
}

/**
 * The signing key, or null.
 *
 * Refuses outright if a key was put in the config file, rather than using the
 * environment one and letting the config copy sit there looking authoritative.
 */
export function loadPrivateKey(config, env = process.env) {
  for (const key of ['privateKey', 'private_key', 'secretKey', 'walletKey']) {
    if (config?.executor?.[key]) {
      throw new Error(`executor: remove "${key}" from the config file — the signing key is read from ${KEY_ENV} only`);
    }
  }
  const raw = env[KEY_ENV];
  if (!raw) return null;
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${KEY_ENV} must be a 0x-prefixed 32-byte hex private key`);
  }
  return value;
}
