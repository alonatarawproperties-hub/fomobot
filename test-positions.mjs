// Offline tests for the position manager. No chain, no RPC, no clock.

import assert from 'node:assert/strict';
import { decideExit, applyExit, gainBps, EXIT } from './src/positions.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };

const T0 = 1_000_000;
const RULES = {
  stopLossBps: 3000,        // out at -30%
  timeStopMs: 30 * 60_000,  // 30 minutes
  minLiquidityUsd: 2000,
  ladder: [
    { gainBps: 3000, fraction: 0.5 },
    { gainBps: 8000, fraction: 0.5 },
  ],
};

const pos = (over = {}) => ({
  mint: 'MINT1', handle: 'target', entryPrice: 100, openedAt: T0, remaining: 1, laddersTaken: [], ...over,
});
const mkt = (over = {}) => ({ price: 100, liquidityUsd: 50_000, traderSold: false, ...over });

console.log('\nexit rules');

{
  assert.equal(decideExit(pos(), mkt(), RULES, T0 + 1000).action, 'hold');
  ok('a flat, liquid, young position is held');
}
{
  const d = decideExit(pos(), mkt({ traderSold: true }), RULES, T0 + 1000);
  assert.equal(d.reason, EXIT.TRADER_SOLD);
  assert.equal(d.fraction, 1);
  ok('the trader selling exits the whole position');
}
{
  // Priority, asserted directly: both conditions true in one reading, and the
  // trader's sell must win. His followers are about to sell into us; being right
  // about the profit target does not help once the bid leaves.
  const d = decideExit(pos(), mkt({ price: 200, traderSold: true }), RULES, T0 + 1000);
  assert.equal(d.reason, EXIT.TRADER_SOLD);
  assert.equal(d.fraction, 1); // all of it, not the ladder's half
  ok('a trader sell outranks a profit target in the same reading');
}
{
  // Going now at a worse price beats going later at no price.
  const d = decideExit(pos(), mkt({ price: 200, liquidityUsd: 500 }), RULES, T0 + 1000);
  assert.equal(d.reason, EXIT.LIQUIDITY_DRAIN);
  ok('liquidity drain outranks the profit ladder');
}
{
  const d = decideExit(pos(), mkt({ price: 65 }), RULES, T0 + 1000);
  assert.equal(d.reason, EXIT.STOP_LOSS);
  assert.equal(d.fraction, 1);
  assert.equal(decideExit(pos(), mkt({ price: 71 }), RULES, T0 + 1000).action, 'hold');
  ok('the stop fires at the threshold and not a basis point before');
}
{
  const d = decideExit(pos(), mkt({ price: 130 }), RULES, T0 + 1000);
  assert.equal(d.reason, EXIT.TAKE_PROFIT);
  assert.equal(d.fraction, 0.5);
  assert.equal(d.detail, 3000);
  ok('the first rung scales out half');
}
{
  // A fast move must not have to touch every rung on the way up.
  const d = decideExit(pos(), mkt({ price: 300 }), RULES, T0 + 1000);
  assert.equal(d.detail, 8000); // the highest level reached, not the lowest
  ok('a gap through both rungs takes the higher one');
}
{
  const half = pos({ remaining: 0.5, laddersTaken: [3000] });
  assert.equal(decideExit(half, mkt({ price: 130 }), RULES, T0 + 1000).action, 'hold');
  const d = decideExit(half, mkt({ price: 200 }), RULES, T0 + 1000);
  assert.equal(d.reason, EXIT.TAKE_PROFIT);
  ok('a rung already taken does not fire twice');
}
{
  // A sliver too small to be worth its own transaction is swept with the rung.
  const most = pos({ remaining: 0.52 });
  const d = decideExit(most, mkt({ price: 130 }), RULES, T0 + 1000);
  assert.equal(d.fraction, 0.52); // not 0.5, which would strand 0.02
  ok('a leftover too small to trade is closed out with the rung');
}
{
  const d = decideExit(pos(), mkt(), RULES, T0 + 31 * 60_000);
  assert.equal(d.reason, EXIT.TIME_STOP);
  ok('the crowd never arriving closes the position flat');
}

console.log('\nunreadable market');

{
  // Panic selling on an RPC blip is a loss we invented.
  const d = decideExit(pos(), mkt({ price: null }), RULES, T0 + 1000);
  assert.equal(d.action, 'hold');
  ok('an unreadable price holds rather than exits');
}
{
  // ...but it must not disable the manager. These two need no price at all.
  const sold = decideExit(pos(), mkt({ price: null, traderSold: true }), RULES, T0 + 1000);
  assert.equal(sold.reason, EXIT.TRADER_SOLD);
  const stale = decideExit(pos(), mkt({ price: null }), RULES, T0 + 31 * 60_000);
  assert.equal(stale.reason, EXIT.TIME_STOP);
  ok('the trader sell and the time stop still fire with no price');
}
{
  // Unknown liquidity is not empty liquidity; conflating them dumps everything
  // the moment the data source hiccups.
  const d = decideExit(pos(), mkt({ liquidityUsd: null }), RULES, T0 + 1000);
  assert.equal(d.action, 'hold');
  ok('unreadable liquidity is not read as drained');
}

console.log('\nbookkeeping');

{
  assert.equal(gainBps(100, 130), 3000);
  assert.equal(gainBps(100, 70), -3000);
  assert.equal(gainBps(100, 0), -10_000);
  assert.equal(gainBps(0, 100), null);  // no entry price: never divide by zero
  assert.equal(gainBps(100, null), null);
  ok('gain arithmetic holds at the edges');
}
{
  const p = pos();
  const d = decideExit(p, mkt({ price: 130 }), RULES, T0 + 1000);
  const after = applyExit(p, d);
  assert.equal(after.remaining, 0.5);
  assert.deepEqual(after.laddersTaken, [3000]);
  assert.equal(p.remaining, 1); // the original is untouched
  const closed = applyExit(after, { action: 'exit', reason: EXIT.TRADER_SOLD, fraction: 0.5 });
  assert.equal(closed.remaining, 0);
  ok('applying an exit is immutable and closes cleanly at zero');
}
{
  assert.equal(decideExit(pos({ remaining: 0 }), mkt({ traderSold: true }), RULES, T0).action, 'hold');
  assert.equal(decideExit(null, mkt(), RULES, T0).action, 'hold');
  ok('a closed or missing position decides nothing');
}

console.log(`\n${pass} passed\n`);
