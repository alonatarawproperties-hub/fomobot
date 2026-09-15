// Offline tests for the executor. No network, no chain, no keys.
//
// The deps are injected, so these drive the REAL decision sequence — including
// the order transactions go out in — against recording fakes. The cases that
// matter most are the ones where `send` must never be reached: a gate whose
// refusal the caller can ignore is not a gate.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { id } from 'ethers';
import {
  SELECTOR, REFUSE_SEND, encodeApprove, encodeBalanceOf, encodeAllowance, decodeUint,
  decodeQuantity, decideApproval, approvalAmounts, buildSimulationCalls, readSimulation,
  verifySimulation, gasWithBuffer, quoteUnitsForUsd, decimalString, quoteWithRetry, formatUnits, executeBuy,
} from './src/executor.mjs';
import { USD_STABLES } from './src/chain/robinhood.mjs';
import { KYBER } from './src/aggregator.mjs';
import { Roster, handleFor } from './src/matcher.mjs';

let pass = 0;
const ok = (name) => { console.log(`  ok  ${name}`); pass++; };

const WALLET = '0x1111111111111111111111111111111111111111';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const TOKEN = '0xe27501d787d647cc82a5b4a7eafd5750386f1b77';
const ROUTER = KYBER.router;
const CALLDATA = '0xaabbccdd' + '11'.repeat(32); // 74 chars: selector + one word

const hex = (n) => '0x' + BigInt(n).toString(16);
const word32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

console.log('\nencoding');

{
  // Derived from the signatures rather than trusted. A typo in a selector does
  // not throw — it calls a different function, or nothing, with real funds.
  assert.equal(SELECTOR.approve, id('approve(address,uint256)').slice(0, 10));
  assert.equal(SELECTOR.balanceOf, id('balanceOf(address)').slice(0, 10));
  ok('selectors match the keccak of their signatures');
}
{
  const data = encodeApprove(ROUTER, 12345n);
  assert.equal(data.slice(0, 10), SELECTOR.approve);
  assert.equal(data.length, 10 + 64 + 64);
  assert.equal(data.slice(10, 74), '0'.repeat(24) + ROUTER.slice(2).toLowerCase());
  assert.equal(BigInt('0x' + data.slice(74)), 12345n);
  ok('approve encodes the spender and the exact amount');
}
{
  // The whole point of the bounded approval: the max uint must never appear.
  const maxWord = 'f'.repeat(64);
  for (const amount of [1n, 10n ** 18n, 250_000n]) {
    assert.ok(!encodeApprove(ROUTER, amount).includes(maxWord));
  }
  ok('an approval is never widened to the max uint');
}
{
  assert.equal(BigInt('0x' + encodeApprove(ROUTER, 0n).slice(74)), 0n); // the reset leg
  assert.throws(() => encodeApprove('0xnope', 1n), /not a 20-byte address/);
  assert.throws(() => encodeApprove(ROUTER, -1n), /not a uint256/);
  assert.throws(() => encodeApprove(ROUTER, 1), /not a uint256/); // number, not bigint
  assert.throws(() => encodeApprove(ROUTER, 1n << 256n), /not a uint256/);
  ok('zero is allowed for the reset; bad spenders and bad amounts throw');
}
{
  const data = encodeBalanceOf(WALLET);
  assert.equal(data.slice(0, 10), SELECTOR.balanceOf);
  assert.equal(data.length, 10 + 64);
  assert.throws(() => encodeBalanceOf('0x12'), /not a 20-byte address/);
  ok('balanceOf encodes the owner');
}
{
  assert.equal(decodeUint(word32(500)), 500n);
  assert.equal(decodeUint('0x'), null);          // a non-contract address
  assert.equal(decodeUint('0x1234'), null);      // short of a full word
  assert.equal(decodeUint('0xzz' + '0'.repeat(62)), null);
  assert.equal(decodeUint(undefined), null);
  assert.equal(decodeUint(word32(0)), 0n);       // a real zero is NOT unreadable
  ok('an unreadable balance is null, and a genuine zero is not');
}
{
  assert.equal(decodeQuantity('0xbbb2'), 48050n);
  assert.equal(decodeQuantity('0x0'), 0n);
  assert.equal(decodeQuantity('0x'), null);
  assert.equal(decodeQuantity(null), null);
  ok('a hex quantity decodes without being padded to a word first');
}

{
  const data = encodeAllowance(WALLET, ROUTER);
  assert.equal(data.slice(0, 10), id('allowance(address,address)').slice(0, 10));
  assert.equal(data.slice(0, 10), SELECTOR.allowance);
  assert.equal(data.length, 10 + 128);
  assert.throws(() => encodeAllowance(WALLET, '0xnope'), /not a 20-byte address/);
  ok('allowance encodes owner and spender');
}

console.log('\ndollar sizing');

