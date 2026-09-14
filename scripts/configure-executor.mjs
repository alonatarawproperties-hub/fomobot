// Point the executor at a wallet, without hand-editing JSON.
//
//   node scripts/configure-executor.mjs 0xYourWalletAddress [options]
//
//     --size 450        dollars per copy
//     --positions 1     how many positions the bot may ever hold
//     --full-balance    treat --size as a CEILING and spend up to the wallet
//                       balance, so a balance a fraction short does not refuse
//     --slippage 300    basis points
//
// Writes only the executor block and leaves everything else in config.json
// exactly as it was. It never asks for, accepts, or writes a private key — the
// key is read from FIRSTFILL_PRIVATE_KEY at runtime and a key found in the
// config file is a startup failure.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { getAddress, isAddress } from 'ethers';
import { USD_STABLES } from '../src/chain/robinhood.mjs';

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

// Flags are pulled out first, with their values, so what remains is positional:
// the address, and optionally a config path. Reading the path off a fixed
// argv index broke the moment flags existed -- it picked up "--size".
const raw = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--size', '--positions', '--slippage']);
const BOOL_FLAGS = new Set(['--full-balance']);

const flags = {};
const positional = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (VALUE_FLAGS.has(a)) {
    const v = Number(raw[++i]);
    if (!Number.isFinite(v) || v <= 0) die(`${a} needs a positive number`);
    flags[a] = v;
  } else if (BOOL_FLAGS.has(a)) {
    flags[a] = true;
  } else if (a.startsWith('--')) {
    die(`unknown option ${a}`);
  } else {
    positional.push(a);
  }
}

const arg = (positional[0] ?? '').trim();
if (!arg) die('usage: node scripts/configure-executor.mjs 0xYourWalletAddress [--size N] [--positions N] [--full-balance] [--slippage BPS] [config.json]');

const opts = {
  sizeUsd: flags['--size'],
  maxOpenPositions: flags['--positions'],
  slippageBps: flags['--slippage'],
  useFullBalance: flags['--full-balance'],
};

const wallet = getAddress(arg); // throws on a mistyped checksum rather than trusting it

const path = positional[1] ?? './config.json';
if (!existsSync(path)) die(`${path} does not exist. Copy config.example.json to config.json first.`);

const config = JSON.parse(readFileSync(path, 'utf8'));
const [quoteToken, stable] = [...USD_STABLES.entries()][0];

// Preserve anything already configured; only fill in what is missing.
const existing = config.executor ?? {};
config.executor = {
  paper: true,                 // never armed by this script — that is a separate, deliberate edit
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  sizeUsd: 25,
  slippageBps: 300,
  maxOutputDriftBps: 300,
  quoteRetryMs: 15000,
  maxOpenPositions: 3,
  cooldownMs: 60000,
  denylistTokens: [],
  ...existing,
  // Flags win over both the defaults and whatever was already in the file: an
  // explicit flag is the operator saying so now.
  ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  // These three are the point of the run, so they win over whatever was there.
  // `enabled` in particular: config.example.json ships it false, so preserving
  // the existing value meant this script printed a cheerful summary and left the
  // executor switched OFF — the bot would then start, alert normally, and never
  // trade, with nothing anywhere saying why.
  enabled: true,
  wallet,
  quoteToken,
};

copyFileSync(path, `${path}.bak`);
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');

const ex = config.executor;
console.log(`
  executor configured in ${path}   (previous version saved to ${path}.bak)

    executor      ${ex.enabled ? 'ON' : 'OFF'}
    wallet        ${ex.wallet}
    buys with     ${stable.symbol}  (${ex.quoteToken})
    size          $${ex.sizeUsd} per copy${ex.useFullBalance ? ' (a ceiling: spends up to this, or the whole balance if lower)' : ''}
    max positions ${ex.maxOpenPositions}   -> at most $${ex.sizeUsd * ex.maxOpenPositions} can ever be spent
    slippage      ${ex.slippageBps / 100}%
    mode          ${ex.paper === false ? 'LIVE - it will spend real money' : 'PAPER - signs nothing'}

  Next:
    1. bridge ${stable.symbol} and a little ETH to the wallet above
    2. npm run paper
`);
