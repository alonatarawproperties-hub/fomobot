#!/usr/bin/env node
// Point this at the token address you were given, BEFORE the launch.
//
//   node scripts/dbc-probe.mjs <mint> [--config <config>] [--rpc <url>]
//
// It answers the questions that decide whether a snipe is even possible, and it
// answers them from the chain rather than from anybody's assurances:
//
//   * does the pool exist yet, and if so what does the curve look like right now
//   * which config is it on — the one input a pool address cannot be derived
//     without, and therefore the one thing worth getting hold of in advance
//   * can the token be sold: freeze authority, transfer hooks, transfer fees
//   * with --config, the exact pool and vault addresses the launch WILL use,
//     derived before it happens
//
// Read-only. It signs nothing and needs no key.

import { readFileSync } from 'node:fs';
import { decodeBase58, isAddress } from '../src/base58.mjs';
import {
  DBC_PROGRAM, DAMM_V2_PROGRAM, WSOL, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, VIRTUAL_POOL_SIZE,
  decodeVirtualPool, decodePoolConfig, deriveLaunch, poolByMintFilters, dammV2PoolFilters,
} from '../src/meteora-dbc.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const mint = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

if (!mint || !isAddress(mint)) {
  console.error('usage: node scripts/dbc-probe.mjs <mint> [--config <config>] [--rpc <url>]');
  console.error(mint ? `\n"${mint}" does not decode to a 32-byte address.` : '');
  process.exit(2);
}

function defaultRpc() {
  try {
    const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
    if (cfg?.solana?.httpUrl && !cfg.solana.httpUrl.includes('YOUR_HELIUS_KEY')) return cfg.solana.httpUrl;
  } catch { /* no config yet is fine */ }
  return 'https://api.mainnet-beta.solana.com';
}
const RPC = flag('--rpc') ?? defaultRpc();

let nextId = 1;
async function rpc(method, params, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) { await sleep(900 * (i + 1)); continue; }
      const json = await res.json();
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    } catch (e) { lastErr = e; await sleep(600 * (i + 1)); }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (amount, decimals) => {
  const s = String(amount).padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals ? '.' + s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return Number(whole).toLocaleString('en-US') + (frac === '.' ? '' : frac);
};

console.log(`\nmint  ${mint}`);
console.log(`rpc   ${RPC.replace(/api-key=[^&]+/, 'api-key=…')}\n`);

// ---------------------------------------------------------------------------
// 1. the token itself
// ---------------------------------------------------------------------------
const mintAcc = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
const isMint = mintAcc?.value
  && (mintAcc.value.owner === TOKEN_PROGRAM || mintAcc.value.owner === TOKEN_2022_PROGRAM)
  && mintAcc.value.data?.parsed?.type === 'mint';

if (!mintAcc?.value) {
  console.log('TOKEN        does not exist yet.');
  console.log('             On Meteora DBC the mint is created by the launch transaction');
  console.log('             itself, so this is the expected state before a launch.');
} else if (!isMint) {
  // An address that exists but is not a mint is almost always a typo or the wrong
  // field copied out of a message. Reporting it as a token with 0 supply and no
  // authorities — which is what an earlier version of this did — reads like a
  // clean, safe token instead of a wrong address.
  console.log('TOKEN        ⚠ THIS ADDRESS IS NOT A TOKEN MINT.');
  console.log(`             It exists, but it is owned by ${mintAcc.value.owner}`);
  console.log(`             and parses as ${mintAcc.value.data?.parsed?.type ?? 'raw data'}, not a mint.`);
  console.log('             Check you were given the token address and not something else.');
} else {
  const info = mintAcc.value.data?.parsed?.info ?? {};
  const t22 = mintAcc.value.owner === TOKEN_2022_PROGRAM;
  console.log(`TOKEN        exists · ${t22 ? 'Token-2022' : 'SPL Token'} · decimals ${info.decimals}`);
  console.log(`             supply ${fmt(info.supply ?? 0, info.decimals ?? 0)}`);

  // Anything that can stop us selling later matters more than anything that
  // affects the entry, so these are reported as findings rather than trivia.
  const risks = [];
  if (info.mintAuthority) risks.push(`mint authority still live (${info.mintAuthority}) — supply can be inflated`);
  if (info.freezeAuthority) risks.push(`FREEZE AUTHORITY LIVE (${info.freezeAuthority}) — your balance can be frozen`);
  for (const e of info.extensions ?? []) {
    if (e.extension === 'transferHook' && e.state?.programId) {
      risks.push(`TRANSFER HOOK ${e.state.programId} — arbitrary code runs on every transfer, including your sell`);
    }
    if (e.extension === 'transferFeeConfig') {
      const bps = e.state?.newerTransferFee?.transferFeeBasisPoints;
      risks.push(`transfer fee ${bps} bps — charged on every transfer, and it can be raised`);
    }
    if (e.extension === 'permanentDelegate' && e.state?.delegate) {
      risks.push(`PERMANENT DELEGATE ${e.state.delegate} — can move your tokens without you`);
    }
    if (e.extension === 'defaultAccountState' && e.state?.accountState === 'frozen') {
      risks.push('default account state is FROZEN — new holders start unable to transfer');
    }
  }
  const meta = (info.extensions ?? []).find((e) => e.extension === 'tokenMetadata');
  if (meta?.state?.name) console.log(`             "${meta.state.name}" (${meta.state.symbol ?? '?'})`);
  console.log(`             authorities: mint=${info.mintAuthority ?? 'revoked'} freeze=${info.freezeAuthority ?? 'none'}`);
  if (risks.length) { console.log('\n  ⚠ SELL RISK'); for (const r of risks) console.log(`    - ${r}`); }
  else console.log('             no freeze authority, no transfer hook, no transfer fee');
}

