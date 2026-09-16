#!/usr/bin/env node
// Blind-snipe a Meteora curve launch whose token address is known in advance.
//
//   node scripts/snipe.mjs --config <config> --mint <mint> --sol 0.25 \
//        [--min-tokens N | --accept-any-price] [--priority-fee 500000] \
//        [--duration 300] [--rate 2] [--rpc <url>] [--arm]
//
// WITHOUT --arm IT SIGNS NOTHING. The default is a dry run that derives every
// address, builds the real transaction, prints what it would send and what the
// attempts would cost, and stops. That is the mode to use until the numbers look
// right, and it needs no key.
//
// Read the "ONE FILL, NOT HUNDREDS" note in src/sniper.mjs before arming this. The
// short version: it signs once per blockhash and re-sends identical bytes, so the
// network's signature dedupe caps the damage at one fill per ~40s generation, and
// the balance is re-checked before every new generation.

import { readFileSync } from 'node:fs';
import { isAddress } from '../src/base58.mjs';
import { WSOL, TOKEN_2022_PROGRAM, decodePoolConfig, poolByMintFilters, DBC_PROGRAM } from '../src/meteora-dbc.mjs';
import { keypairFromEnv } from '../src/sol-keys.mjs';
import { buildSnipePlans, estimateCost, shouldRefresh, shouldKeepFiring, LAMPORTS_PER_SOL } from '../src/sniper.mjs';
import { resignWithBlockhash } from '../src/sol-tx.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const die = (msg) => { console.error(`\n${msg}\n`); process.exit(2); };

const config = val('--config');
const mint = val('--mint');
const solStr = val('--sol');
const ARM = has('--arm');

if (!config || !mint || !solStr) {
  die('usage: node scripts/snipe.mjs --config <config> --mint <mint> --sol <amount> [--arm]\n' +
      '       --min-tokens N   floor in the token\'s smallest unit\n' +
      '       --accept-any-price   send with no floor (read the warning it prints)\n' +
      '       --priority-fee   micro-lamports per compute unit (default 0)\n' +
      '       --duration       seconds to keep trying (default 300)\n' +
      '       --rate           attempts per second (default 2)\n' +
      '       --arm            actually sign and send; omit for a dry run');
}
if (!isAddress(config)) die(`--config ${config} is not a 32-byte address`);
if (!isAddress(mint)) die(`--mint ${mint} is not a 32-byte address`);

const sol = Number(solStr);
if (!(sol > 0)) die(`--sol ${solStr} must be positive`);
const amountInLamports = BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));

// A floor has to be a decision, not a default. See buildSnipePlan.
let minTokensOut;
if (val('--min-tokens')) minTokensOut = BigInt(val('--min-tokens'));
else if (has('--accept-any-price')) minTokensOut = 0n;
else die('pass --min-tokens N, or --accept-any-price to send with no floor.\n' +
         'There is no default: on a launch with no price history a floor of 0 means\n' +
         'any fill is acceptable, including one that returns dust for the whole size.');

const priorityFee = Number(val('--priority-fee', '0'));
const computeUnitLimit = Number(val('--cu', '120000'));
const durationSec = Number(val('--duration', '300'));
const rate = Number(val('--rate', '2'));

function defaultRpc() {
  try {
    const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
    if (cfg?.solana?.httpUrl && !cfg.solana.httpUrl.includes('YOUR_HELIUS_KEY')) return cfg.solana.httpUrl;
  } catch { /* fine */ }
  return 'https://api.mainnet-beta.solana.com';
}
const RPC = val('--rpc', defaultRpc());

