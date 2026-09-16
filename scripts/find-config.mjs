#!/usr/bin/env node
// Recover a DBC config from a token that has ALREADY launched.
//
//   node scripts/find-config.mjs <mint-that-already-launched>
//   node scripts/find-config.mjs <mint> --http <rpc-url>     # before config.json exists
//
// WHY THIS BEATS ASKING. Every DBC pool stores the config it was created against,
// at a known offset inside its own account. Launchpads reuse one config for every
// token they launch. So one earlier mint from the same launchpad yields the config
// the NEXT launch will use — no one has to answer a message, and the answer is
// read off the chain rather than taken on trust.
//
// It also does something the offline suite cannot: it proves the base_mint offset
// and the VirtualPool layout against REAL mainnet accounts. The memcmp below is
// the exact filter the sniper arms with. If this finds a pool, that filter works
// on this endpoint, against this program, today.
//
// Reads only. Nothing signs, sends or spends.

import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import {
  DBC_PROGRAM_ID, VIRTUAL_POOL, POOL_CONFIG,
  decodeVirtualPool, decodePoolConfig, decodeBaseFee, feePercent,
  tokenProgramFor, derivePoolAddress,
} from '../src/meteora/dbc.mjs';
import { rpc, getAccount } from '../src/meteora/rpc.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
const die = (m) => { log('error', m); process.exit(1); };

if (!positional.length) {
  console.error('usage: node scripts/find-config.mjs <mint-that-already-launched> [--http <rpc-url>]');
  console.error('give it any token the SAME launchpad has already launched.');
  process.exit(1);
}

let mint;
try { mint = new PublicKey(positional[0]); }
catch { die(`"${positional[0]}" is not a valid address`); }

const path = process.env.FIRSTFILL_CONFIG ?? './config.json';
let httpUrl = flag('http');
if (!httpUrl) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    httpUrl = raw.snipe?.httpUrl ?? raw.solana?.httpUrl;
  } catch { /* fall through to the error below */ }
}
if (!httpUrl) die(`no httpUrl — set one in ${path}, or pass --http <url>`);

log('info', 'searching', { mint: mint.toBase58(), program: DBC_PROGRAM_ID.toBase58() });

// The same filter the sniper subscribes with, asked as a one-off query.
const { result, error } = await rpc(httpUrl, 'getProgramAccounts', [
  DBC_PROGRAM_ID.toBase58(),
  {
    encoding: 'base64',
    commitment: 'confirmed',
    filters: [
      { dataSize: VIRTUAL_POOL.SIZE },
      { memcmp: { offset: VIRTUAL_POOL.BASE_MINT, bytes: mint.toBase58() } },
    ],
  },
], { timeoutMs: 30000 });

if (error) die(`getProgramAccounts failed: ${error.message}`);
if (!result?.length) {
  log('error', 'no DBC pool found for that mint', {
    meaning: 'either it has not launched on a Meteora bonding curve, it already migrated off the curve, or it is not a DBC token at all',
  });
  process.exit(1);
}
if (result.length > 1) log('warn', 'more than one pool matched', { count: result.length });

const [entry] = result;
const poolAddress = entry.pubkey;
const pool = decodeVirtualPool(Buffer.from(entry.account.data[0], 'base64'));

log('info', 'pool found', {
  pool: poolAddress,
  creator: pool.creator.toBase58(),
  baseReserve: pool.baseReserve.toString(),
  quoteReserve: pool.quoteReserve.toString(),
});

// The prize.
log('signal', 'CONFIG', { config: pool.config.toBase58() });

const cfgAccount = await getAccount(httpUrl, pool.config.toBase58(), { commitment: 'confirmed' });
if (!cfgAccount) die('the pool names a config that does not exist — that should be impossible, stop and investigate');
if (cfgAccount.owner !== DBC_PROGRAM_ID.toBase58()) {
  die(`the config is owned by ${cfgAccount.owner}, not the DBC program — stop and investigate`);
}
if (cfgAccount.data.length !== POOL_CONFIG.SIZE) {
  die(`config is ${cfgAccount.data.length} bytes, expected ${POOL_CONFIG.SIZE} — Meteora may have changed the layout, do NOT arm against this`);
}
const cfg = decodePoolConfig(cfgAccount.data);

