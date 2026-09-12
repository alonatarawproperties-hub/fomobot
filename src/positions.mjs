// When to get out.
//
// Speed wins the entry; nothing wins the exit except a rule that fires without
// you. The strategy is explicitly to sell into follower inflow, so a position is
// on a clock from the moment it opens.
//
// Pure: a position plus a market reading in, a decision out. No chain, no clock
// but the one passed in, no I/O.

export const EXIT = {
  TRADER_SOLD: 'trader-sold',
  LIQUIDITY_DRAIN: 'liquidity-drain',
  STOP_LOSS: 'stop-loss',
  TAKE_PROFIT: 'take-profit',
  TIME_STOP: 'time-stop',
};

/**
 * @typedef {object} Position
 * @property {string} mint
 * @property {string} handle
 * @property {number} entryPrice     quote per token at entry
 * @property {number} openedAt       ms
 * @property {number} remaining      fraction still held, 1 => untouched
 * @property {number[]} laddersTaken gainBps levels already scaled out of
 *
 * @typedef {object} Market
 * @property {number|null} price        null => unreadable right now
 * @property {number|null} liquidityUsd null => unreadable right now
 * @property {boolean} traderSold
 *
 * @typedef {object} Rules
 * @property {number} stopLossBps      e.g. 3000 => out at -30%
 * @property {number} timeStopMs       thesis did not happen; leave flat
 * @property {number} minLiquidityUsd  below this, exit regardless of price
 * @property {Array<{gainBps:number, fraction:number}>} ladder
 */

const exit = (reason, fraction, detail) => ({ action: 'exit', reason, fraction, detail: detail ?? null });
const hold = (detail) => ({ action: 'hold', detail: detail ?? null });

/** A real, finite number. Written out because the operators lie about null. */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Gain in basis points; negative is a loss. null when it cannot be computed.
 *
 * Both bounds are typeof-checked rather than compared, because `null >= 0` is
 * TRUE in JavaScript: an earlier `!(price >= 0)` guard let null straight through
 * and `null - entryPrice` coerced to a clean -100%, handing the stop loss exactly
 * the number that dumps a position on a missing reading.
 */
export function gainBps(entryPrice, price) {
  if (!isNum(entryPrice) || entryPrice <= 0) return null;
  if (!isNum(price) || price < 0) return null;
  return Math.round(((price - entryPrice) / entryPrice) * 10_000);
}

/**
 * @returns {{action:'hold'} | {action:'exit', reason:string, fraction:number}}
 */
export function decideExit(position, market, rules, now = Date.now()) {
  if (!position || position.remaining <= 0) return hold('nothing held');

  // 1. The trader sold. Outranks everything including a profit target: his
  //    followers are about to sell into whoever is still holding, and being right
  //    about the valuation does not help once the bid leaves. Needs no price, so
  //    it still fires when the market is unreadable.
  if (market.traderSold) return exit(EXIT.TRADER_SOLD, position.remaining);

  // 2. Liquidity drain. Also above the profit ladder: leaving now at a worse
  //    price beats leaving later at no price. Only acts on a READ value — a null
  //    reading is unknown, not empty, and treating those alike would dump every
  //    position on an RPC failure.
  if (isNum(market.liquidityUsd) && rules.minLiquidityUsd > 0
      && market.liquidityUsd < rules.minLiquidityUsd) {
    return exit(EXIT.LIQUIDITY_DRAIN, position.remaining, market.liquidityUsd);
  }

  const age = now - position.openedAt;

  // 3. Price-dependent rules. An unreadable price holds rather than exits: panic
  //    selling on a blip is a loss we invented. The clock-based rule below still
  //    runs, so an unknown price cannot freeze the position forever either.
  const g = gainBps(position.entryPrice, market.price);
  if (g !== null) {
    if (rules.stopLossBps > 0 && g <= -rules.stopLossBps) {
      return exit(EXIT.STOP_LOSS, position.remaining, g);
    }

    // Scale out across the inflow rather than guessing its peak. Highest level
    // reached wins, so a fast move does not have to touch every rung.
    const taken = new Set(position.laddersTaken ?? []);
    const due = (rules.ladder ?? [])
      .filter((l) => !taken.has(l.gainBps) && g >= l.gainBps)
      .sort((a, b) => b.gainBps - a.gainBps)[0];
    if (due) {
      // Never promise more than is left, and never strand a sliver too small to
      // be worth a transaction.
      const fraction = Math.min(due.fraction, position.remaining);
      const leftover = position.remaining - fraction;
      return exit(EXIT.TAKE_PROFIT, leftover > 0 && leftover < 0.05 ? position.remaining : fraction, due.gainBps);
    }
  }

  // 4. The crowd never arrived. Leave flat rather than holding a bag on a thesis
  //    that did not happen.
  if (rules.timeStopMs > 0 && age >= rules.timeStopMs) {
    return exit(EXIT.TIME_STOP, position.remaining, age);
  }

  return hold();
}

/** Apply a decision to a position. Returns a new position; never mutates. */
export function applyExit(position, decision) {
  if (decision.action !== 'exit') return position;
  const remaining = Math.max(0, +(position.remaining - decision.fraction).toFixed(6));
  const laddersTaken = decision.reason === EXIT.TAKE_PROFIT
    ? [...(position.laddersTaken ?? []), decision.detail]
    : (position.laddersTaken ?? []);
  return { ...position, remaining, laddersTaken, closedAt: remaining === 0 ? decision.at ?? null : null };
}