let rpcId = 1;
async function rpc(method, params, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json();
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    } catch (e) { last = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Check the config before doing anything expensive with it
// ---------------------------------------------------------------------------
console.log(`\nconfig ${config}`);
console.log(`mint   ${mint}`);
console.log(`rpc    ${RPC.replace(/api-key=[^&]+/, 'api-key=…')}\n`);

const cfgAcc = await rpc('getAccountInfo', [config, { encoding: 'base64' }]).catch(() => null);
if (!cfgAcc?.value) {
  die(`The config account does not exist.\n` +
      `A snipe derives the pool address from it, so a wrong or not-yet-created config\n` +
      `means every attempt would go to an address the launch will never use.`);
}
let quoteMint = WSOL;
try {
  quoteMint = decodePoolConfig(Buffer.from(cfgAcc.value.data[0], 'base64')).quoteMint;
} catch (e) {
  die(`That account is not a Meteora DBC PoolConfig (${e.message}).\n` +
      `It is owned by ${cfgAcc.value.owner}.`);
}
console.log(`config quotes ${quoteMint === WSOL ? 'wSOL' : quoteMint}`);
if (quoteMint !== WSOL) {
  die('This launch is not quoted in wSOL, and the funding path here wraps native SOL.\n' +
      'Sniping it needs a different quote-side build than this script does.');
}

// If the pool already exists the race is over; say so rather than spamming.
const existing = await rpc('getProgramAccounts', [DBC_PROGRAM, {
  encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: poolByMintFilters(mint),
}]).catch(() => []);
if (existing?.length) {
  console.log(`\n⚠ THE POOL ALREADY EXISTS: ${existing[0].pubkey}`);
  console.log('  The launch has happened. A blind snipe is pointless now — run');
  console.log('  scripts/dbc-probe.mjs to price it and decide like any other buy.');
  if (ARM) die('Refusing to arm against a pool that already exists.');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
let keypair = null;
let payer = val('--payer');
if (ARM) {
  try { keypair = keypairFromEnv(); } catch (e) { die(`${e.message}\nThe key is read from FIRSTFILL_SOLANA_KEY only, never from config.json.`); }
  payer = keypair.address;
} else if (!payer) {
  // A dry run still needs an address to derive ATAs from. Use the key if it
  // happens to be set, otherwise let the operator pass one.
  try { payer = keypairFromEnv().address; } catch { /* fall through */ }
  if (!payer) die('For a dry run, pass --payer <address> (or set FIRSTFILL_SOLANA_KEY).');
}

const variants = buildSnipePlans({
  config, baseMint: mint, payer, amountInLamports, minTokensOut,
  computeUnitLimit, priorityFeeMicroLamports: priorityFee, quoteMint,
});

const attempts = Math.max(1, Math.round(durationSec * rate));
const cost = estimateCost({ attempts, computeUnitLimit, priorityFeeMicroLamports: priorityFee, variants: variants.length });

console.log(`\npayer  ${payer}`);
console.log(`pool   ${variants[0].plan.pool}   (derived; does not exist yet)`);
for (const v of variants) {
  console.log(`  ${v.label.padEnd(10)} base ATA ${v.plan.payerBaseAccount}`);
}
console.log(`\nspend per fill   ${sol} SOL`);
console.log(`floor            ${minTokensOut === 0n ? 'NONE — any fill accepted' : `${minTokensOut} (smallest unit)`}`);
console.log(`priority fee     ${priorityFee} microLamports/CU · CU limit ${computeUnitLimit}`);
console.log(`plan             ${rate}/s for ${durationSec}s = ${attempts} attempts x ${variants.length} variants`);
console.log(`fees if none fill  ~${cost.totalSol.toFixed(6)} SOL (${cost.perAttemptLamports} lamports each)`);
console.log(`wallet needs       ~${(sol + cost.totalSol + 0.005).toFixed(4)} SOL to cover a fill plus all fees`);

if (minTokensOut === 0n) {
  console.log('\n⚠ NO FLOOR. Whatever the curve gives back is accepted, including dust.');
}

if (!ARM) {
  console.log('\nDRY RUN — nothing was signed or sent. Add --arm to go live.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------
const balance = await rpc('getBalance', [payer]).catch(() => null);
const have = BigInt(balance?.value ?? 0);
const need = amountInLamports + cost.totalLamports + cost.rentHeadroomLamports;
console.log(`\nwallet balance ${Number(have) / Number(LAMPORTS_PER_SOL)} SOL`);
if (have < need) {
  die(`Not enough SOL: need ~${Number(need) / Number(LAMPORTS_PER_SOL)} to cover the buy, the fees and\n` +
      `token-account rent. Fund the wallet or lower --sol / --duration / --rate.`);
}

const compiled = variants.map((v) => ({ ...v, compiled: v.plan.compile('11111111111111111111111111111111'), signed: null }));
const deadline = Date.now() + durationSec * 1000;
let signedAt = null, sent = 0, filled = false, fillSig = null;

/** Have we actually got the tokens? The only trustworthy stop condition. */
async function checkFilled() {
  for (const v of compiled) {
    const bal = await rpc('getTokenAccountBalance', [v.plan.payerBaseAccount]).catch(() => null);
    const amount = bal?.value?.amount ? BigInt(bal.value.amount) : 0n;
    if (amount > 0n) return { filled: true, variant: v.label, amount, decimals: bal.value.decimals };
  }
  return { filled: false };
}

console.log(`\nARMED. sending until ${new Date(deadline).toISOString()} or a fill.\n`);
process.on('SIGINT', () => { console.log('\ninterrupted; stopping.'); process.exit(130); });

while (true) {
  const now = Date.now();
  const keep = shouldKeepFiring({ now, filled, deadline, attempts: sent, maxAttempts: attempts * variants.length });
  if (!keep.fire) { console.log(`\nstopped: ${keep.reason}`); break; }

  const refresh = shouldRefresh({ now, signedAt, filled, deadline });
  if (refresh.refresh) {
    // Before opening a NEW signature, make sure the old one did not already fill.
    // This is the guard on the only window where duplicate-fill is possible.
    if (signedAt !== null) {
      const f = await checkFilled();
      if (f.filled) { filled = true; fillSig = `balance ${f.amount}`; console.log(`\nFILLED (${f.variant}): ${f.amount} raw units`); break; }
    }
    const bh = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }]).catch(() => null);
    if (!bh?.value?.blockhash) { await new Promise((r) => setTimeout(r, 300)); continue; }
    for (const v of compiled) v.signed = resignWithBlockhash(v.compiled, bh.value.blockhash, keypair);
    signedAt = Date.now();
    console.log(`[${new Date().toISOString()}] signed generation on ${bh.value.blockhash.slice(0, 12)}… ` +
      compiled.map((v) => `${v.label}=${v.signed.signature.slice(0, 10)}…`).join(' '));
  }

  await Promise.all(compiled.map(async (v) => {
    if (!v.signed) return;
    sent++;
    // skipPreflight because the pool does not exist yet: preflight would simulate,
    // fail, and refuse to forward the one transaction we need forwarded.
    await rpc('sendTransaction', [v.signed.base64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }], 1)
      .catch(() => { /* expected until the pool exists */ });
  }));

  await new Promise((r) => setTimeout(r, Math.max(50, 1000 / rate)));
}

if (!filled) {
  const f = await checkFilled();
  if (f.filled) { filled = true; console.log(`\nFILLED (${f.variant}): ${f.amount} raw units`); }
}
console.log(`\nattempts sent ${sent}${filled ? '' : ' — no fill'}`);
if (filled) {
  console.log('\nYOU NOW HOLD A POSITION AND NOTHING HERE WILL SELL IT.');
  console.log('There is no exit path in this project yet — see the README. Check the token');
  console.log('with scripts/dbc-probe.mjs and be aware a completed curve migrates to DAMM v2.');
}
console.log('');