// ---------------------------------------------------------------------------
// 2. the pool
// ---------------------------------------------------------------------------
console.log('');
const t0 = Date.now();
const pools = await rpc('getProgramAccounts', [DBC_PROGRAM, {
  encoding: 'base64', filters: poolByMintFilters(mint),
}]);
const took = Date.now() - t0;

if (!pools?.length) {
  console.log(`POOL         no DBC pool for this mint (looked up by memcmp in ${took}ms)`);
  const given = flag('--config');
  if (given && isAddress(given)) {
    const d = deriveLaunch(given, mint, WSOL);
    console.log('\n             With the config you supplied, the launch will use:');
    console.log(`               pool        ${d.pool}`);
    console.log(`               baseVault   ${d.baseVault}`);
    console.log(`               quoteVault  ${d.quoteVault}`);
    console.log(`               authority   ${d.poolAuthority}`);
    console.log('             These are derivable now, before the pool exists — which is');
    console.log('             what makes a same-slot entry possible at all.');
  } else {
    console.log('\n             Pass --config <config> to derive the pool address in advance.');
    console.log('             Without the config the pool address cannot be computed, and');
    console.log('             a bot can only react after the launch is already public.');
  }
} else {
  if (pools.length > 1) console.log(`POOL         ⚠ ${pools.length} pools share this mint; showing each`);
  for (const p of pools) {
    const raw = Buffer.from(p.account.data[0], 'base64');
    const pool = decodeVirtualPool(raw);
    console.log(`POOL         ${p.pubkey}   (found by memcmp in ${took}ms)`);
    console.log(`  config     ${pool.config}`);
    console.log(`  creator    ${pool.creator}`);
    console.log(`  baseVault  ${pool.baseVault}`);
    console.log(`  quoteVault ${pool.quoteVault}`);

    // Cross-check: the address must be re-derivable from what it contains. If it
    // is not, either the offsets or the derivation are wrong, and both would be
    // silently wrong for every future launch.
    const cfgRaw = await rpc('getAccountInfo', [pool.config, { encoding: 'base64' }]);
    let quoteMint = WSOL, quoteLabel = 'wSOL (assumed)';
    if (cfgRaw?.value) {
      try { quoteMint = decodePoolConfig(Buffer.from(cfgRaw.value.data[0], 'base64')).quoteMint;
        quoteLabel = quoteMint === WSOL ? 'wSOL' : quoteMint; } catch { /* keep the assumption, and say so */ }
    }
    console.log(`  quoteMint  ${quoteLabel}`);
    const derived = deriveLaunch(pool.config, pool.baseMint, quoteMint);
    console.log(`  derivation ${derived.pool === p.pubkey ? '✓ re-derives to this same address' : `✗ MISMATCH — derived ${derived.pool}`}`);

    // Curve state, from the vaults.
    const [bv, qv] = await Promise.all([
      rpc('getTokenAccountBalance', [pool.baseVault]).catch(() => null),
      rpc('getTokenAccountBalance', [pool.quoteVault]).catch(() => null),
    ]);
    // Has the curve already completed? A migrated pool keeps its account and its
    // history but holds dust, so reserves alone read like a dead launch rather than
    // a graduated one — and a spot price off drained vaults is nonsense. Ask DAMM
    // v2 directly instead of inferring.
    let migratedTo = null;
    for (const filters of dammV2PoolFilters(pool.baseMint)) {
      const hits = await rpc('getProgramAccounts', [DAMM_V2_PROGRAM, {
        encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters,
      }]).catch(() => []);
      if (hits?.length) { migratedTo = hits[0].pubkey; break; }
    }

    if (bv?.value && qv?.value) {
      const base = BigInt(bv.value.amount), quote = BigInt(qv.value.amount);
      console.log(`  reserves   base ${fmt(base, bv.value.decimals)} · quote ${fmt(quote, qv.value.decimals)}`);
      if (base > 0n && quote > 0n && !migratedTo) {
        // Spot only — the real curve is not a constant product, so this is a
        // sanity figure for "has anything traded", not a price to size a trade on.
        const price = Number(quote) / 10 ** qv.value.decimals / (Number(base) / 10 ** bv.value.decimals);
        console.log(`  spot       ~${price.toPrecision(6)} ${quoteLabel === 'wSOL' ? 'SOL' : 'quote'} per token (indicative only)`);
      }
      if (quote === 0n && !migratedTo) console.log('  status     NOTHING HAS TRADED YET — the curve is untouched');
    }

    if (migratedTo) {
      console.log('  status     MIGRATED — the curve has completed');
      console.log(`             DAMM v2 pool ${migratedTo}`);
      console.log('             The reserves above are leftover dust. Buying or selling now');
      console.log('             means DAMM v2, not Swap2 on the curve.');
    }

    // How busy is it?
    const sigs = await rpc('getSignaturesForAddress', [p.pubkey, { limit: 1000 }]).catch(() => []);
    console.log(`  activity   ${sigs.length}${sigs.length === 1000 ? '+' : ''} signatures on the pool`);
    if (sigs.length) {
      const oldest = sigs[sigs.length - 1];
      console.log(`             most recent ${new Date(sigs[0].blockTime * 1000).toISOString()}`);
      const errs = sigs.filter((s) => s.err).length;
      console.log(`             ${errs}/${sigs.length} of those failed${errs > sigs.length / 4 ? '  ← heavy contention' : ''}`);
    }
  }
}
console.log('');
