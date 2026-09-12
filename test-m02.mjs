// Offline tests for the milestone-02 gates. No chain, no RPC, no wallet.

import assert from 'node:assert/strict';
import { decideEntry, capToRemainingBudget, initialState, SKIP } from './src/policy.mjs';
import { decideSellability, roundTripLossBps, probeRoundTrip, REFUSE } from './src/sellability.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };

const TRADER = { handle: 'target', sizeUsd: 50, enabled: true };
const LIMITS = { defaultSizeUsd: 25, maxOpenPositions: 3, dailyLossLimitUsd: 200, cooldownMs: 60000 };
const BUY = { handle: 'target', side: 'buy', mint: 'MINT1', chain: 'solana' };
const state = (over = {}) => ({ ...initialState(), ...over });

console.log('\npolicy');

{
  const d = decideEntry(BUY, TRADER, state(), LIMITS);
  assert.equal(d.action, 'enter');
  assert.equal(d.sizeUsd, 50); // the trader's own size wins over the default
  ok('a clean buy from a configured trader is allowed at their size');
}
{
  // The kill switch must be unreachable-around: no rule may run before it, or
  // that rule could admit a signal while the operator believes all is stopped.
  const d = decideEntry(BUY, TRADER, state({ paused: true }), LIMITS);
  assert.equal(d.reason, SKIP.PAUSED);
  // ...even when every other reason to skip also applies.
  const messy = state({ paused: true, openCount: 99, realizedPnlUsdToday: -9999 });
  assert.equal(decideEntry(BUY, null, messy, LIMITS).reason, SKIP.PAUSED);
  ok('paused beats every other rule, including an unknown trader');
}
{
  assert.equal(decideEntry({ ...BUY, side: 'funding', direction: 'out' }, TRADER, state(), LIMITS).reason, SKIP.NOT_A_TRADE);
  assert.equal(decideEntry({ ...BUY, side: null }, TRADER, state(), LIMITS).reason, SKIP.NOT_A_TRADE);
  assert.equal(decideEntry({ ...BUY, side: 'sell' }, TRADER, state(), LIMITS).reason, SKIP.NOT_A_BUY);
  ok('funding and sells never become entries');
}
{
  const d = decideEntry(BUY, TRADER, state({ realizedPnlUsdToday: -200 }), LIMITS);
  assert.equal(d.reason, SKIP.DAILY_LOSS_LIMIT);
  ok('the daily loss limit stops new entries once it is reached');
}
{
  // The subtle half: a limit merely CHECKED before the trade is not a limit. Down
  // $180 of a $200 cap, a $50 order would risk $230 on the day.
  const d = decideEntry(BUY, TRADER, state({ realizedPnlUsdToday: -180 }), LIMITS);
  assert.equal(d.action, 'enter');
  assert.equal(d.sizeUsd, 20); // capped to what is left, not the configured 50
  assert.equal(capToRemainingBudget(50, -180, 200), 20);
  assert.equal(capToRemainingBudget(50, 0, 200), 50);
  assert.equal(capToRemainingBudget(50, -200, 200), 0);
  assert.equal(capToRemainingBudget(50, -10, undefined), 50); // no cap configured
  ok('the last trade of a bad day cannot be the biggest one');
}
{
  assert.equal(decideEntry(BUY, TRADER, state({ openCount: 3 }), LIMITS).reason, SKIP.MAX_POSITIONS);
  const holding = state({ openMints: new Set(['MINT1']) });
  assert.equal(decideEntry(BUY, TRADER, holding, LIMITS).reason, SKIP.ALREADY_HOLDING);
  ok('position count and double-entry are both refused');
}
{
  const now = 1_000_000;
  const recent = state({ lastEntryAt: new Map([['target', now - 10_000]]) });
  assert.equal(decideEntry(BUY, TRADER, recent, LIMITS, now).reason, SKIP.COOLDOWN);
  const old = state({ lastEntryAt: new Map([['target', now - 70_000]]) });
  assert.equal(decideEntry(BUY, TRADER, old, LIMITS, now).action, 'enter');
  ok('the cooldown blocks a rapid re-entry and expires on time');
}
{
  // The launch rule. Copying a trader into a token they created makes us exit
  // liquidity for the person we are following, which is a different trade.
  const own = { ...BUY, creator: '0xAbC', traderAddress: '0xabc' };
  assert.equal(decideEntry(own, TRADER, state(), LIMITS).reason, SKIP.TRADER_IS_CREATOR);
  // Case must not decide it.
  const mixed = { ...BUY, creator: '0xABC', traderAddress: '0xaBc' };
  assert.equal(decideEntry(mixed, TRADER, state(), LIMITS).reason, SKIP.TRADER_IS_CREATOR);
  // Someone else's token is fine.
  const other = { ...BUY, creator: '0xdead', traderAddress: '0xabc' };
  assert.equal(decideEntry(other, TRADER, state(), LIMITS).action, 'enter');
  // Opting in is deliberate, per trader.
  assert.equal(decideEntry(own, { ...TRADER, allowOwnLaunches: true }, state(), LIMITS).action, 'enter');
  ok("a trader's own launch is refused unless the roster opts in");
}
{
  assert.equal(decideEntry(BUY, null, state(), LIMITS).reason, SKIP.UNKNOWN_TRADER);
  assert.equal(decideEntry(BUY, { ...TRADER, enabled: false }, state(), LIMITS).reason, SKIP.TRADER_DISABLED);
  const noSize = decideEntry(BUY, { handle: 'target' }, state(), { maxOpenPositions: 3 });
  assert.equal(noSize.reason, SKIP.NO_SIZE);
  ok('an unknown, disabled or unsized trader never trades');
}
{
  const d = decideEntry(BUY, TRADER, state(), { ...LIMITS, denylistMints: ['MINT1'] });
  assert.equal(d.reason, SKIP.DENYLISTED);
  ok('a denylisted token is refused');
}

