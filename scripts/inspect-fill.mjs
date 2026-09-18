#!/usr/bin/env node
// Read a landed snipe and replace the guesses with what it actually cost.
//
//   node scripts/inspect-fill.mjs <signature>
//
// The compute budget and the priority fee are configured ahead of a launch, when
// nothing is known, so they start as round numbers picked to be safely too big.
// A fill settles them: the transaction records the units it really consumed and
// the lamports it really paid, and both can be read back.
//
// Also answers the question the log cannot: WHICH SLOT the pool was created in
// versus the slot we landed in. Equal means the buy shared a block with the
// launch, which is the ceiling for this strategy and worth confirming rather
// than inferring from two log lines that happen to agree.
//
// Reads only.

import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { DBC_PROGRAM_ID, VIRTUAL_POOL, decodeVirtualPool } from '../src/meteora/dbc.mjs';
import { rpc } from '../src/meteora/rpc.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
const die = (m) => { log('error', m); process.exit(1); };

if (!positional.length) {
  console.error('usage: node scripts/inspect-fill.mjs <signature> [--http <rpc-url>]');
  process.exit(1);
}
const signature = positional[0];

const path = process.env.FIRSTFILL_CONFIG ?? './config.json';
let cfg = {};
let httpUrl = flag('http');
try {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  cfg = raw.snipe ?? {};
  httpUrl = httpUrl ?? cfg.httpUrl ?? raw.solana?.httpUrl;
} catch { /* config is optional here */ }
if (!httpUrl) die(`no httpUrl — set one in ${path}, or pass --http <url>`);

