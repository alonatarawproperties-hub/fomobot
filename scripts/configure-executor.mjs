// Point the executor at a wallet, without hand-editing JSON.
//
//   node scripts/configure-executor.mjs 0xYourWalletAddress
//
// Writes only the executor block and leaves everything else in config.json
// exactly as it was. It never asks for, accepts, or writes a private key — the
// key is read from FIRSTFILL_PRIVATE_KEY at runtime and a key found in the
// config file is a startup failure.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { getAddress, isAddress } from 'ethers';
import { USD_STABLES } from '../src/chain/robinhood.mjs';

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

const arg = (process.argv[2] ?? '').trim();
if (!arg) die('usage: node scripts/configure-executor.mjs 0xYourWalletAddress');

// The mistake worth catching at the door: pasting the KEY line instead of the
// ADDRESS line. Both start 0x, and the only visible difference is length — so
// without this the key lands in config.json, which is the one place the whole
// design exists to keep it out of.
if (/^0x[0-9a-fA-F]{64}$/.test(arg)) {
  die('That is a PRIVATE KEY (64 hex characters), not an address (40).\n' +
      '  Do not put it here, and do not paste it into a chat. If it has already been\n' +
      '  shared anywhere, treat that wallet as burned and generate a new one.\n' +
      '  The address is the shorter line that new-wallet printed.');
}
if (!isAddress(arg)) die(`"${arg}" is not a wallet address.`);

const wallet = getAddress(arg); // throws on a mistyped checksum rather than trusting it

const path = process.argv[3] ?? './config.json';
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
    size          $${ex.sizeUsd} per copy
    max positions ${ex.maxOpenPositions}   -> at most $${ex.sizeUsd * ex.maxOpenPositions} can ever be spent
    slippage      ${ex.slippageBps / 100}%
    mode          ${ex.paper === false ? 'LIVE - it will spend real money' : 'PAPER - signs nothing'}

  Next:
    1. bridge ${stable.symbol} and a little ETH to the wallet above
    2. npm run paper
`);
