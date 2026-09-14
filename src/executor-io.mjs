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
import { encodeAllowance, encodeBalanceOf, decodeUint } from './executor.mjs';

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
 * of the wait asleep. The cap is a real bound — a transaction that never lands
 * must surface as a timeout, not hang the position that is waiting on it.
 */
export async function waitForReceipt(provider, hash, { intervalMs = 200, timeoutMs = 60_000 } = {}) {
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
export async function fetchReceipt(provider, hash, { intervalMs = 150, timeoutMs = 15_000 } = {}) {
  try {
    return await waitForReceipt(provider, hash, { intervalMs, timeoutMs });
  } catch {
    return null;
  }
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