{
  assert.equal(quoteUnitsForUsd(25, USDG), 25_000_000n);
  assert.equal(quoteUnitsForUsd(0.1, USDG), 100_000n);
  assert.equal(quoteUnitsForUsd(1000, USDG), 1_000_000_000n);
  ok('a dollar size becomes quote-token units');
}
{
  // The reason this is an allowlist and not a decimals lookup: WETH is also a
  // quote token on this chain, and 25 * 10**18 of it is not $25.
  assert.equal(quoteUnitsForUsd(25, '0x0bd7d308f8e1639fab988df18a8011f41eacad73'), null);
  assert.equal(quoteUnitsForUsd(25, '0x' + 'ab'.repeat(20)), null);
  assert.equal(USD_STABLES.has('0x0bd7d308f8e1639fab988df18a8011f41eacad73'), false);
  ok('a quote token that is not a known dollar stablecoin is refused, not guessed');
}
{
  // 25.5 * 1e18 exceeds 2^53, so multiplying would give a number that is merely
  // close. Every digit below is exact.
  const KEY = '0x' + 'cd'.repeat(20);
  const eighteen = new Map([[KEY, { symbol: 'X', decimals: 18 }]]);
  assert.equal(quoteUnitsForUsd(25.5, KEY, eighteen), 25_500_000_000_000_000_000n);
  assert.equal(quoteUnitsForUsd(0.07, KEY, eighteen), 70_000_000_000_000_000n);
  // The case that refuted the previous fix: cleaning binary noise a fixed number
  // of DECIMAL PLACES past what is kept works at one magnitude and not another,
  // and this one came out as 999999999999.
  assert.equal(quoteUnitsForUsd(0.000001, KEY, eighteen), 1_000_000_000_000n);
  ok('an 18-decimal stablecoin converts exactly at every magnitude');
}
{
  assert.equal(decimalString(29.99), '29.99');      // not 29.98999999999999843
  assert.equal(decimalString(25), '25');
  assert.equal(decimalString(0.000001), '0.000001');
  assert.equal(decimalString(1e-7), '0.0000001');   // expanded out of exponent form
  assert.equal(decimalString(1.5e-7), '0.00000015');
  assert.equal(decimalString(1e-21), '0.' + '0'.repeat(20) + '1');
  assert.equal(decimalString(-1), null);
  assert.equal(decimalString(Infinity), null);
  ok('a number becomes the decimal string that was written, exponent form expanded');
}
{
  assert.equal(quoteUnitsForUsd(29.999999999, USDG), 29_999_999n); // truncated, not rounded up to 30
  // The nearest double to 29.99 is 29.98999999999999843..., so truncating the raw
  // value would bill $29.989999 for a configured $29.99.
  assert.equal(quoteUnitsForUsd(29.99, USDG), 29_990_000n);
  assert.equal(quoteUnitsForUsd(0.07, USDG), 70_000n);
  assert.equal(quoteUnitsForUsd(0, USDG), null);
  assert.equal(quoteUnitsForUsd(-5, USDG), null);
  assert.equal(quoteUnitsForUsd(0.0000001, USDG), null); // rounds to zero units: refuse, do not send a dust trade
  assert.equal(quoteUnitsForUsd(NaN, USDG), null);
  assert.equal(quoteUnitsForUsd('25', USDG), null);
  assert.equal(quoteUnitsForUsd(1e13, USDG), null); // beyond where toFixed stays decimal
  ok('a size is truncated down, and anything that lands on zero refuses');
}

{
  // The number an operator actually reads. His real $430 buy reported
  // "6,668,726,392,704,294,000,000,000 units" -- correct, unreadable, and
  // reported back as "what does this mean".
  assert.equal(formatUnits('6668726392704294000000000', 18), '6,668,726.39');
  assert.equal(formatUnits(430_000_000n, 6), '430');
  assert.equal(formatUnits('5000000000000000000', 18), '5');
  assert.equal(formatUnits(0n, 18), '0');
  ok('a raw chain amount prints as the number a person means');
}
{
  // Never defaulted to 18. A wrong guess is off by orders of magnitude and looks
  // exactly as confident as a right one, so the caller is told we do not know.
  assert.equal(formatUnits('123', null), null);
  assert.equal(formatUnits('123', undefined), null);
  assert.equal(formatUnits('123', 1.5), null);
  assert.equal(formatUnits('123', -1), null);
  assert.equal(formatUnits('123', 99), null);
  assert.equal(formatUnits('not a number', 18), null);
  assert.equal(formatUnits(null, 18), null);
  ok('unknown or implausible decimals return null rather than a confident wrong number');
}

console.log('\napproval policy');

{
  assert.equal(decideApproval(1000n, 500n), 'none');
  assert.equal(decideApproval(500n, 500n), 'none');        // exactly enough
  assert.equal(decideApproval(0n, 500n), 'set');
  assert.equal(decideApproval(100n, 500n), 'reset-then-set');
  assert.equal(decideApproval(undefined, 500n), 'reset-then-set'); // unreadable is not "none"
  assert.equal(decideApproval(-1n, 500n), 'reset-then-set');
  ok('a non-zero but insufficient allowance goes through zero');
}
{
  assert.deepEqual(approvalAmounts('none', 500n), []);
  assert.deepEqual(approvalAmounts('set', 500n), [500n]);
  assert.deepEqual(approvalAmounts('reset-then-set', 500n), [0n, 500n]);
  ok('the approval sequence has one definition, and the reset comes first');
}

