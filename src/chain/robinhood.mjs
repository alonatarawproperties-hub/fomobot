// Robinhood Chain (Arbitrum Orbit L2, chainId 4663, ETH as gas token).
//
// PROVENANCE. Every address here was confirmed against the chain on 2026-09-12
// rather than copied from a page, because a wrong router address does not throw
// — it sends real funds somewhere real.
//
//   eth_getCode returned real bytecode at all five (16-49 KB of JSON each), while
//   a control address returned "0x", so the check actually discriminates.
//
//   SwapRouter02.factory() -> 0x1f7d7550...fd2efa
//   QuoterV2.factory()     -> 0x1f7d7550...fd2efa   (same)
//   Both match the published factory, which is what makes this set
//   self-consistent instead of merely transcribed.
//
//   SwapRouter02.WETH9()   -> 0x0bd7d308...acad73
//   QuoterV2.WETH9()       -> 0x0bd7d308...acad73   (same)
//   WETH is absent from Uniswap's deployment table for this chain. It is read
//   here out of the contracts that will actually use it, which is stronger than
//   any published list.
//
// v4 is live on this chain but its addresses are not in the v3 deployment table
// and are NOT recorded here. Do not guess them — verify the same way first.

export const CHAIN_ID = 4663;

export const ADDRESSES = {
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
};

// Quote tokens a USD trade size may be denominated in, with the decimals to
// convert with. Confirmed on chain 2026-09-14 by calling symbol() and decimals()
// on each rather than reading a token list: USDG -> "USDG"/6.
//
// It is an ALLOWLIST, and that is the point. `sizeUsd * 10**decimals` is only a
// dollar amount if the token is worth a dollar; the same arithmetic against WETH
// (also 18 decimals and also a quote token on this chain, per
// robinhood-trade.mjs) would turn a $25 trade into 25 ETH. An unknown quote token
// must therefore fail closed rather than be converted at an assumed price.
export const USD_STABLES = new Map([
  ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', { symbol: 'USDG', decimals: 6 }],
]);

// Uniswap v3 fee tiers, in hundredths of a basis point.
export const FEE_TIERS = [100, 500, 3000, 10000];

// Function selectors used for the boot check. Derived once, written out, and
// asserted against the chain rather than trusted: keccak("factory()")[0..4] and
// keccak("WETH9()")[0..4].
export const SELECTOR = {
  factory: '0xc45a0155',
  weth9: '0x4aa4a4fc',
};

const norm = (s) => String(s ?? '').toLowerCase();

/** An eth_call return value is a 32-byte word; an address is its low 20 bytes. */
export function addressFromWord(word) {
  const hex = norm(word).replace(/^0x/, '');
  if (hex.length < 40) return null;
  return '0x' + hex.slice(-40);
}

/**
 * Re-prove the address set at boot. Refuses to start on any mismatch.
 *
 * `deps.call({ to, data })` resolves to the raw hex return of an eth_call, and
 * `deps.getCode(address)` to the deployed bytecode. Both may throw; a throw is
 * a failure, never a pass — an address set that cannot be verified is one that
 * has not been verified.
 *
 * @returns {Promise<{ok:true} | {ok:false, problems:string[]}>}
 */
export async function assertAddresses(deps, addresses = ADDRESSES) {
  const problems = [];

  for (const [name, addr] of Object.entries(addresses)) {
    let code;
    try {
      code = await deps.getCode(addr);
    } catch (err) {
      problems.push(`${name}: could not read code (${err?.message ?? err})`);
      continue;
    }
    // An EOA or an empty slot returns "0x". Sending a swap to one is a silent loss.
    if (!code || code === '0x' || code.length < 4) {
      problems.push(`${name} (${addr}) has no bytecode — not a deployed contract`);
    }
  }

  // The cross-check. Each contract names its own factory; if either disagrees
  // with ours, the set is from a different deployment or a different chain, and
  // quoting against one while swapping through the other prices the wrong pools.
  for (const name of ['swapRouter02', 'quoterV2']) {
    for (const [field, selector] of [['factory', SELECTOR.factory], ['weth', SELECTOR.weth9]]) {
      let word;
      try {
        word = await deps.call({ to: addresses[name], data: selector });
      } catch (err) {
        problems.push(`${name}.${field}(): call failed (${err?.message ?? err})`);
        continue;
      }
      const got = addressFromWord(word);
      if (!got) {
        problems.push(`${name}.${field}(): unreadable return`);
      } else if (got !== norm(addresses[field])) {
        problems.push(`${name}.${field}() = ${got}, expected ${norm(addresses[field])}`);
      }
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true };
}
