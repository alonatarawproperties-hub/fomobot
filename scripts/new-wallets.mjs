#!/usr/bin/env node
// Generate snipe wallets, and write their keys where only this machine can read.
//
//   node scripts/new-wallets.mjs 4                 # four new wallets
//   node scripts/new-wallets.mjs 4 --file ~/.fomobot.env
//   node scripts/new-wallets.mjs 4 --start 2       # name them _2 .. _5
//
// SECRETS NEVER REACH A TERMINAL THIS PRINTS TO, and never a chat window. Only
// the public addresses are shown — those are what you fund and what you paste to
// anyone helping. The keys are appended to an env file created 0600.
//
// Existing variables are never overwritten. A run that would clobber a key you
// already have refuses instead, because the wallet holding your money is not
// recoverable from a file you just replaced.

import { appendFileSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };

const count = Number(positional[0] ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 50) {
  console.error('usage: node scripts/new-wallets.mjs <count> [--file <path>] [--start <n>] [--prefix <VAR>]');
  console.error('count must be between 1 and 50');
  process.exit(1);
}

const file = (flag('file') ?? `${homedir()}/.fomobot.env`).replace(/^~/, homedir());
const prefix = flag('prefix') ?? 'FIRSTFILL_SOLANA_KEY';
const start = Number(flag('start') ?? 2);

const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
if (!existsSync(file)) { writeFileSync(file, '', { mode: 0o600 }); }
chmodSync(file, 0o600);

// Name the variables first and check every one, so a collision is found before
// anything is generated rather than half way through.
const names = [];
for (let i = 0; i < count; i++) names.push(`${prefix}_${start + i}`);

const clashes = names.filter((n) => new RegExp(`^\\s*(export\\s+)?${n}=`, 'm').test(existing));
if (clashes.length) {
  console.error(`refusing: ${file} already defines ${clashes.join(', ')}`);
  console.error('those wallets may hold funds. Use --start to pick free numbers, or --prefix for a separate set.');
  process.exit(1);
}

const lines = [];
const addresses = [];
for (const name of names) {
  const kp = Keypair.generate();
  lines.push(`export ${name}='${bs58.encode(kp.secretKey)}'`);
  addresses.push({ name, address: kp.publicKey.toBase58() });
}

appendFileSync(file, (existing.endsWith('\n') || !existing ? '' : '\n') + lines.join('\n') + '\n');
chmodSync(file, 0o600);

console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'wallets created', file, count }, null, 0));
for (const a of addresses) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'wallet', keyEnv: a.name, address: a.address }));
}
console.log();
console.log('FUND THESE ADDRESSES. Then:  source ' + file);
console.log('The secret keys are in that file and nowhere else — back it up before you fund anything.');
