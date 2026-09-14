// The executor: turning an allowed signal into a swap that actually lands.
//
// Everything up to here decides WHETHER to trade. This decides whether the
// specific bytes we are about to sign will do what we think, and it is the only
// module in the codebase that can lose money by being wrong rather than by being
// slow. It is built accordingly.
//
// THE HOLE THIS CLOSES. aggregator.mjs pins the router and bounds the approval,
// and its own header says what that does not cover: calldata that encodes a
// DIFFERENT RECIPIENT. Pinning the router stops us calling an attacker's
// contract; it does not stop the real router sending the output somewhere else.
// The stated defence was "simulate the swap and assert our own balance rises
// before broadcasting". That is what happens here, and it is not a theory —
// `eth_simulateV1` was probed against Robinhood Chain on 2026-09-14 and returns
// per-call `status`, `gasUsed`, `logs` and `returnData`. A full quote -> build ->
// approve -> swap was simulated from a real USDG holder against live state: the
// swap returned status 0x1 in 390,296 gas and the balance reads either side of it
// showed -10.0000 USDG / +3505.0837 TWINE for that sender.
//
// BALANCES, NOT LOGS. The check reads `balanceOf` before and after inside the
// same simulated block and compares the two. Logs were the obvious choice and are
// the weaker one: a Transfer log is the token contract's own assertion that it
// moved something, whereas `balanceOf` is the storage the next transaction will
// actually read. A token that lies in one and not the other is caught.
//
// TWO FLOORS, AND THEY ARE NOT THE SAME ONE.
//   1. The ON-CHAIN floor lives inside Kyber's calldata, derived by them from the
//      `slippageTolerance` we send. Measured 2026-09-14 on a real build: word 211
//      of the swap arguments held 3567555826670237273239 at 1bps and
//      1783956308966015238143 at 5000bps, both exactly `amountOut * (1 - slip)`
//      less one unit of rounding. It is what protects us when state moves between
//      the simulation and the block our transaction actually lands in.
//   2. OUR floor is `minOutFor(quote.amountOut, slippageBps)`, checked against the
//      simulated balance delta. It is computed from the QUOTE, never from the
//      build, so a hostile or degraded build cannot lower the bar it has to clear.
// Both are needed. Neither replaces the other, and the first belongs to a third
// party, which is reason enough not to rely on it alone.
//
// WHAT SIMULATION STILL CANNOT SEE, said here rather than discovered with money
// on the line:
//   - It runs against `latest`. The real transaction lands a block or more later,
//     and liquidity can be pulled in between. Floor 1 is the answer to that.
//   - Approve and swap are two transactions from an EOA and cannot be atomic,
//     however they were simulated. The approval is sized to exactly one trade, so
//     the worst case of anything going wrong between them is that one trade's
//     input.
//   - A token whose `balanceOf` reports honestly and whose value is zero passes
//     every check here. That is the sellability gate's job and it runs BEFORE
//     this, in the caller.
//
// NATIVE INPUT IS REFUSED, not handled. Kyber denotes native currency with a
// sentinel address and expects `value` to carry the amount; our input is always a
// configured ERC-20 quote token, so that path would be untested code guarding
// real funds. It fails closed with a named reason instead.

import { KYBER, verifyBuild, minOutFor } from './aggregator.mjs';
import { USD_STABLES } from './chain/robinhood.mjs';

export const REFUSE_SEND = {
  BAD_ADDRESS: 'bad-address',
  SAME_TOKEN: 'same-token',
  NATIVE_INPUT: 'native-input-unsupported',
  BAD_AMOUNT: 'bad-amount',
  NO_INPUT_BALANCE: 'insufficient-input-balance',
  NO_GAS_BALANCE: 'insufficient-gas-balance',
  NO_GAS_PRICE: 'no-gas-price',
  NO_QUOTE: 'no-quote',
  NO_FLOOR: 'no-floor',
  BUILD_REFUSED: 'build-refused',
  SIM_CALL_FAILED: 'simulation-call-failed',
  SIM_UNREADABLE: 'simulation-unreadable',
  SHORT_RECEIPT: 'short-receipt',
  OVERPAID: 'overpaid',
  APPROVE_REVERTED: 'approve-reverted',
  SWAP_REVERTED: 'swap-reverted',
};