console.log('\nsimulation layout');

const layout = (approvalMode) => buildSimulationCalls({
  wallet: WALLET, tokenIn: USDG, tokenOut: TOKEN, amountIn: 500n,
  router: ROUTER, swapData: CALLDATA, approvalMode,
});

{
  const { calls, index } = layout('set');
  assert.equal(calls.length, 6);
  assert.deepEqual([index.preIn, index.preOut, index.swap, index.postIn, index.postOut], [0, 1, 3, 4, 5]);
  assert.deepEqual(index.approvals, [2]);
  assert.equal(calls[index.swap].to, ROUTER.toLowerCase());
  assert.equal(calls[index.swap].data, CALLDATA);
  assert.equal(calls[index.preIn].to, USDG);
  assert.equal(calls[index.preOut].to, TOKEN);
  ok('the balance reads bracket the swap, on the right two tokens');
}
{
  const { calls, index } = layout('none');
  assert.equal(calls.length, 5);
  assert.deepEqual(index.approvals, []);
  assert.equal(calls[index.swap].to, ROUTER.toLowerCase());
  ok('a sufficient allowance simulates no approve at all');
}
{
  const { calls, index } = layout('reset-then-set');
  assert.equal(calls.length, 7);
  assert.deepEqual(index.approvals, [2, 3]);
  assert.equal(BigInt('0x' + calls[2].data.slice(74)), 0n);
  assert.equal(BigInt('0x' + calls[3].data.slice(74)), 500n);
  ok('reset-then-set simulates approve(0) before approve(amount)');
}
{
  // Every call must name US as the sender, or the simulation describes somebody
  // else's trade and its balance deltas mean nothing.
  for (const mode of ['none', 'set', 'reset-then-set']) {
    for (const c of layout(mode).calls) assert.equal(c.from, WALLET.toLowerCase());
  }
  ok('every simulated call is sent from our own address');
}

console.log('\nreading a simulation');

/** A well-formed simulation response for a given layout. */
function simFor(index, { preIn, preOut, postIn, postOut, swapGas = 400000n, otherGas = 50000n }) {
  const out = [];
  for (let i = 0; i <= index.postOut; i++) {
    out[i] = { status: '0x1', returnData: '0x', gasUsed: hex(otherGas), logs: [] };
  }
  out[index.preIn].returnData = word32(preIn);
  out[index.preOut].returnData = word32(preOut);
  out[index.postIn].returnData = word32(postIn);
  out[index.postOut].returnData = word32(postOut);
  out[index.swap].gasUsed = hex(swapGas);
  return out;
}

const SET = layout('set');

{
  const r = readSimulation(simFor(SET.index, { preIn: 1000n, preOut: 0n, postIn: 500n, postOut: 3000n }), SET.index);
  assert.equal(r.ok, true);
  assert.equal(r.spent, 500n);
  assert.equal(r.received, 3000n);
  assert.equal(r.swapGas, 400000n);
  assert.deepEqual(r.approvalGas, [50000n]);
  ok('spend and receipt come from the balance reads, and gas stays per call');
}
{
  // The four balance reads are never broadcast, so their gas must not inflate
  // the swap's limit or the affordability check.
  const r = readSimulation(simFor(SET.index, { preIn: 1000n, preOut: 0n, postIn: 500n, postOut: 3000n }), SET.index);
  assert.equal(r.swapGas + r.approvalGas[0], 450000n);
  assert.ok(!('gasUsed' in r), 'no single rolled-up gas figure to reach for by mistake');
  ok('gas for the reads is not folded into what we are about to send');
}
{
  const results = simFor(SET.index, { preIn: 1000n, preOut: 0n, postIn: 500n, postOut: 3000n });
  results[SET.index.swap] = { status: '0x0', returnData: '0x', gasUsed: '0x1', error: { message: 'execution reverted' } };
  const r = readSimulation(results, SET.index);
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSE_SEND.SIM_CALL_FAILED);
  assert.equal(r.detail.where, 'swap');
  ok('a reverted call refuses and says which one');
}
{
  const results = simFor(SET.index, { preIn: 1000n, preOut: 0n, postIn: 500n, postOut: 3000n });
  results[SET.index.approvals[0]].status = '0x0';
  assert.equal(readSimulation(results, SET.index).detail.where, 'approve');
  ok('a reverted approve is named as such');
}
{
  const results = simFor(SET.index, { preIn: 1000n, preOut: 0n, postIn: 500n, postOut: 3000n });
  results[SET.index.postOut].returnData = '0x'; // token is not a contract
  const r = readSimulation(results, SET.index);
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSE_SEND.SIM_UNREADABLE);
  ok('an unreadable balance refuses rather than reading as zero');
}
{
  const results = simFor(SET.index, { preIn: 1000n, preOut: 0n, postIn: 500n, postOut: 3000n });
  assert.equal(readSimulation(results.slice(0, 4), SET.index).reason, REFUSE_SEND.SIM_UNREADABLE);
  assert.equal(readSimulation([...results, results[0]], SET.index).reason, REFUSE_SEND.SIM_UNREADABLE);
  assert.equal(readSimulation(null, SET.index).reason, REFUSE_SEND.SIM_UNREADABLE);
  ok('a response with the wrong number of results is refused, not indexed into');
}