const { result: tx, error } = await rpc(httpUrl, 'getTransaction', [
  signature,
  { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' },
], { timeoutMs: 20000 });

if (error) die(`getTransaction: ${error.message}`);
if (!tx) die('transaction not found — it may be too old for this endpoint, or never landed');

const meta = tx.meta ?? {};
if (meta.err) log('error', 'THE TRANSACTION FAILED ON CHAIN', { err: meta.err });

log('info', 'landed', {
  slot: tx.slot,
  blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
});

// ---------------------------------------------------------------------------
// What it cost, against what was budgeted.
// ---------------------------------------------------------------------------
const used = meta.computeUnitsConsumed ?? null;
const budget = cfg.computeUnitLimit ?? null;
const price = cfg.computeUnitPriceMicroLamports ?? null;

if (used !== null) {
  const headroom = budget ? budget - used : null;
  log('signal', 'COMPUTE', {
    unitsConsumed: used,
    unitsBudgeted: budget,
    unusedHeadroom: headroom,
    // The priority fee is charged on the LIMIT, not on what was used — so an
    // oversized budget is money paid for nothing on every single attempt.
    overpaidLamports: (budget && price) ? Math.round((budget - used) * price / 1e6) : null,
  });
  if (budget && used) {
    // MARGIN IS NOT A ROUNDING CHOICE HERE.
    //
    // The instinct is to trim to the observed peak plus a little, the way you
    // would for a transaction that runs a thousand times a day. This one runs
    // ONCE, on an event that does not repeat, and exceeding the limit does not
    // cost a retry — it fails the snipe outright. Meanwhile the money at stake in
    // trimming is a fraction of a cent.
    //
    // So the multiple is deliberately generous: a curve shaped differently, an
    // account that already exists, a token program with a transfer hook, all move
    // consumption without warning. 2.5x the observed peak, floored at 60k.
    const suggested = Math.max(60_000, Math.ceil((used * 2.5) / 10_000) * 10_000);
    const saving = price ? Math.round((budget - suggested) * price / 1e6) : null;
    log('info', 'suggested computeUnitLimit', {
      value: suggested,
      why: `${used} consumed; 2.5x margin because exceeding the limit fails the snipe and the launch does not repeat`,
      savesLamportsPerAttempt: saving,
      savesSol: saving != null ? saving / 1e9 : null,
      warning: 'do NOT trim this to just above the observed peak — the saving is a fraction of a cent, the failure is the whole entry',
    });
  }
}

log('signal', 'FEE PAID', {
  totalLamports: meta.fee ?? null,
  totalSol: meta.fee != null ? meta.fee / 1e9 : null,
});

// ---------------------------------------------------------------------------
// What was actually bought.
// ---------------------------------------------------------------------------
const pre = meta.preTokenBalances ?? [];
const post = meta.postTokenBalances ?? [];
const byKey = new Map();
for (const b of pre) byKey.set(`${b.mint}:${b.owner}`, { mint: b.mint, owner: b.owner, pre: BigInt(b.uiTokenAmount?.amount ?? '0'), post: 0n, decimals: b.uiTokenAmount?.decimals ?? 0 });
for (const b of post) {
  const k = `${b.mint}:${b.owner}`;
  const e = byKey.get(k) ?? { mint: b.mint, owner: b.owner, pre: 0n, post: 0n, decimals: b.uiTokenAmount?.decimals ?? 0 };
  e.post = BigInt(b.uiTokenAmount?.amount ?? '0');
  byKey.set(k, e);
}
const moved = [...byKey.values()]
  .map((e) => ({ ...e, delta: e.post - e.pre }))
  .filter((e) => e.delta !== 0n);

for (const m of moved) {
  const human = Number(m.delta) / 10 ** m.decimals;
  log('info', 'token moved', {
    mint: m.mint,
    owner: m.owner,
    delta: m.delta.toString(),
    human: human.toLocaleString('en-US', { maximumFractionDigits: m.decimals }),
    direction: m.delta > 0n ? 'received' : 'spent',
  });
}

// ---------------------------------------------------------------------------
// Did we share a block with the launch?
// ---------------------------------------------------------------------------
const configuredMint = cfg.mint;
if (configuredMint) {
  const { result: pools } = await rpc(httpUrl, 'getProgramAccounts', [
    DBC_PROGRAM_ID.toBase58(),
    {
      encoding: 'base64', commitment: 'confirmed',
      filters: [
        { dataSize: VIRTUAL_POOL.SIZE },
        { memcmp: { offset: VIRTUAL_POOL.BASE_MINT, bytes: new PublicKey(configuredMint).toBase58() } },
      ],
    },
  ], { timeoutMs: 20000 });

  if (pools?.length) {
    const pool = decodeVirtualPool(Buffer.from(pools[0].account.data[0], 'base64'));
    // The signature that CREATED the pool, so its slot can be compared with ours
    // rather than trusting two log lines that happen to agree.
    const { result: sigs } = await rpc(httpUrl, 'getSignaturesForAddress', [
      pools[0].pubkey, { limit: 1000 },
    ], { timeoutMs: 20000 });

    const oldest = sigs?.length ? sigs[sigs.length - 1] : null;
    if (oldest) {
      log('signal', 'BLOCK POSITION', {
        poolCreatedInSlot: oldest.slot,
        weLandedInSlot: tx.slot,
        slotsBehind: tx.slot - oldest.slot,
        verdict: tx.slot === oldest.slot
          ? 'SAME BLOCK as the pool creation — there is nothing earlier'
          : `${tx.slot - oldest.slot} slot(s) after the pool was created`,
        poolCreationSignature: oldest.signature,
      });
      log('info', 'pool', { address: pools[0].pubkey, creator: pool.creator.toBase58() });
    }
  } else {
    log('warn', 'no pool found for the configured mint', { mint: configuredMint, note: 'it may have migrated off the curve already' });
  }
}

// The program's own log lines say what it did, in its words rather than ours.
const dbcLogs = (meta.logMessages ?? []).filter((l) => l.includes(DBC_PROGRAM_ID.toBase58()) || /swap|Swap/.test(l));
if (dbcLogs.length) log('info', 'program logs', { lines: dbcLogs.slice(0, 12) });
