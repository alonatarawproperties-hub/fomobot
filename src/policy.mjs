// The policy gate: whether a detected signal is allowed to become an order.
//
// Deliberately pure and synchronous. Every rule here is decidable from the signal
// plus in-memory state, so all of it is testable without a chain, an RPC, a wallet
// or a clock we do not control. The gates that need the network — sellability,
// liquidity depth, price — live in their own module and run AFTER this one,
// because they cost a round trip and most signals never get that far.
//
// Order matters. Cheapest and most certain first, so a refusal costs as little as
// possible and the most important refusals cannot be reached around.

/** Everything the gate may look at. Nothing else is in scope. */
/**
 * @typedef {object} PolicyState
 * @property {boolean}  paused              kill switch
 * @property {number}   realizedPnlUsdToday negative when down
 * @property {number}   openCount           positions currently held
 * @property {Set<string>} openMints        what we already hold
 * @property {Map<string, number>} lastEntryAt  handle -> ms of last entry
 */

export const SKIP = {
  PAUSED: 'paused',
  NOT_A_TRADE: 'not-a-trade',
  NOT_A_BUY: 'not-a-buy',
  UNKNOWN_TRADER: 'unknown-trader',
  TRADER_DISABLED: 'trader-disabled',
  DAILY_LOSS_LIMIT: 'daily-loss-limit',
  MAX_POSITIONS: 'max-positions',
  ALREADY_HOLDING: 'already-holding',
  COOLDOWN: 'cooldown',
  DENYLISTED: 'denylisted-token',
  TRADER_IS_CREATOR: 'trader-is-creator',
  NO_SIZE: 'no-size-configured',
};

const skip = (reason, detail) => ({ action: 'skip', reason, detail: detail ?? null });

/**
 * @param {object} signal  { handle, side, mint, chain, ... } from the watcher
 * @param {object} trader  the roster entry for that handle
 * @param {PolicyState} state
 * @param {object} limits  global limits from config
 * @param {number} now     ms
 * @returns {{action:'enter', sizeUsd:number} | {action:'skip', reason:string, detail:any}}
 */
export function decideEntry(signal, trader, state, limits, now = Date.now()) {
  // The kill switch is first on purpose. Anything checked before it would be a
  // rule that can run while the operator believes everything is stopped.
  if (state.paused) return skip(SKIP.PAUSED);

  if (!trader) return skip(SKIP.UNKNOWN_TRADER, signal.handle);
  if (trader.enabled === false) return skip(SKIP.TRADER_DISABLED, signal.handle);

  // `funding` is quote currency moving with no token traded. It is recorded and
  // may even lead a trade on another chain, but it is not itself one.
  if (signal.side === 'funding' || !signal.side) return skip(SKIP.NOT_A_TRADE);
  if (signal.side !== 'buy') return skip(SKIP.NOT_A_BUY, signal.side);
  if (!signal.mint) return skip(SKIP.NOT_A_TRADE, 'no mint');

  // A loss limit that can be exceeded by one more trade is not a limit. Checked
  // before anything that could let a signal through.
  const lossCap = limits.dailyLossLimitUsd;
  if (typeof lossCap === 'number' && lossCap > 0 && state.realizedPnlUsdToday <= -lossCap) {
    return skip(SKIP.DAILY_LOSS_LIMIT, state.realizedPnlUsdToday);
  }

  if (typeof limits.maxOpenPositions === 'number' && state.openCount >= limits.maxOpenPositions) {
    return skip(SKIP.MAX_POSITIONS, state.openCount);
  }

  // Averaging into a position the exit ladder is already managing would make the
  // ladder's levels meaningless.
  if (state.openMints?.has(signal.mint)) return skip(SKIP.ALREADY_HOLDING, signal.mint);

  if (limits.denylistMints?.includes?.(signal.mint)) return skip(SKIP.DENYLISTED, signal.mint);

  // The launch rule. Copying a trader into a token they created is not the
  // strategy: the follower inflow being ridden is the one the creator is selling
  // into, which makes the copier exit liquidity for the very person being
  // followed. Opt in per trader if you decide otherwise, deliberately.
  if (signal.creator && signal.creator.toLowerCase() === String(signal.traderAddress ?? '').toLowerCase()) {
    if (trader.allowOwnLaunches !== true) return skip(SKIP.TRADER_IS_CREATOR, signal.mint);
  }

  const last = state.lastEntryAt?.get(signal.handle);
  const cooldownMs = trader.cooldownMs ?? limits.cooldownMs ?? 0;
  if (last && cooldownMs > 0 && now - last < cooldownMs) {
    return skip(SKIP.COOLDOWN, cooldownMs - (now - last));
  }

  const sizeUsd = trader.sizeUsd ?? limits.defaultSizeUsd;
  if (!(typeof sizeUsd === 'number' && sizeUsd > 0)) return skip(SKIP.NO_SIZE, signal.handle);

  // Never stake more than the remaining daily budget allows, so the last trade of
  // a bad day cannot be the biggest one.
  const capped = capToRemainingBudget(sizeUsd, state.realizedPnlUsdToday, lossCap);
  if (capped <= 0) return skip(SKIP.DAILY_LOSS_LIMIT, state.realizedPnlUsdToday);

  return { action: 'enter', sizeUsd: capped };
}

/**
 * A position may only risk what is left of the day's budget. Without this the
 * limit is checked before the trade and ignored by it — a $500 cap does not stop
 * a $2000 order placed while $10 under.
 */
export function capToRemainingBudget(sizeUsd, realizedPnlUsdToday, lossCap) {
  if (!(typeof lossCap === 'number' && lossCap > 0)) return sizeUsd;
  const spent = realizedPnlUsdToday < 0 ? -realizedPnlUsdToday : 0;
  const remaining = lossCap - spent;
  if (remaining <= 0) return 0;
  return Math.min(sizeUsd, remaining);
}

/** Fresh state for a new day or a new process. */
export function initialState() {
  return {
    paused: false,
    realizedPnlUsdToday: 0,
    openCount: 0,
    openMints: new Set(),
    lastEntryAt: new Map(),
  };
}