console.log('\nthe gate');

const goodSim = { ok: true, spent: 500n, received: 3000n, swapGas: 400000n, approvalGas: [50000n] };

{
  const v = verifySimulation(goodSim, { amountIn: 500n, minOut: 2900n });
  assert.equal(v.ok, true);
  assert.equal(v.received, 3000n);
  ok('a healthy simulation passes');
}
{
  // THE case this module exists for: calldata that routes the output to someone
  // else looks exactly like this — the swap succeeds, and our balance does not
  // move. Nothing else in the pipeline can see it.
  const v = verifySimulation({ ...goodSim, received: 0n }, { amountIn: 500n, minOut: 2900n });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE_SEND.SHORT_RECEIPT);
  ok('a swap that succeeds while our balance does not rise is refused');
}
{
  const v = verifySimulation({ ...goodSim, received: 2899n }, { amountIn: 500n, minOut: 2900n });
  assert.equal(v.reason, REFUSE_SEND.SHORT_RECEIPT);
  assert.equal(verifySimulation({ ...goodSim, received: 2900n }, { amountIn: 500n, minOut: 2900n }).ok, true);
  ok('the floor is inclusive: one unit under refuses, exactly on it passes');
}
{
  const v = verifySimulation({ ...goodSim, spent: 501n }, { amountIn: 500n, minOut: 2900n });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE_SEND.OVERPAID);
  assert.equal(verifySimulation({ ...goodSim, spent: 499n }, { amountIn: 500n, minOut: 2900n }).ok, true);
  ok('spending more than agreed refuses; spending less is fine');
}
{
  assert.equal(verifySimulation({ ok: false, reason: 'x', detail: 1 }, { amountIn: 500n, minOut: 1n }).reason, 'x');
  assert.equal(verifySimulation(goodSim, { amountIn: 0n, minOut: 2900n }).reason, REFUSE_SEND.BAD_AMOUNT);
  assert.equal(verifySimulation(goodSim, { amountIn: 500n, minOut: 0n }).reason, REFUSE_SEND.NO_FLOOR);
  assert.equal(verifySimulation(goodSim, { amountIn: 500n, minOut: null }).reason, REFUSE_SEND.NO_FLOOR);
  ok('a missing floor refuses instead of defaulting to zero');
}
{
  assert.equal(gasWithBuffer(400000n, 2500), 500000n);
  assert.equal(gasWithBuffer(400000n, 0), 400000n);
  assert.equal(gasWithBuffer(0n, 2500), null);
  assert.equal(gasWithBuffer(undefined, 2500), null);
  ok('the gas buffer is applied, and an absent figure is null rather than zero');
}

console.log('\nquote retry');