// keccak256("approve(address,uint256)")[0..4] and keccak256("balanceOf(address)").
// Derived once and asserted against ethers in the test, so a typo here goes red
// rather than producing a transaction that calls something else entirely.
export const SELECTOR = {
  approve: '0x095ea7b3',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
};

// Kyber's stand-in for the chain's native currency, in both spellings it uses.
const NATIVE_SENTINELS = new Set([
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

const lower = (s) => String(s ?? '').toLowerCase();
const isAddress = (a) => ADDRESS_RE.test(String(a ?? ''));
const word = (v) => v.toString(16).padStart(64, '0');
const addressWord = (a) => '0'.repeat(24) + lower(a).slice(2);

const refuse = (reason, detail = null) => ({ ok: false, reason, detail });

/**
 * approve(spender, amount).
 *
 * `amount` is written in full and is never widened to the max uint. An infinite
 * approval is one signature that stays exploitable for as long as the token
 * exists; an exact one caps the worst case at the trade it was granted for.
 */
export function encodeApprove(spender, amount) {
  if (!isAddress(spender)) throw new Error(`approve: ${spender} is not a 20-byte address`);
  if (typeof amount !== 'bigint' || amount < 0n || amount > MAX_UINT256) {
    throw new Error(`approve: ${amount} is not a uint256`);
  }
  return SELECTOR.approve + addressWord(spender) + word(amount);
}

/** balanceOf(owner). */
export function encodeBalanceOf(owner) {
  if (!isAddress(owner)) throw new Error(`balanceOf: ${owner} is not a 20-byte address`);
  return SELECTOR.balanceOf + addressWord(owner);
}

/** allowance(owner, spender). */
export function encodeAllowance(owner, spender) {
  if (!isAddress(owner)) throw new Error(`allowance: ${owner} is not a 20-byte address`);
  if (!isAddress(spender)) throw new Error(`allowance: ${spender} is not a 20-byte address`);
  return SELECTOR.allowance + addressWord(owner) + addressWord(spender);
}

/**
 * A uint256 out of a call's return data.
 *
 * Returns null rather than 0n for anything unreadable — an empty return is what a
 * non-contract address gives back, and reading that as a zero balance would make
 * a delta of "nothing arrived" look like a legitimate starting point.
 */
export function decodeUint(returnData) {
  const hex = lower(returnData).replace(/^0x/, '');
  if (hex.length < 64 || !/^[0-9a-f]+$/.test(hex)) return null;
  try { return BigInt('0x' + hex.slice(0, 64)); } catch { return null; }
}

/**
 * A hex quantity (`0x1a2b`) out of an RPC field such as `gasUsed`.
 *
 * Separate from decodeUint on purpose: that one reads a 32-byte ABI word and
 * requires a full 64 hex digits, which a quantity never has. Running one through
 * the other worked only by padding it first, which is the kind of thing that is
 * correct until someone tidies it.
 */
export function decodeQuantity(v) {
  const hex = lower(v).replace(/^0x/, '');
  if (!hex.length || !/^[0-9a-f]+$/.test(hex)) return null;
  try { return BigInt('0x' + hex); } catch { return null; }
}

/**
 * How to get from the current allowance to one that covers this trade.
 *
 * The reset step is not superstition: some ERC-20s (the USDT pattern) revert on
 * any approve that moves a non-zero allowance to another non-zero value. Going
 * through zero works on those and on every well-behaved token, so it is the
 * general answer rather than a per-token exception list that has to be
 * maintained. It costs one extra transaction in a case that should not arise at
 * all — we approve exactly what we spend, so the allowance lands back on zero.
 */
export function decideApproval(allowance, amountIn) {
  if (typeof allowance !== 'bigint' || allowance < 0n) return 'reset-then-set';
  if (allowance >= amountIn) return 'none';
  if (allowance === 0n) return 'set';
  return 'reset-then-set';
}

/**
 * The approvals this mode needs, in the order they must go out.
 *
 * Exported and shared because the simulation builder and the sender both need
 * this list and they must agree on its ORDER: the gas limits measured for each
 * simulated approve are matched to the real ones by position. Two local copies
 * of "reset first, then set" is a bug waiting for someone to edit one of them.
 */
export function approvalAmounts(approvalMode, amountIn) {
  if (approvalMode === 'none') return [];
  if (approvalMode === 'reset-then-set') return [0n, amountIn];
  return [amountIn];
}

/**
 * The call list handed to eth_simulateV1, and the index of each meaningful slot
 * in it. Pure, so the layout can be asserted without a chain.
 *
 * Reading the input balance either side matters as much as the output one: it is
 * what catches calldata that spends more than we agreed to.
 */
export function buildSimulationCalls({ wallet, tokenIn, tokenOut, amountIn, router, swapData, approvalMode }) {
  const calls = [];
  const index = { approvals: [] };
  const push = (to, data) => calls.push({ from: lower(wallet), to: lower(to), data, value: '0x0' }) - 1;

  index.preIn = push(tokenIn, encodeBalanceOf(wallet));
  index.preOut = push(tokenOut, encodeBalanceOf(wallet));

  for (const amount of approvalAmounts(approvalMode, amountIn)) {
    index.approvals.push(push(tokenIn, encodeApprove(router, amount)));
  }

  index.swap = push(router, swapData);
  index.postIn = push(tokenIn, encodeBalanceOf(wallet));
  index.postOut = push(tokenOut, encodeBalanceOf(wallet));

  return { calls, index };
}

/**
 * Normalise a simulation response. Pure.
 *
 * Every call must have succeeded. A revert anywhere in the block means the
 * numbers either side of it describe a world that will not happen, so there is
 * nothing to salvage by reading them.
 */
export function readSimulation(results, index) {
  if (!Array.isArray(results) || results.length !== index.postOut + 1) {
    return { ok: false, reason: REFUSE_SEND.SIM_UNREADABLE, detail: `expected ${index.postOut + 1} results, got ${Array.isArray(results) ? results.length : typeof results}` };
  }

  for (const [i, r] of results.entries()) {
    if (lower(r?.status) !== '0x1') {
      const where = i === index.swap ? 'swap' : index.approvals.includes(i) ? 'approve' : 'balance read';
      return { ok: false, reason: REFUSE_SEND.SIM_CALL_FAILED, detail: { call: i, where, error: r?.error?.message ?? null } };
    }
  }

  const preIn = decodeUint(results[index.preIn].returnData);
  const preOut = decodeUint(results[index.preOut].returnData);
  const postIn = decodeUint(results[index.postIn].returnData);
  const postOut = decodeUint(results[index.postOut].returnData);
  if (preIn === null || preOut === null || postIn === null || postOut === null) {
    return { ok: false, reason: REFUSE_SEND.SIM_UNREADABLE, detail: 'a balance read returned no uint256' };
  }

  // Gas is kept per call rather than summed. The four balance reads are ~25k each
  // and are NOT part of the transactions we send — folding them into one total
  // both inflates the swap's gas limit and overstates the cost the affordability
  // check is about to measure, which can refuse a trade we could comfortably pay
  // for.
  const gasByCall = results.map((r) => decodeQuantity(r?.gasUsed) ?? 0n);

  return {
    ok: true,
    spent: preIn - postIn,
    received: postOut - preOut,
    gasByCall,
    swapGas: gasByCall[index.swap],
    approvalGas: index.approvals.map((i) => gasByCall[i]),
  };
}

/**
 * The gate. Pure, and the last thing between a build and a signature.
 *
 * @param {object} sim     from readSimulation
 * @param {bigint} amountIn  the most we agreed to spend
 * @param {bigint} minOut    our own floor, from the quote
 */
export function verifySimulation(sim, { amountIn, minOut }) {
  if (!sim?.ok) return refuse(sim?.reason ?? REFUSE_SEND.SIM_UNREADABLE, sim?.detail ?? null);
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) return refuse(REFUSE_SEND.BAD_AMOUNT, String(amountIn));
  if (typeof minOut !== 'bigint' || minOut <= 0n) return refuse(REFUSE_SEND.NO_FLOOR, String(minOut));

  // Spending less than agreed is fine and needs no ceiling of its own. Spending
  // more is the calldata doing something we did not authorise.
  if (sim.spent > amountIn) {
    return refuse(REFUSE_SEND.OVERPAID, { spent: String(sim.spent), agreed: String(amountIn) });
  }

  // The recipient check, and the honeypot check, and the empty-pool check, all in
  // one number: did OUR balance of the token we are buying actually go up enough.
  if (sim.received < minOut) {
    return refuse(REFUSE_SEND.SHORT_RECEIPT, { received: String(sim.received), floor: String(minOut) });
  }

  return { ok: true, spent: sim.spent, received: sim.received, swapGas: sim.swapGas, approvalGas: sim.approvalGas };
}

/**
 * Gas limit from a simulated gas figure.
 *
 * The simulation ran against `latest`; the real transaction runs one or more
 * blocks later against slightly different state, and a swap that touches one more
 * pool tick costs more than the one that was simulated. The buffer covers that.
 * Too low is a reverted transaction that still pays for the gas it burned.
 */
export function gasWithBuffer(gasUsed, bufferBps = 2500) {
  if (typeof gasUsed !== 'bigint' || gasUsed <= 0n) return null;
  const bps = BigInt(Math.max(0, Math.trunc(bufferBps)));
  return gasUsed + (gasUsed * bps) / 10_000n;
}

/**
 * A dollar trade size as units of the quote token.
 *
 * The operator configures dollars because that is what a trade size means to
 * them. The chain wants token units, and the conversion is only valid because
 * the quote token is a dollar stablecoin — so the token has to be one we have
 * checked, not one we assume. An unrecognised quote token returns null and the
 * caller refuses; converting it at an assumed price would size a trade wrong in
 * whichever direction the real price happens to lie, silently.
 *
 * Fractional cents are truncated, never rounded up: the configured size is a
 * ceiling on what the operator agreed to spend.
 *
 * The conversion goes through a decimal STRING rather than `sizeUsd * 10**dec`.
 * That multiplication is exact for USDG's six places and stops being exact at
 * eighteen — 25.5 * 1e18 is past 2^53, so the double carries a number that is
 * merely close, and the error lands in the least significant digits of a real
 * transfer amount. There is no reason to leave that waiting for the first
 * 18-decimal stablecoin to be added to the allowlist.
 */
export function quoteUnitsForUsd(sizeUsd, quoteToken, stables = USD_STABLES) {
  if (typeof sizeUsd !== 'number' || !Number.isFinite(sizeUsd) || sizeUsd <= 0) return null;
  // Bounded well below 1e21, where String() switches to exponent notation for
  // large numbers — a form decimalString deliberately does not accept.
  if (sizeUsd > 1e12) return null;
  const meta = stables.get(lower(quoteToken));
  if (!meta) return null;

  const decimal = decimalString(sizeUsd);
  if (decimal === null) return null;
  const [whole, frac = ''] = decimal.split('.');
  const kept = frac.slice(0, meta.decimals).padEnd(meta.decimals, '0');
  const units = BigInt(whole) * 10n ** BigInt(meta.decimals) + BigInt(kept || '0');
  return units > 0n ? units : null;
}

/**
 * A positive number as a plain decimal string, expanding exponent notation.
 *
 * The naive conversions both fail, in opposite directions, and both were written
 * here before this was:
 *
 *   toFixed(decimals)    ROUNDS, so 29.999999999 became $30.000000 — the ceiling
 *                        inverted rather than bent.
 *   toFixed(decimals+n)  cleans binary noise only at one magnitude. The noise
 *                        sits a fixed number of SIGNIFICANT digits in, not a
 *                        fixed number of decimal places, so the window that
 *                        fixed $29.99 left 0.000001 of an 18-decimal token
 *                        landing on 999999999999 instead of 1000000000000.
 *
 * String() has neither problem by construction: the spec requires the shortest
 * decimal string that round-trips to the same double, which is the number the
 * operator wrote. All that is left is expanding the exponent form it uses below
 * 1e-6, and truncating.
 */
export function decimalString(n) {
  const s = String(n);
  const m = /^(\d+)(?:\.(\d+))?e-(\d+)$/i.exec(s);
  if (!m) return /^\d+(\.\d+)?$/.test(s) ? s : null;
  const [, int, frac = '', exp] = m;
  const zeros = Number(exp) - int.length;
  if (zeros < 0) return null; // unreachable for a positive double, and not worth guessing at
  return '0.' + '0'.repeat(zeros) + int + frac;
}

/**
 * Quote, build, verify, simulate, and only then send.
 *
 * Every network call is injected. That is not test ceremony: it is what lets the
 * whole decision sequence — including the order the transactions go out in — be
 * asserted without a chain, a key or a funded wallet.
 *
 * @param {object} deps
 *   quote({tokenIn, tokenOut, amountIn})            -> routeSummary
 *   build({routeSummary, sender, recipient, slippageBps, deadline}) -> build
 *   getAllowance({token, owner, spender})           -> bigint
 *   getTokenBalance({token, owner})                 -> bigint
 *   getNativeBalance(owner)                         -> bigint
 *   getGasPrice()                                   -> bigint
 *   simulate({from, calls})                         -> array of call results
 *   send({to, data, gasLimit})                      -> {hash}
 *   waitReceipt(hash)                               -> receipt
 *
 * @returns {Promise<{ok:true, sent:boolean, ...} | {ok:false, reason:string, detail:any}>}
 */
export async function executeBuy(deps, {
  wallet, tokenIn, tokenOut, amountIn,
  slippageBps = 300,
  router = KYBER.router,
  paper = false,
  deadlineSecs = 120,
  gasBufferBps = 2500,
  maxOutputDriftBps = 300,
  now = Date.now(),
}) {
  for (const [name, value] of [['wallet', wallet], ['tokenIn', tokenIn], ['tokenOut', tokenOut], ['router', router]]) {
    if (!isAddress(value)) return refuse(REFUSE_SEND.BAD_ADDRESS, `${name}=${value}`);
  }
  if (lower(tokenIn) === lower(tokenOut)) return refuse(REFUSE_SEND.SAME_TOKEN, lower(tokenIn));
  if (NATIVE_SENTINELS.has(lower(tokenIn)) || NATIVE_SENTINELS.has(lower(tokenOut))) {
    return refuse(REFUSE_SEND.NATIVE_INPUT, NATIVE_SENTINELS.has(lower(tokenIn)) ? lower(tokenIn) : lower(tokenOut));
  }
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) return refuse(REFUSE_SEND.BAD_AMOUNT, String(amountIn));

  // Cheapest refusal first: no point quoting a trade we cannot fund.
  const inputBalance = await deps.getTokenBalance({ token: tokenIn, owner: wallet });
  if (typeof inputBalance !== 'bigint' || inputBalance < amountIn) {
    return refuse(REFUSE_SEND.NO_INPUT_BALANCE, { have: String(inputBalance), need: String(amountIn) });
  }

  const routeSummary = await deps.quote({ tokenIn, tokenOut, amountIn: amountIn.toString() });
  if (!routeSummary?.amountOut) return refuse(REFUSE_SEND.NO_QUOTE, null);

  // Our floor, from the QUOTE. Taking it from the build would let the build move
  // the bar it is being measured against.
  const minOut = minOutFor(routeSummary.amountOut, slippageBps);
  if (minOut === null || minOut <= 0n) return refuse(REFUSE_SEND.NO_FLOOR, routeSummary.amountOut);

  const build = await deps.build({
    routeSummary,
    sender: lower(wallet),
    recipient: lower(wallet),
    slippageBps,
    deadline: Math.floor(now / 1000) + deadlineSecs,
  });

  const checked = verifyBuild(build, routeSummary, { router, maxOutputDriftBps });
  if (!checked.ok) return refuse(REFUSE_SEND.BUILD_REFUSED, { reason: checked.reason, detail: checked.detail });

  const allowance = await deps.getAllowance({ token: tokenIn, owner: wallet, spender: router });
  const approvalMode = decideApproval(allowance, amountIn);

  const { calls, index } = buildSimulationCalls({
    wallet, tokenIn, tokenOut, amountIn, router, swapData: build.data, approvalMode,
  });

  const simulated = verifySimulation(
    readSimulation(await deps.simulate({ from: lower(wallet), calls }), index),
    { amountIn, minOut },
  );
  if (!simulated.ok) return simulated;

  const swapGasLimit = gasWithBuffer(simulated.swapGas, gasBufferBps);
  const approvalGasLimits = simulated.approvalGas.map((g) => gasWithBuffer(g, gasBufferBps));
  if (swapGasLimit === null || approvalGasLimits.some((g) => g === null)) {
    return refuse(REFUSE_SEND.SIM_UNREADABLE, 'a call we must send reported no gas');
  }

  const gasPrice = await deps.getGasPrice();
  if (typeof gasPrice !== 'bigint' || gasPrice <= 0n) return refuse(REFUSE_SEND.NO_GAS_PRICE, String(gasPrice));

  // Everything we are about to broadcast, not everything we simulated: the
  // balance reads cost nothing because they are never sent.
  const totalGas = approvalGasLimits.reduce((a, b) => a + b, swapGasLimit);
  const gasCost = totalGas * gasPrice;
  const nativeBalance = await deps.getNativeBalance(wallet);
  if (typeof nativeBalance !== 'bigint' || nativeBalance < gasCost) {
    return refuse(REFUSE_SEND.NO_GAS_BALANCE, { have: String(nativeBalance), need: String(gasCost) });
  }

  const plan = {
    wallet: lower(wallet),
    tokenIn: lower(tokenIn),
    tokenOut: lower(tokenOut),
    amountIn: String(amountIn),
    quotedOut: String(routeSummary.amountOut),
    minOut: String(minOut),
    simulatedOut: String(simulated.received),
    simulatedSpend: String(simulated.spent),
    approvalMode,
    router: lower(router),
    slippageBps,
    driftBps: checked.driftBps,
    swapGasLimit: String(swapGasLimit),
    approvalGasLimits: approvalGasLimits.map(String),
    gasPriceWei: String(gasPrice),
    gasCostWei: String(gasCost),
  };

  // Paper mode is not a stub. Every gate above has run against live state and
  // live prices; the only thing withheld is the signature. A refusal in paper
  // mode is a refusal that would have happened with money on it.
  if (paper) return { ok: true, sent: false, paper: true, plan };

  // Approve first, and wait for it. A swap broadcast before its approval is
  // mined is a swap that reverts and pays for the privilege.
  const approveHashes = [];
  for (const [i, amount] of approvalAmounts(approvalMode, amountIn).entries()) {
    const { hash } = await deps.send({
      to: lower(tokenIn),
      data: encodeApprove(router, amount),
      gasLimit: approvalGasLimits[i],
    });
    approveHashes.push(hash);
    const receipt = await deps.waitReceipt(hash);
    if (lower(receipt?.status) !== '0x1' && receipt?.status !== 1) {
      return refuse(REFUSE_SEND.APPROVE_REVERTED, { hash, amount: String(amount) });
    }
  }

  const { hash } = await deps.send({ to: lower(router), data: build.data, gasLimit: swapGasLimit });
  const receipt = await deps.waitReceipt(hash);
  if (lower(receipt?.status) !== '0x1' && receipt?.status !== 1) {
    return refuse(REFUSE_SEND.SWAP_REVERTED, { hash });
  }

  return { ok: true, sent: true, paper: false, plan, approveHashes, hash, receipt };
}
