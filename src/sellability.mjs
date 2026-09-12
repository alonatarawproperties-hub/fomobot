// Can we get back out?
//
// The fastest possible entry into a token that cannot be sold is still a total
// loss, and a bot that reacts in 300ms is better at finding those than a human is.
// So the exit is simulated BEFORE the entry is allowed: quote the buy, then quote
// selling back exactly what that buy would yield, and compare.
//
// THE ASYMMETRY IS THE DESIGN. In the watcher, an unreadable answer must never
// stop anything — an RPC blip that halts detection costs one missed signal. Here,
// an unreadable answer REFUSES, because the cost of being wrong is the whole
// position rather than one trade. Same word, opposite correct behaviour, and
// collapsing the two is how a gate quietly stops being a gate.
//
// WHAT THIS CANNOT SEE, stated here rather than discovered with money on the
// line: a quoter simulates from the router's perspective, so a token that permits
// the quote but blocks a transfer to OUR address specifically — a per-address
// blocklist, a cooldown on new holders, a whitelist — passes this check and fails
// the real sell. Robinhood Chain has per-address restrictions on some assets, so
// this is not hypothetical. A full defence needs an eth_call with state overrides
// simulating the sell from our own address; where the RPC supports overrides that
// is strictly better and belongs here next.

export const REFUSE = {
  SELL_REVERTS: 'sell-reverts',
  ROUND_TRIP_TOO_LOSSY: 'round-trip-too-lossy',
  NO_BUY_QUOTE: 'no-buy-quote',
  DUST_OUT: 'dust-out',
  UNREADABLE: 'unreadable',
};

/**
 * Loss across a buy-then-sell round trip, in basis points of what went in.
 * Positive means value lost. Two pool fees plus price impact land here even for a
 * perfectly healthy token, which is why the ceiling is a threshold and not zero.
 */
export function roundTripLossBps(inWei, backWei) {
  if (inWei <= 0n) return 10_000;
  const lost = inWei - backWei;
  if (lost <= 0n) return 0; // came back up on us; not our problem here
  return Number((lost * 10_000n) / inWei);
}

/**
 * @param {object} probe
 *   { buy: {ok: true|false|null, tokensOut?: bigint},
 *     sell: {ok: true|false|null, weiOut?: bigint},
 *     inWei: bigint }
 * @param {object} limits { maxRoundTripLossBps }
 * @returns {{allow:true, lossBps:number} | {allow:false, reason:string, detail:any}}
 */
export function decideSellability(probe, limits = {}) {
  const ceiling = limits.maxRoundTripLossBps ?? 1500; // 15%

  // Unreadable refuses. Not "probably fine", not "retry later and assume yes".
  if (probe?.buy?.ok === null || probe?.sell?.ok === null) {
    return { allow: false, reason: REFUSE.UNREADABLE, detail: null };
  }

  if (probe?.buy?.ok !== true) return { allow: false, reason: REFUSE.NO_BUY_QUOTE, detail: null };
  if (!probe.buy.tokensOut || probe.buy.tokensOut <= 0n) {
    return { allow: false, reason: REFUSE.DUST_OUT, detail: String(probe.buy.tokensOut ?? 0n) };
  }

  // The classic honeypot: the buy quotes fine, the sell does not execute at all.
  if (probe.sell.ok !== true) return { allow: false, reason: REFUSE.SELL_REVERTS, detail: null };

  const backWei = probe.sell.weiOut ?? 0n;
  if (backWei <= 0n) return { allow: false, reason: REFUSE.SELL_REVERTS, detail: '0 out' };

  const lossBps = roundTripLossBps(probe.inWei, backWei);
  if (lossBps > ceiling) {
    return { allow: false, reason: REFUSE.ROUND_TRIP_TOO_LOSSY, detail: lossBps };
  }

  return { allow: true, lossBps };
}

// Uniswap QuoterV2. The quote functions are `nonpayable` by design — they revert
// to return their result — so they must be reached with eth_call, never sent.
export const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

/**
 * Quote both legs of the round trip.
 *
 * `deps.quote(params)` must resolve to a bigint amountOut, or throw. A throw is
 * ambiguous on purpose at this level — a revert and a dead RPC look identical
 * over JSON-RPC — so the caller distinguishes them: `deps.isRevert(err)` returns
 * true for an on-chain revert (the token said no) and false for anything else
 * (we could not ask). That difference decides refuse-because-honeypot versus
 * refuse-because-unreadable, and both refuse, which is why getting it wrong is
 * survivable here but reporting either as ALLOW would not be.
 */
export async function probeRoundTrip({ quote, isRevert }, { tokenIn, token, inWei, fee }) {
  const out = { inWei, buy: { ok: null }, sell: { ok: null } };

  let tokensOut;
  try {
    tokensOut = await quote({ tokenIn, tokenOut: token, amountIn: inWei, fee });
    out.buy = { ok: true, tokensOut };
  } catch (err) {
    out.buy = { ok: isRevert(err) ? false : null };
    return out;
  }

  if (!tokensOut || tokensOut <= 0n) {
    out.buy = { ok: true, tokensOut: 0n };
    return out;
  }

  try {
    const weiOut = await quote({ tokenIn: token, tokenOut: tokenIn, amountIn: tokensOut, fee });
    out.sell = { ok: true, weiOut };
  } catch (err) {
    out.sell = { ok: isRevert(err) ? false : null };
  }

  return out;
}