/** A fake clock, so the window can be exercised without waiting on one. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

{
  const clock = fakeClock();
  let calls = 0;
  const r = await quoteWithRetry(
    { ...clock, quote: async () => { calls++; return { amountOut: '500' }; } },
    {}, { windowMs: 15_000, intervalMs: 1000 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.elapsedMs, 0);
  assert.equal(calls, 1);
  ok('a pool the aggregator already knows costs one call and no delay at all');
}
{
  // The launch case: the pool exists on chain, the aggregator catches up a few
  // seconds later. Measured range was 1-7s.
  const clock = fakeClock();
  let calls = 0;
  const r = await quoteWithRetry(
    { ...clock, quote: async () => { calls++; if (calls < 4) throw new Error('route not found'); return { amountOut: '500' }; } },
    {}, { windowMs: 15_000, intervalMs: 1000 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 4);
  assert.equal(r.elapsedMs, 3000);
  ok('a pool indexed a few seconds late is still caught');
}
{
  const clock = fakeClock();
  let calls = 0;
  const r = await quoteWithRetry(
    { ...clock, quote: async () => { calls++; throw new Error('route not found'); } },
    {}, { windowMs: 5_000, intervalMs: 1000 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.lastError, 'route not found');
  assert.ok(r.elapsedMs <= 5000, `gave up inside the window, waited ${r.elapsedMs}`);
  assert.equal(calls, r.attempts);
  ok('a token that never routes gives up inside its window and says why');
}
{
  // Zero means ask once: the behaviour before the retry existed, still reachable
  // for an operator who would rather miss a launch than fill late into one.
  const clock = fakeClock();
  let calls = 0;
  const r = await quoteWithRetry(
    { ...clock, quote: async () => { calls++; throw new Error('nope'); } },
    {}, { windowMs: 0, intervalMs: 1000 },
  );
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(r.ok, false);
  ok('a zero window asks exactly once');
}
{
  // A well-formed response describing no trade is retried too: an unindexed pool
  // and a nonexistent one answer the same way, and only time tells them apart.
  const clock = fakeClock();
  let calls = 0;
  const r = await quoteWithRetry(
    { ...clock, quote: async () => { calls++; return calls < 3 ? { amountOut: null } : { amountOut: '7' }; } },
    {}, { windowMs: 15_000, intervalMs: 1000 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  ok('an empty route is retried, not treated as a final answer');
}
{
  // Bounded by the clock, not by a count: a slow aggregator must not buy extra
  // attempts by being slow.
  const clock = fakeClock();
  const r = await quoteWithRetry(
    { ...clock, quote: async () => { clock.advance(4000); throw new Error('slow and empty'); } },
    {}, { windowMs: 10_000, intervalMs: 1000 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3, 'three slow attempts fill the window, not ten fast ones');
  ok('the window is wall clock, so slow attempts do not get extra tries');
}

console.log('\nexecuteBuy');

/** Recording fakes. Every call is logged so ORDER can be asserted, not just count. */
function fakeDeps(over = {}) {
  const calls = [];
  const record = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
  const deps = {
    calls,
    // `in` rather than `??`: an override OF null is the whole point of some cases,
    // and `null ?? default` quietly hands back the default instead.
    getTokenBalance: record('getTokenBalance', async () => ('inputBalance' in over ? over.inputBalance : 10_000n)),
    quote: record('quote', async () => over.quote ?? { amountOut: '3000' }),
    build: record('build', async () => over.build ?? { routerAddress: ROUTER, data: CALLDATA, amountOut: '3000' }),
    getAllowance: record('getAllowance', async () => ('allowance' in over ? over.allowance : 0n)),
    simulate: record('simulate', async ({ calls: c }) => {
      if (over.simulate) return over.simulate(c);
      const index = { preIn: 0, preOut: 1, approvals: [], swap: c.length - 3, postIn: c.length - 2, postOut: c.length - 1 };
      for (let i = 2; i < index.swap; i++) index.approvals.push(i);
      return simFor(index, { preIn: 10_000n, preOut: 0n, postIn: 9_500n, postOut: 3_000n });
    }),
    getGasPrice: record('getGasPrice', async () => ('gasPrice' in over ? over.gasPrice : 100_000_000n)),
    getNativeBalance: record('getNativeBalance', async () => ('nativeBalance' in over ? over.nativeBalance : 10n ** 18n)),
    send: record('send', async () => ({ hash: '0x' + 'ab'.repeat(32) })),
    waitReceipt: record('waitReceipt', async () => over.receipt ?? { status: '0x1' }),
  };
  return deps;
}

const params = (over = {}) => ({
  wallet: WALLET, tokenIn: USDG, tokenOut: TOKEN, amountIn: 500n, slippageBps: 300, ...over,
});

const named = (deps, name) => deps.calls.filter((c) => c.name === name);

