#!/usr/bin/env node
// Jito submission probe.
//
// The sniper's bundles are accepted by every relay, report Invalid, and never
// reach Pending — "dropped before the auction". Everything about their CONTENT
// is proven correct: ingress accepts them (a malformed bundle is rejected with
// HTTP 400 naming the fault), simulateBundle executes all five sequentially
// against a real bank and returns succeeded, signatures verify, the tip is 50x
// the landed-tip 99th percentile, the blockhash is milliseconds old, and the
// wallets hold ~26,000,000 lamports more than they need.
//
// So the fault is in HOW we submit, not WHAT. This probe strips the submission
// down to the smallest thing Jito will accept — ONE transaction containing
// ONLY a tip — and varies one dimension at a time.
//
//   --txs=1|5       one wallet tipping, or all five each tipping
//   --relays=1|all  a single relay, or the same fan-out the sniper uses
//   --tip=<SOL>     default 0.001
//
// Cost is the tip plus a signature fee, and ONLY if it lands. A bundle that is
// dropped costs nothing at all, which is why every attempt so far has been free.
//
// Read the verdict, not the chain:
//   landed                 -> submission works; the problem is the sniper's bundle shape
//   dropped-before-auction -> the engine discards it regardless of content
//   forwarded-then-lost    -> it reached the auction and lost; a tip question after all

import fs from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { JitoClient, DEFAULT_RELAYS } from '../src/pump/jito.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};

const TX_COUNT = Number(flag('txs', '1'));
const RELAY_MODE = flag('relays', '1');
const TIP_SOL = Number(flag('tip', '0.001'));
const TIP_LAMPORTS = Math.round(TIP_SOL * 1e9);

if (![1, 5].includes(TX_COUNT)) throw new Error('--txs must be 1 or 5');

const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8')).pumpSniper;
if (!cfg) throw new Error('config: no "pumpSniper" block');

const keypairs = [];
for (let i = 1; i <= TX_COUNT; i++) {
  const secret = process.env[`FIRSTFILL_SNIPER_KEY_${i}`];
  if (!secret) throw new Error(`FIRSTFILL_SNIPER_KEY_${i} is not set`);
  keypairs.push(Keypair.fromSecretKey(Uint8Array.from(bs58.decode(secret.trim()))));
}

const relays = RELAY_MODE === 'all' ? DEFAULT_RELAYS : ['https://ny.mainnet.block-engine.jito.wtf'];
const connection = new Connection(cfg.rpcUrl, 'confirmed');
const jito = new JitoClient({ relays, authUuid: process.env.JITO_AUTH_UUID ?? '' });

console.log(`\n  transactions  ${TX_COUNT}`);
console.log(`  relays        ${relays.length} (${RELAY_MODE})`);
console.log(`  tip           ${TIP_SOL} SOL from wallet ${TX_COUNT === 1 ? 1 : TX_COUNT}`);
console.log(`  auth          ${process.env.JITO_AUTH_UUID ? 'x-jito-auth set' : 'none (unauthenticated)'}`);
console.log(`  max cost      ${(TIP_SOL + 0.000005 * TX_COUNT).toFixed(6)} SOL, and only if it lands\n`);

const tipAccounts = await jito.getTipAccounts();
const tipAccount = new PublicKey(tipAccounts[0]);
const { blockhash } = await connection.getLatestBlockhash('confirmed');

// The whole bundle is tips. Nothing here can revert for a reason of its own, so
// a drop cannot be blamed on the work the transactions do.
const transactions = keypairs.map((kp, i) => {
  const instructions = [];
  // Only the LAST transaction tips, mirroring the sniper's shape.
  if (i === keypairs.length - 1) {
    instructions.push(SystemProgram.transfer({
      fromPubkey: kp.publicKey, toPubkey: tipAccount, lamports: TIP_LAMPORTS,
    }));
  } else {
    // A self-transfer of 0: a valid, free, side-effect-free transaction that
    // exists only to make the bundle multi-transaction.
    instructions.push(SystemProgram.transfer({
      fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0,
    }));
  }
  const msg = new TransactionMessage({
    payerKey: kp.publicKey, recentBlockhash: blockhash, instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
});

console.log(`  built ${transactions.length} transaction(s), ${transactions.map((t) => Buffer.from(t, 'base64').length).join('/')} bytes`);

let result;
try {
  result = await jito.sendBundle(transactions);
} catch (err) {
  // An ingress rejection is GOOD news: it names the fault instead of hiding it.
  console.log(`\n  REJECTED AT INGRESS: ${err.message}`);
  console.log('  That is a named reason — fix exactly what it says.\n');
  process.exit(0);
}

console.log(`  bundle id     ${result.bundleId}`);
console.log(`  accepted by   ${result.acceptedBy.length} relay(s)\n`);
console.log('  polling for up to 40s...\n');

const settled = await jito.pollBundle(result.bundleId, {
  onSample: (s) => console.log(`    +${String(s.tMs).padStart(6)}ms  ${s.relay.replace('https://', '').split('.')[0].padEnd(10)} ${s.raw ?? s.error ?? 'null'}`),
});

console.log(`\n  ever Pending  ${settled.everPending}`);
console.log(`  final         ${settled.final?.raw ?? 'none'}`);
console.log(`  landed slot   ${settled.landedSlot ?? '-'}`);
console.log(`\n  VERDICT: ${settled.verdict}\n`);

if (settled.verdict === 'landed') {
  console.log('  Submission works. The sniper\'s bundle SHAPE is what gets dropped —');
  console.log('  re-run with --txs=5 and then --relays=all to find which dimension.\n');
} else if (settled.verdict === 'dropped-before-auction') {
  console.log('  Even a single tip-only transaction is discarded. Nothing about the');
  console.log('  sniper\'s bundle is at fault — this block engine will not accept');
  console.log('  bundles from here. Next: obtain a Jito auth UUID, or submit through');
  console.log('  a provider that forwards bundles on your behalf.\n');
} else {
  console.log('  It reached the auction and lost. That IS a tip question — raise the');
  console.log('  tip and re-run.\n');
}
