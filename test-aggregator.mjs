// Offline tests for the aggregator guard. No network.

import assert from 'node:assert/strict';
import { verifyBuild, minOutFor, quoteSwap, buildSwap, KYBER, REFUSE_BUILD } from './src/aggregator.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };

// The real shape, from Robinhood Chain on 2026-09-14.
const REAL_OUT = '3082376340462637678591';
const CALLDATA = '0xe21fd0e9' + 'ab'.repeat(2585); // 5194 chars, as measured
const quote = (amountOut = REAL_OUT) => ({ amountIn: '10000000', amountOut });
const build = (over = {}) => ({
  routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  amountOut: REAL_OUT,
  data: CALLDATA,
  ...over,
});

console.log('\naggregator guard');

{
  const v = verifyBuild(build(), quote());
  assert.equal(v.ok, true);
  assert.equal(v.driftBps, 0);
  assert.equal(v.minOut, BigInt(REAL_OUT));
  ok('the real build passes, case-insensitively on the router');
}
{
  // One character off. There is no benign reason for the router to change, so
  // this is refused outright rather than reconciled — approving an unknown
  // address is the entire risk this guard exists for.
  const v = verifyBuild(build({ routerAddress: '0x6131b5fae19ea4f9d964eac0408e4408b66337b6' }), quote());
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE_BUILD.ROUTER_MISMATCH);
  assert.equal(verifyBuild(build({ routerAddress: undefined }), quote()).reason, REFUSE_BUILD.ROUTER_MISMATCH);
  assert.equal(verifyBuild(build({ routerAddress: null }), quote()).reason, REFUSE_BUILD.ROUTER_MISMATCH);
  ok('any router but the pinned one is refused, including a missing one');
}
{
  assert.equal(verifyBuild(build({ data: undefined }), quote()).reason, REFUSE_BUILD.NO_CALLDATA);
  assert.equal(verifyBuild(build({ data: '' }), quote()).reason, REFUSE_BUILD.NO_CALLDATA);
  // An error body that happens to carry a string where calldata goes.
  assert.equal(verifyBuild(build({ data: 'insufficient liquidity' }), quote()).reason, REFUSE_BUILD.BAD_CALLDATA);
  // A bare selector with no arguments would encode a call to nothing useful.
  assert.equal(verifyBuild(build({ data: '0xe21fd0e9' }), quote()).reason, REFUSE_BUILD.BAD_CALLDATA);
  // Odd length cannot be bytes.
  assert.equal(verifyBuild(build({ data: '0x' + 'a'.repeat(99) }), quote()).reason, REFUSE_BUILD.BAD_CALLDATA);
  ok('missing, non-hex, truncated and odd-length calldata are all refused');
}
{
  // Prices move between /routes and /route/build, so some drift is expected.
  const slightlyWorse = (BigInt(REAL_OUT) * 9900n) / 10_000n; // -1%
  const v = verifyBuild(build({ amountOut: slightlyWorse.toString() }), quote());
  assert.equal(v.ok, true);
  assert.equal(v.driftBps, 100);
  assert.equal(v.minOut, slightlyWorse); // the floor follows the BUILD, not the quote
  ok('normal drift is allowed and the floor tracks the build');
}
{
  const muchWorse = (BigInt(REAL_OUT) * 9000n) / 10_000n; // -10%
  const v = verifyBuild(build({ amountOut: muchWorse.toString() }), quote());
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE_BUILD.OUTPUT_DRIFT);
  assert.equal(v.detail, 1000);
  // The ceiling is configurable, and a looser one lets the same build through.
  assert.equal(verifyBuild(build({ amountOut: muchWorse.toString() }), quote(), { maxOutputDriftBps: 1500 }).ok, true);
  ok('a build materially worse than its quote is refused against a configurable ceiling');
}
{
  // One-directional on purpose: a BETTER build is free and must never be refused.
  const better = (BigInt(REAL_OUT) * 12_000n) / 10_000n; // +20%
  const v = verifyBuild(build({ amountOut: better.toString() }), quote());
  assert.equal(v.ok, true);
  assert.equal(v.driftBps, 0);
  assert.equal(v.minOut, better);
  ok('a better-than-quoted build is never refused');
}
{
  assert.equal(verifyBuild(build(), { amountOut: '0' }).reason, REFUSE_BUILD.NO_QUOTE);
  assert.equal(verifyBuild(build(), {}).reason, REFUSE_BUILD.NO_QUOTE);
  assert.equal(verifyBuild(build({ amountOut: 'not-a-number' }), quote()).reason, REFUSE_BUILD.NO_QUOTE);
  ok('an unusable quote or output refuses rather than dividing by zero');
}

console.log('\nminimum output');

{
  assert.equal(minOutFor('1000000', 100), 990000n);   // 1%
  assert.equal(minOutFor('1000000', 0), 1000000n);
  assert.equal(minOutFor('1000000', 10_000), 0n);     // 100% slippage floors at zero
  assert.equal(minOutFor('1000000', 20_000), 0n);     // clamped, never negative
  assert.equal(minOutFor('1000000', -5), 1000000n);   // clamped the other way
  assert.equal(minOutFor('0', 100), null);
  assert.equal(minOutFor(undefined, 100), null);
  ok('the floor is computed locally and clamps at both ends');
}

console.log('\nclient');

{
  let seen = null;
  const fetchJson = async (url) => { seen = url; return { code: 0, data: { routeSummary: quote() } }; };
  const rs = await quoteSwap({ fetchJson }, { tokenIn: '0xaa', tokenOut: '0xbb', amountIn: '10000000' });
  assert.equal(rs.amountOut, REAL_OUT);
  assert.ok(seen.startsWith(`${KYBER.base}/${KYBER.chain}/api/v1/routes?`));
  assert.ok(seen.includes('tokenIn=0xaa') && seen.includes('tokenOut=0xbb') && seen.includes('amountIn=10000000'));
  ok('a route request hits the right chain path with the right parameters');
}
{
  // A non-zero code is an error even when the transport succeeded — an HTTP 200
  // carrying a failure body must not read as a route.
  const fetchJson = async () => ({ code: 4008, message: 'route not found' });
  await assert.rejects(
    quoteSwap({ fetchJson }, { tokenIn: '0xaa', tokenOut: '0xbb', amountIn: '1' }),
    /route not found/,
  );
  const empty = async () => ({ code: 0, data: {} });
  await assert.rejects(quoteSwap({ fetchJson: empty }, { tokenIn: '0xaa', tokenOut: '0xbb', amountIn: '1' }));
  ok('an error body or an empty one throws instead of returning a phantom route');
}
{
  let body = null;
  const postJson = async (_url, b) => { body = b; return { code: 0, data: build() }; };
  const out = await buildSwap({ postJson }, {
    routeSummary: quote(), sender: '0xme', recipient: '0xme', slippageBps: 100,
  });
  assert.equal(out.data, CALLDATA);
  assert.equal(body.slippageTolerance, 100);
  assert.equal(body.recipient, '0xme');
  assert.equal('deadline' in body, false); // omitted when not given, not sent as undefined
  ok('a build request carries the slippage and recipient it was given');
}
{
  const postJson = async () => ({ code: 4001, message: 'invalid route' });
  await assert.rejects(buildSwap({ postJson }, { routeSummary: quote(), sender: '0xme', recipient: '0xme', slippageBps: 100 }), /invalid route/);
  ok('a failed build throws rather than returning something signable');
}

console.log(`\n${pass} passed\n`);