{
  const deps = fakeDeps();
  const r = await executeBuy(deps, params({ paper: true }));
  assert.equal(r.ok, true);
  assert.equal(r.sent, false);
  assert.equal(r.paper, true);
  assert.equal(named(deps, 'send').length, 0);
  // Paper still exercises every gate, against live prices and live state.
  assert.equal(named(deps, 'quote').length, 1);
  assert.equal(named(deps, 'simulate').length, 1);
  assert.equal(r.plan.minOut, '2910'); // 3000 less 3%
  assert.equal(r.plan.simulatedOut, '3000');
  ok('paper mode runs every gate and signs nothing');
}
{
  const deps = fakeDeps();
  const r = await executeBuy(deps, params());
  assert.equal(r.ok, true);
  assert.equal(r.sent, true);
  const order = deps.calls.map((c) => c.name);
  const firstSend = order.indexOf('send');
  assert.ok(order.indexOf('simulate') < firstSend, 'simulated before anything was sent');
  assert.equal(named(deps, 'send').length, 2); // approve, then swap
  const [approve, swap] = named(deps, 'send').map((c) => c.args[0]);
  assert.equal(approve.to, USDG);
  assert.equal(approve.data, encodeApprove(ROUTER, 500n));
  assert.equal(swap.to, ROUTER.toLowerCase());
  assert.equal(swap.data, CALLDATA);
  ok('the approve goes out before the swap, for exactly the trade amount');
}
{
  // Broadcasting a swap before its approval is mined is a revert that still pays.
  const deps = fakeDeps();
  await executeBuy(deps, params());
  const seq = deps.calls.filter((c) => c.name === 'send' || c.name === 'waitReceipt').map((c) => c.name);
  assert.deepEqual(seq, ['send', 'waitReceipt', 'send', 'waitReceipt']);
  ok('each transaction is waited on before the next is broadcast');
}
{
  const deps = fakeDeps({ allowance: 100n });
  await executeBuy(deps, params());
  const sends = named(deps, 'send').map((c) => c.args[0]);
  assert.equal(sends.length, 3);
  assert.equal(sends[0].data, encodeApprove(ROUTER, 0n));
  assert.equal(sends[1].data, encodeApprove(ROUTER, 500n));
  assert.equal(sends[2].to, ROUTER.toLowerCase());
  ok('a stale partial allowance is reset through zero before the swap');
}
{
  const deps = fakeDeps({ allowance: 10_000n });
  await executeBuy(deps, params());
  const sends = named(deps, 'send').map((c) => c.args[0]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, ROUTER.toLowerCase());
  ok('an allowance that already covers the trade costs no extra transaction');
}
{
  // The refusal that matters: nothing may be signed when the simulation says our
  // balance does not rise.
  const deps = fakeDeps({
    simulate: (c) => {
      const index = { preIn: 0, preOut: 1, approvals: [2], swap: c.length - 3, postIn: c.length - 2, postOut: c.length - 1 };
      return simFor(index, { preIn: 10_000n, preOut: 0n, postIn: 9_500n, postOut: 0n });
    },
  });
  const r = await executeBuy(deps, params());
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSE_SEND.SHORT_RECEIPT);
  assert.equal(named(deps, 'send').length, 0);
  ok('a simulation showing no tokens arriving sends nothing');
}
{
  const deps = fakeDeps({ build: { routerAddress: '0x' + '99'.repeat(20), data: CALLDATA, amountOut: '3000' } });
  const r = await executeBuy(deps, params());
  assert.equal(r.reason, REFUSE_SEND.BUILD_REFUSED);
  assert.equal(named(deps, 'simulate').length, 0);
  assert.equal(named(deps, 'send').length, 0);
  ok('a build naming another router is refused before it is even simulated');
}
{
  // OUR floor comes from the quote. A build claiming a better output cannot raise
  // the bar, and one claiming a worse output cannot lower it.
  const deps = fakeDeps({
    quote: { amountOut: '1000' },
    build: { routerAddress: ROUTER, data: CALLDATA, amountOut: '2000' },
    simulate: (c) => {
      const index = { preIn: 0, preOut: 1, approvals: [2], swap: c.length - 3, postIn: c.length - 2, postOut: c.length - 1 };
      return simFor(index, { preIn: 10_000n, preOut: 0n, postIn: 9_500n, postOut: 980n });
    },
  });
  const r = await executeBuy(deps, params());
  assert.equal(r.ok, true, 'floor is 970 from the quote, not 1940 from the build');

  const worse = fakeDeps({
    quote: { amountOut: '1000' },
    build: { routerAddress: ROUTER, data: CALLDATA, amountOut: '971' }, // 290bps worse: allowed
    simulate: (c) => {
      const index = { preIn: 0, preOut: 1, approvals: [2], swap: c.length - 3, postIn: c.length - 2, postOut: c.length - 1 };
      return simFor(index, { preIn: 10_000n, preOut: 0n, postIn: 9_500n, postOut: 969n });
    },
  });
  const r2 = await executeBuy(worse, params());
  assert.equal(r2.reason, REFUSE_SEND.SHORT_RECEIPT, 'floor stayed 970, not 941 from the build');
  ok('the floor is taken from the quote and the build cannot move it');
}
{
  const deps = fakeDeps({ inputBalance: 499n });
  const r = await executeBuy(deps, params());
  assert.equal(r.reason, REFUSE_SEND.NO_INPUT_BALANCE);
  assert.equal(named(deps, 'quote').length, 0);
  ok('a trade we cannot fund is refused before anything is quoted');
}
{
  for (const [over, name] of [[{ inputBalance: null }, 'tokenBalance'], [{ nativeBalance: undefined }, 'nativeBalance']]) {
    const deps = fakeDeps(over);
    const r = await executeBuy(deps, params());
    assert.equal(r.reason, REFUSE_SEND.READ_UNREADABLE, name);
    assert.equal(r.detail, name);
    assert.equal(named(deps, 'send').length, 0);
  }
  ok('a read that will not parse refuses as unreadable, not as an empty wallet');
}
{
  const deps = fakeDeps({ nativeBalance: 1n });
  const r = await executeBuy(deps, params());
  assert.equal(r.reason, REFUSE_SEND.NO_GAS_BALANCE);
  assert.equal(named(deps, 'send').length, 0);
  ok('too little native currency for gas refuses before broadcasting');
}
{
  const deps = fakeDeps({ gasPrice: 0n });
  assert.equal((await executeBuy(deps, params())).reason, REFUSE_SEND.NO_GAS_PRICE);
  ok('an unreadable gas price refuses rather than costing nothing on paper');
}
{
  const deps = fakeDeps({ receipt: { status: '0x0' } });
  const r = await executeBuy(deps, params());
  assert.equal(r.reason, REFUSE_SEND.APPROVE_REVERTED);
  assert.equal(named(deps, 'send').length, 1); // the swap was never attempted
  ok('a reverted approve stops the sequence instead of sending the swap anyway');
}
{
  for (const [over, reason] of [
    [{ tokenOut: USDG }, REFUSE_SEND.SAME_TOKEN],
    [{ tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' }, REFUSE_SEND.NATIVE_INPUT],
    [{ tokenOut: '0x' + '00'.repeat(20) }, REFUSE_SEND.NATIVE_INPUT],
    [{ wallet: '0xnope' }, REFUSE_SEND.BAD_ADDRESS],
    [{ amountIn: 0n }, REFUSE_SEND.BAD_AMOUNT],
    [{ amountIn: 500 }, REFUSE_SEND.BAD_AMOUNT], // number, not bigint
  ]) {
    const deps = fakeDeps();
    const r = await executeBuy(deps, params(over));
    assert.equal(r.reason, reason, Object.entries(over).map(([k, v]) => `${k}=${v}`).join(','));
    assert.equal(deps.calls.length, 0, 'refused before touching the network');
  }
  ok('malformed parameters are refused before any network call');
}
{
  // ethers reports a receipt status as a number; a raw RPC reports '0x1'. Reading
  // only one of them would treat a successful approve as a revert, or worse.
  for (const status of [1, '0x1']) {
    const deps = fakeDeps({ receipt: { status } });
    assert.equal((await executeBuy(deps, params())).sent, true, String(status));
  }
  for (const status of [0, '0x0', undefined, null]) {
    const deps = fakeDeps({ receipt: { status } });
    assert.equal((await executeBuy(deps, params())).ok, false, String(status));
  }
  ok('a receipt status is read in both the numeric and the hex spelling');
}

{
  // The bug this closes: Roster lowercases an address before slicing a fallback
  // handle out of it, so a second copy that forgets to produces a different key
  // for a checksummed, handle-less entry — and the lookup misses in silence.
  const checksummed = { address: '0xB054643d9446d778511bE5eD8F46d349b8eCC2c0' };
  assert.equal(handleFor(checksummed), '0xb054643d');
  assert.equal(new Roster([checksummed]).list()[0].handle, handleFor(checksummed));
  assert.equal(handleFor({ handle: 'named', address: '0xAB'.padEnd(42, '0') }), 'named');
  ok('a roster entry has exactly one name, derived in exactly one place');
}

{
  const clock = fakeClock();
  let calls = 0;
  const deps = fakeDeps();
  Object.assign(deps, clock, {
    quote: async () => { calls++; if (calls < 3) throw new Error('route not found'); return { amountOut: '3000' }; },
  });
  const r = await executeBuy(deps, params({ paper: true }));
  assert.equal(r.ok, true);
  assert.equal(r.plan.quoteAttempts, 3);
  assert.equal(r.plan.quoteElapsedMs, 2000);
  ok('executeBuy rides out the aggregator lag on a fresh launch');
}
{
  // A token with no liquidity never routes. It must read as a refusal the caller
  // can act on, not as a thrown error -- quoteSwap throws on "route not found",
  // and letting that escape made an ordinary skip look like the executor
  // crashing.
  const clock = fakeClock();
  const deps = fakeDeps();
  Object.assign(deps, clock, { quote: async () => { throw new Error('route not found'); } });
  const r = await executeBuy(deps, params({ quoteRetryMs: 5000 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSE_SEND.NO_QUOTE);
  assert.equal(r.detail.lastError, 'route not found');
  assert.ok(r.detail.attempts > 1);
  assert.equal(named(deps, 'send').length, 0);
  ok('a token that never routes refuses cleanly and sends nothing');
}

console.log('\nsizing against the wallet, and read concurrency');

{
  // The brittleness this exists for: a configured size equal to the balance
  // refuses outright the moment the balance is a fraction short, and the trade it
  // refuses is the one the operator was waiting for.
  const deps = fakeDeps({ inputBalance: 449_990_000n });
  const r = await executeBuy(deps, params({ amountIn: 450_000_000n, useFullBalance: true, paper: true }));
  assert.equal(r.ok, true);
  assert.equal(r.plan.amountIn, '449990000', 'spent what the wallet actually held');
  assert.equal(r.plan.walletBalance, '449990000');
  const quoted = named(deps, 'quote')[0].args[0];
  assert.equal(quoted.amountIn, '449990000', 'and quoted for that amount, not the configured one');
  ok('useFullBalance spends the balance when it falls short of the configured size');
}
{
  // It is a CEILING, not "spend everything": a bigger balance does not make a
  // bigger trade.
  const deps = fakeDeps({ inputBalance: 10_000_000_000n });
  const r = await executeBuy(deps, params({ amountIn: 450_000_000n, useFullBalance: true, paper: true }));
  assert.equal(r.plan.amountIn, '450000000');
  ok('useFullBalance never spends more than the configured size');
}
{
  const deps = fakeDeps({ inputBalance: 449_990_000n });
  const r = await executeBuy(deps, params({ amountIn: 450_000_000n, paper: true }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSE_SEND.NO_INPUT_BALANCE);
  ok('without the flag a short balance still refuses, unchanged');
}
{
  const deps = fakeDeps({ inputBalance: 0n });
  const r = await executeBuy(deps, params({ amountIn: 450_000_000n, useFullBalance: true }));
  assert.equal(r.ok, false);
  assert.equal(named(deps, 'send').length, 0);
  ok('an empty wallet refuses rather than trading nothing');
}
{
  // The four chain reads are independent of each other, and fetching them one at
  // a time cost ~290ms of a ~1340ms path. This asserts they actually overlap: if
  // any is awaited before the next starts, peak concurrency drops to 1.
  let live = 0, peak = 0;
  const slow = async (v) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--; return v;
  };
  const deps = fakeDeps();
  Object.assign(deps, {
    getTokenBalance: () => slow(10_000n),
    getAllowance: () => slow(0n),
    getGasPrice: () => slow(100_000_000n),
    getNativeBalance: () => slow(10n ** 18n),
  });
  await executeBuy(deps, params({ paper: true }));
  assert.equal(peak, 4, `expected all four reads in flight together, peaked at ${peak}`);
  ok('the four chain reads are fetched together, not one after another');
}
{
  // Parallel fetching must not reorder REFUSALS. An unfundable trade still costs
  // no aggregator call, which is the property the ordering was for.
  const deps = fakeDeps({ inputBalance: 1n });
  const r = await executeBuy(deps, params());
  assert.equal(r.reason, REFUSE_SEND.NO_INPUT_BALANCE);
  assert.equal(named(deps, 'quote').length, 0);
  ok('fetching in parallel did not reorder the refusals');
}

console.log('\nwiring (read as source)');

// These read index.mjs rather than calling anything, because no unit assertion
// can prove a CALLER wired the gate in. Both guards below were verified by
// deleting them and watching this section go red.
const stripComments = (src) => src
  // Line comments FIRST. The other order lets a `/*` inside a line comment open a
  // block that swallows the rest of the file, after which every negative
  // assertion matches an empty string and passes.
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const INDEX = stripComments(readFileSync(new URL('./index.mjs', import.meta.url), 'utf8'));
assert.ok(INDEX.length > 2000, 'index.mjs stripped to nothing — the comment stripper ate the file');

{
  // He trades in bursts, so concurrent entries are the normal case. Run in
  // parallel they exceed maxOpenPositions and collide on the same pending nonce.
  const sites = [...INDEX.matchAll(/copyBuy\s*\(/g)];
  assert.equal(sites.length, 2, 'expected exactly one definition and one call site for copyBuy');
  assert.match(INDEX, /serialise\(\(\)\s*=>\s*copyBuy\(/, 'the entry path must go through serialise');
  ok('entries are serialised, so two buys cannot race the nonce or the position limit');
}
{
  // The pre-approval sends a transaction, and the feed is already running when it
  // fires. Outside the entry queue it races an early signal for the same nonce.
  assert.match(INDEX, /serialise\(\(\)\s*=>\s*preApproveQuoteToken\(\)\)/,
    'pre-approval must go through the same queue as entries');
  const sites = [...INDEX.matchAll(/preApproveQuoteToken\s*\(/g)];
  assert.equal(sites.length, 2, 'one definition, one call site');
  ok('startup pre-approval shares the entry queue, so it cannot race a signal for the nonce');
}
{
  // Dedupe must happen BEFORE the receipt is fetched, or a replayed frame has
  // already started a second copy by the time we notice it is a duplicate.
  const guard = INDEX.indexOf('copiedTxs.has(');
  const fetchAt = INDEX.indexOf('fetchReceipt(');
  assert.ok(guard > 0, 'the txHash dedupe is gone');
  assert.ok(fetchAt > 0, 'the receipt fetch is gone');
  assert.ok(guard < fetchAt, 'the dedupe must be checked before the receipt is fetched');
  ok('a replayed feed frame is deduped before any work starts');
}
{
  // Paper is the default in both directions: the flag can only ever make a run
  // safer, and there is deliberately no flag that arms it.
  assert.match(INDEX, /FORCE_PAPER\s*=\s*argv\.includes\('--paper'\)/);
  assert.match(INDEX, /paper\s*=\s*FORCE_PAPER\s*\|\|/);
  assert.ok(!/--live|--arm|--real/.test(INDEX), 'no command-line flag may arm the executor');
  ok('--paper forces paper, and nothing on the command line can arm a live executor');
}
{
  // The key must never be reachable from the config file.
  assert.ok(!/config\.executor\.privateKey|executor\.privateKey\s*\|\|/.test(INDEX));
  assert.match(INDEX, /loadPrivateKey\(config, process\.env\)|loadPrivateKey\(raw, env\)/);
  ok('the signing key is read from the environment and not from the config');
}

console.log(`\n${pass} passed\n`);
