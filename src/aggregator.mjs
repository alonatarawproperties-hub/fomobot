// Routing, via the KyberSwap aggregator.
//
// WHY AN AGGREGATOR, measured rather than argued. On 2026-09-14, against the
// exact token he bought (TWINE):
//
//   - Uniswap v3 has a pool for it, and that pool is EMPTY: liquidity() == 0 and
//     a real 10 USDG quote reverts with SPL. A v3 executor would have reverted on
//     every trade.
//   - His own fill went through four Uniswap v4 pools plus one other venue.
//   - Kyber's best route today is `ramses-v3` — a DEX that neither a v3 nor a v4
//     hand-roll would have touched at all.
//
// Robinhood Chain volume is roughly half Uniswap v4, a third v3, then Pons and
// PancakeSwap. A single-venue executor covers a fraction of where he can trade
// and must be rebuilt the first time he trades somewhere else. This is the only
// approach that does not need redoing per token.
//
// THE TRUST MODEL, stated plainly. The aggregator hands back BOTH a contract to
// call and the bytes to call it with, so a wrong or hostile response is a wrong
// or hostile transaction. Three bounds apply here:
//
//   1. the router is pinned to a constant and any other address is refused
//   2. approvals are sized to exactly one trade's input, never infinite, which
//      caps the worst case at that one trade
//   3. a build materially worse than the quote it came from is refused
//
// What none of that covers is calldata encoding a DIFFERENT RECIPIENT. Pinning
// the router stops us calling an attacker's contract; it does not stop the real
// router sending the output somewhere else. The only real defence is to simulate
// the swap and assert our own balance rises before broadcasting — that check
// belongs to the executor and is deliberately not pretended at here.

export const KYBER = {
  base: 'https://aggregator-api.kyberswap.com',
  chain: 'robinhood',
  // Verified on chain 2026-09-14: 13.7KB of bytecode at this address, and it is
  // what /route/build named. Never take the router from the response.
  router: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
};

export const REFUSE_BUILD = {
  ROUTER_MISMATCH: 'router-mismatch',
  NO_CALLDATA: 'no-calldata',
  BAD_CALLDATA: 'malformed-calldata',
  OUTPUT_DRIFT: 'output-drift',
  NO_QUOTE: 'no-quote',
};

const lower = (s) => String(s ?? '').toLowerCase();
const big = (v) => { try { return BigInt(v); } catch { return null; } };

/**
 * Guard a build response before anything is signed. Pure.
 *
 * @param {object} build  the `data` object from /route/build
 * @param {object} quote  the routeSummary the build was derived from
 * @param {object} limits { maxOutputDriftBps, router }
 */
export function verifyBuild(build, quote, limits = {}) {
  const router = lower(limits.router ?? KYBER.router);
  const maxDriftBps = limits.maxOutputDriftBps ?? 300; // 3%

  // 1. The router is pinned. A response naming any other contract is refused
  //    outright rather than reconciled — there is no benign reason for it to
  //    change mid-session, and approving an unknown address is the whole risk.
  if (lower(build?.routerAddress) !== router) {
    return { ok: false, reason: REFUSE_BUILD.ROUTER_MISMATCH, detail: build?.routerAddress ?? null };
  }

  const data = build?.data;
  if (typeof data !== 'string' || data.length === 0) {
    return { ok: false, reason: REFUSE_BUILD.NO_CALLDATA, detail: null };
  }
  // A selector plus at least one word. Cheap, but it catches a truncated or
  // error-shaped body being signed as if it were a swap.
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data) || data.length < 74 || data.length % 2 !== 0) {
    return { ok: false, reason: REFUSE_BUILD.BAD_CALLDATA, detail: data.slice(0, 12) };
  }

  const quoted = big(quote?.amountOut);
  const built = big(build?.amountOut);
  if (quoted === null || built === null || quoted <= 0n) {
    return { ok: false, reason: REFUSE_BUILD.NO_QUOTE, detail: null };
  }

  // Prices move between the two calls, so some drift is normal and only a WORSE
  // build is a problem. A better one is free and never refused.
  if (built < quoted) {
    const driftBps = Number(((quoted - built) * 10_000n) / quoted);
    if (driftBps > maxDriftBps) {
      return { ok: false, reason: REFUSE_BUILD.OUTPUT_DRIFT, detail: driftBps };
    }
    return { ok: true, driftBps, minOut: built };
  }

  return { ok: true, driftBps: 0, minOut: built };
}

/**
 * Worst acceptable output for a given slippage, used as the on-chain floor.
 * Computed here rather than trusted from the response: the whole point of a
 * minimum is that WE choose it.
 */
export function minOutFor(amountOut, slippageBps) {
  const out = big(amountOut);
  if (out === null || out <= 0n) return null;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.trunc(slippageBps))));
  return (out * (10_000n - bps)) / 10_000n;
}

/** GET a route. `deps.fetchJson(url)` resolves the parsed body or throws. */
export async function quoteSwap({ fetchJson }, { tokenIn, tokenOut, amountIn, base = KYBER.base, chain = KYBER.chain }) {
  const url = `${base}/${chain}/api/v1/routes`
    + `?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  const body = await fetchJson(url);
  if (body?.code !== 0 || !body?.data?.routeSummary) {
    throw new Error(`kyber routes: ${body?.message ?? 'no routeSummary'}`);
  }
  return body.data.routeSummary;
}

/** POST a build. `deps.postJson(url, body)` resolves the parsed body or throws. */
export async function buildSwap({ postJson }, {
  routeSummary, sender, recipient, slippageBps, deadline,
  base = KYBER.base, chain = KYBER.chain, source = 'firstfill',
}) {
  const payload = { routeSummary, sender, recipient, slippageTolerance: slippageBps, source };
  if (deadline) payload.deadline = deadline;
  const body = await postJson(`${base}/${chain}/api/v1/route/build`, payload);
  if (body?.code !== 0 || !body?.data) {
    throw new Error(`kyber build: ${body?.message ?? 'no data'}`);
  }
  return body.data;
}