console.log('\nsellability');

const IN = 1_000_000_000_000_000_000n; // 1e18
const probe = (buy, sell) => ({ inWei: IN, buy, sell });

{
  const d = decideSellability(probe({ ok: true, tokensOut: 1000n }, { ok: true, weiOut: 990_000_000_000_000_000n }));
  assert.equal(d.allow, true);
  assert.equal(d.lossBps, 100); // 1% round trip: two fees plus impact
  ok('a healthy round trip is allowed and reports its cost');
}
{
  // The classic honeypot: buying quotes fine, selling does not execute.
  const d = decideSellability(probe({ ok: true, tokensOut: 1000n }, { ok: false }));
  assert.equal(d.allow, false);
  assert.equal(d.reason, REFUSE.SELL_REVERTS);
  // ...and the quieter version, where it executes and returns nothing.
  const zero = decideSellability(probe({ ok: true, tokensOut: 1000n }, { ok: true, weiOut: 0n }));
  assert.equal(zero.reason, REFUSE.SELL_REVERTS);
  ok('a sell that reverts or returns nothing is refused');
}
{
  // THE ASYMMETRY. In the watcher an unreadable answer must never stop anything.
  // Here it must refuse: being wrong costs the whole position, not one signal.
  const buyUnknown = decideSellability(probe({ ok: null }, { ok: true, weiOut: IN }));
  assert.equal(buyUnknown.allow, false);
  assert.equal(buyUnknown.reason, REFUSE.UNREADABLE);
  const sellUnknown = decideSellability(probe({ ok: true, tokensOut: 1000n }, { ok: null }));
  assert.equal(sellUnknown.allow, false);
  assert.equal(sellUnknown.reason, REFUSE.UNREADABLE);
  ok('an unreadable quote REFUSES, in both directions');
}
{
  const d = decideSellability(probe({ ok: true, tokensOut: 1000n }, { ok: true, weiOut: 700_000_000_000_000_000n }));
  assert.equal(d.allow, false);
  assert.equal(d.reason, REFUSE.ROUND_TRIP_TOO_LOSSY);
  assert.equal(d.detail, 3000); // 30% lost
  // The ceiling is configurable, and a looser one lets the same token through.
  const loose = decideSellability(
    probe({ ok: true, tokensOut: 1000n }, { ok: true, weiOut: 700_000_000_000_000_000n }),
    { maxRoundTripLossBps: 4000 },
  );
  assert.equal(loose.allow, true);
  ok('a punitive transfer tax is refused against a configurable ceiling');
}
{
  const d = decideSellability(probe({ ok: true, tokensOut: 0n }, { ok: true, weiOut: IN }));
  assert.equal(d.reason, REFUSE.DUST_OUT);
  assert.equal(decideSellability(probe({ ok: false }, { ok: true })).reason, REFUSE.NO_BUY_QUOTE);
  ok('a buy that yields nothing, or does not quote, is refused');
}
{
  assert.equal(roundTripLossBps(IN, IN), 0);
  assert.equal(roundTripLossBps(IN, IN * 2n), 0); // gained; not this gate's problem
  assert.equal(roundTripLossBps(IN, 0n), 10_000);
  assert.equal(roundTripLossBps(0n, IN), 10_000); // nothing in: refuse, never divide by zero
  ok('round-trip arithmetic holds at the edges');
}