log('info', 'config says', {
  quoteMint: cfg.quoteMint.toBase58(),
  baseTokenProgram: tokenProgramFor(cfg.tokenType).toBase58(),
  baseDecimals: cfg.tokenDecimal,
});

// WHAT THE FIRST BLOCK ACTUALLY COSTS.
//
// The base fee starts at the cliff — its highest value — and steps down over
// time. Period 0 is the launch instant, so a first-block buyer pays the maximum
// by construction. That is not a side effect; it is the anti-sniper design, and
// it is aimed squarely at what this bot does. Read it before deciding the snipe
// is worth making.
const fee = decodeBaseFee(cfgAccount.data);
const unit = cfg.activationType === 0 ? 'slots' : 'seconds';

log('signal', 'FEE SCHEDULE', {
  mode: fee.modeName,
  firstBuyPaysPercent: feePercent(fee.firstBuyFeeNumerator),
  settlesAtPercent: feePercent(fee.finalFeeNumerator),
  periods: fee.numberOfPeriod,
  periodLength: `${fee.periodFrequency} ${unit}`,
  fullDecayAfter: fee.scheduled ? `${fee.periodFrequency * BigInt(fee.numberOfPeriod)} ${unit}` : 'no schedule — flat',
  enableFirstSwapWithMinFee: Boolean(cfgAccount.data[POOL_CONFIG.ENABLE_FIRST_SWAP_WITH_MIN_FEE]),
});

if (fee.scheduled) {
  // A few points along the curve, so the trade-off is a table rather than a
  // formula: this is what waiting buys you.
  const marks = [0, 1, 2, 5, 10, 30, fee.numberOfPeriod].filter((v, i, a) => a.indexOf(v) === i && v <= fee.numberOfPeriod);
  log('info', 'fee by arrival time', Object.fromEntries(marks.map((p) => [
    `after ${fee.periodFrequency * BigInt(p)} ${unit}`, `${feePercent(fee.feeAtPeriod(p))}%`,
  ])));

  const cost = feePercent(fee.firstBuyFeeNumerator) - feePercent(fee.finalFeeNumerator);
  if (cost > 0) {
    log('warn', 'what being first costs you', {
      extraFeePercentagePoints: Number(cost.toFixed(4)),
      meaning: `buying in the first block costs ${cost.toFixed(2)} percentage points more than waiting ${fee.periodFrequency * BigInt(fee.numberOfPeriod)} ${unit}`,
    });
  }
}

// THE PROOF. Re-derive this pool's address from (config, mints) alone. If it
// matches the address the cluster served, then every PDA the pre-armed snipe
// depends on is being computed correctly against real mainnet data — which no
// offline test can establish.
const rederived = derivePoolAddress(pool.config, pool.baseMint, cfg.quoteMint);
if (rederived.toBase58() === poolAddress) {
  log('info', 'PDA DERIVATION VERIFIED AGAINST MAINNET', {
    derived: rederived.toBase58(),
    actual: poolAddress,
    meaning: 'the pre-armed path computes the right pool address for real pools',
  });
} else {
  log('error', 'DERIVATION MISMATCH — DO NOT ARM', {
    derived: rederived.toBase58(),
    actual: poolAddress,
    meaning: 'the seeds in dbc.mjs do not match what this pool actually used',
  });
  process.exit(1);
}

console.log();
log('info', 'put this in config.json', {
  'snipe.config': pool.config.toBase58(),
  'snipe.quoteMint': cfg.quoteMint.toBase58(),
  caveat: 'valid only if YOUR launch uses the same launchpad and the same config. `plan` re-checks it.',
});