console.log('\nprobe');

const revert = () => { const e = new Error('execution reverted'); e.kind = 'revert'; return e; };
const network = () => { const e = new Error('ETIMEDOUT'); e.kind = 'net'; return e; };
const isRevert = (e) => e?.kind === 'revert';

{
  const quote = async ({ tokenIn }) => (tokenIn === 'WETH' ? 5000n : 980n);
  const p = await probeRoundTrip({ quote, isRevert }, { tokenIn: 'WETH', token: 'TKN', inWei: 1000n, fee: 3000 });
  assert.equal(p.buy.ok, true);
  assert.equal(p.buy.tokensOut, 5000n);
  assert.equal(p.sell.ok, true);
  assert.equal(p.sell.weiOut, 980n);
  ok('both legs are quoted, the sell using what the buy would actually yield');
}
{
  // A revert and a dead RPC look identical over JSON-RPC. Telling them apart is
  // what separates "the token said no" from "we could not ask" — both refuse,
  // but only one of them means the token is bad.
  const quote = async ({ tokenIn }) => { if (tokenIn === 'WETH') return 5000n; throw revert(); };
  const p = await probeRoundTrip({ quote, isRevert }, { tokenIn: 'WETH', token: 'TKN', inWei: 1000n, fee: 3000 });
  assert.equal(p.sell.ok, false);
  assert.equal(decideSellability(p).reason, REFUSE.SELL_REVERTS);

  const flaky = async ({ tokenIn }) => { if (tokenIn === 'WETH') return 5000n; throw network(); };
  const q = await probeRoundTrip({ quote: flaky, isRevert }, { tokenIn: 'WETH', token: 'TKN', inWei: 1000n, fee: 3000 });
  assert.equal(q.sell.ok, null);
  assert.equal(decideSellability(q).reason, REFUSE.UNREADABLE);
  ok('a revert and a network failure are told apart, and both refuse');
}
{
  const quote = async () => { throw network(); };
  const p = await probeRoundTrip({ quote, isRevert }, { tokenIn: 'WETH', token: 'TKN', inWei: 1000n, fee: 3000 });
  assert.equal(p.buy.ok, null);
  assert.equal(p.sell.ok, null); // never probed; must not read as a healthy zero
  assert.equal(decideSellability(p).reason, REFUSE.UNREADABLE);
  ok('a dead RPC on the first leg leaves the second unknown, not false');
}

console.log(`\n${pass} passed\n`);
