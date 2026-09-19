#!/usr/bin/env node
// Rewrite the pumpSniper sizing in config.json — total, tip, pre-buy limit.
//
// Hand-editing these is how a launch gets missed. Four numbers have to agree:
// the per-wallet amounts, totalSol (which the boot check compares against the
// amounts PLUS rent, signature fees and the tip), the tip itself, and
// maxPreBuySol. Get totalSol wrong and the process refuses to start; get
// maxPreBuySol wrong and it starts, arms, watches the launch go past and buys
// nothing. Neither is something to discover at the launch.
//
// So this computes all of them from one number, keeps the wallet proportions
// the operator already chose, writes a timestamped backup first, and then runs
// the SAME audit the bot runs at boot — against the file it just wrote, not
// against what it meant to write.
//
//   node scripts/set-snipe-plan.mjs --total 15 --tip 0.01 --maxprebuy 32
//
// By default the wallet proportions already in the file are kept and only
// scaled — the unevenness is deliberate and retyping it is how it stops being
// uneven. --weights replaces that shape when there is none worth keeping, e.g.
// after a flat test run left all five equal:
//
//   --weights 2.37,1.42,2.11,1.58,2.07
//
// The weights are proportions, not amounts: they are scaled to --total, so the
// same list works at any size.
//
// --maxprebuy is the ceiling on how much SOL the curve may ALREADY hold when
// the bot looks at it. On a launch you snipe cold that is small — anything in
// there is somebody ahead of you. When you are the dev and your own buy lands
// first, it has to clear your own buy or the bot refuses its own launch.

import fs from 'node:fs';
import { auditSplit, solStringToLamports } from '../src/pump/wallets.mjs';
import { ATA_RENT_LAMPORTS, SIGNATURE_FEE_LAMPORTS } from '../src/pump/sniper.mjs';
import { MIN_TIP_LAMPORTS } from '../src/pump/sender.mjs';

const SOL = (l) => (Number(l) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') || '0';
const FILE = './config.json';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const totalArg = arg('total');
const tipArg = arg('tip');
const maxPreArg = arg('maxprebuy');
const weightsArg = arg('weights');
if (!totalArg) {
  console.error('usage: node scripts/set-snipe-plan.mjs --total <SOL> [--tip <SOL>] [--maxprebuy <SOL>]'
    + ' [--weights a,b,c,d,e]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const s = raw.pumpSniper;
if (!s) throw new Error('config.json has no "pumpSniper" block');
if (!Array.isArray(s.wallets) || s.wallets.length === 0) throw new Error('config.json: pumpSniper.wallets is empty');

// Keep the shape the operator chose. Scaling the existing amounts rather than
// asking for five new ones is the point: the unevenness is deliberate, and
// retyping it is how it stops being uneven. --weights is the escape hatch for
// when the shape in the file is not one worth keeping — a flat test run leaves
// every wallet equal, and scaling equal amounts only ever gives equal amounts.
let old;
if (weightsArg === null) {
  old = s.wallets.map((w) => solStringToLamports(w.sol, `config: wallet ${w.address}`));
} else {
  const parts = weightsArg.split(',').map((x) => x.trim());
  if (parts.length !== s.wallets.length) {
    throw new Error(`--weights has ${parts.length} values but there are ${s.wallets.length} wallets`);
  }
  // Parsed as SOL so one parser decides what a number is, here and in the bot.
  // Their absolute size is irrelevant — only the ratios survive the scaling.
  old = parts.map((x, i) => solStringToLamports(x, `--weights[${i}]`));
}
const oldTotal = old.reduce((a, b) => a + b, 0n);
const target = solStringToLamports(totalArg, '--total');

// Scale in lamports and give the remainder to the largest leg, so the amounts
// sum to EXACTLY the target rather than to a rounding error either side of it.
const scaled = old.map((l) => (l * target) / oldTotal);
const drift = target - scaled.reduce((a, b) => a + b, 0n);
let biggest = 0;
for (let i = 1; i < scaled.length; i++) if (scaled[i] > scaled[biggest]) biggest = i;
scaled[biggest] += drift;

const tipLamports = tipArg === null
  ? solStringToLamports(s.senderTipSol ?? s.jitoTipSol, 'config: senderTipSol')
  : solStringToLamports(tipArg, '--tip');
if (tipLamports < MIN_TIP_LAMPORTS) {
  throw new Error(`--tip ${tipArg} is below Sender's ${SOL(MIN_TIP_LAMPORTS)} SOL minimum for the fast path`);
}

const wallets = s.wallets.map((w, i) => ({ ...w, sol: SOL(scaled[i]) }));
const audit = auditSplit({
  wallets: wallets.map((w, i) => ({ ...w, budgetLamports: scaled[i] })),
  totalLamports: 0n, tipLamports,
  ataRentLamports: ATA_RENT_LAMPORTS, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS,
});

const next = {
  ...raw,
  pumpSniper: {
    ...s,
    wallets,
    // totalSol is a declaration the boot check measures the split against, so
    // it must cover the overhead too, not just the buys.
    totalSol: SOL(audit.required),
    senderTipSol: SOL(tipLamports),
    ...(maxPreArg === null ? {} : { maxPreBuySol: SOL(solStringToLamports(maxPreArg, '--maxprebuy')) }),
  },
};
delete next.pumpSniper.jitoTipSol;   // one name for the tip, not two that can disagree

// Write to a temporary file, verify THAT, and only then move it into place.
// Writing config.json first and checking afterwards means a failed check leaves
// the operator holding a broken config — with a backup they then have to know
// to restore, at a moment when they are about to launch. A rename is atomic, so
// config.json is either the old file or a verified new one and never a half-
// written third thing.
const tmp = `${FILE}.new`;
fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);

// Re-read from the temp file and re-audit. Everything above operated on objects
// in memory; this is the only check that speaks for bytes on disk. Any failure
// in here takes the temp file with it, so a bad run leaves nothing behind.
let onDisk, reread, recheck;
try {
  onDisk = JSON.parse(fs.readFileSync(tmp, 'utf8')).pumpSniper;
  reread = onDisk.wallets.map((w) => solStringToLamports(w.sol, 'written wallet'));
  recheck = auditSplit({
    wallets: onDisk.wallets.map((w, i) => ({ ...w, budgetLamports: reread[i] })),
    totalLamports: solStringToLamports(onDisk.totalSol, 'written totalSol'),
    tipLamports: solStringToLamports(onDisk.senderTipSol, 'written senderTipSol'),
    ataRentLamports: ATA_RENT_LAMPORTS, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS,
  });
  if (!recheck.withinBudget) {
    throw new Error(`the new config does not audit — ${SOL(recheck.excess)} SOL short`);
  }
  if (reread.reduce((a, b) => a + b, 0n) !== target) {
    throw new Error('the written amounts do not sum to --total');
  }
} catch (err) {
  fs.rmSync(tmp, { force: true });
  throw new Error(`refusing to install: ${err.message}. config.json is untouched.`);
}

const backup = `${FILE}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
fs.copyFileSync(FILE, backup);
fs.renameSync(tmp, FILE);

const perWallet = (i) => reread[i] + ATA_RENT_LAMPORTS + SIGNATURE_FEE_LAMPORTS
  + (BigInt(onDisk.computeUnitLimit ?? 250_000) * BigInt(onDisk.computeUnitPriceMicroLamports ?? 500_000)) / 1_000_000n
  + (i === (onDisk.tipWalletIndex ?? onDisk.wallets.length - 1) ? solStringToLamports(onDisk.senderTipSol, 'tip') : 0n);

console.log(`\n  backup        ${backup}`);
console.log(`  buys          ${SOL(recheck.buyTotal)} SOL`);
console.log(`  overhead      ${SOL(recheck.overhead)} SOL  (rent + signatures + tip)`);
console.log(`  totalSol      ${onDisk.totalSol}`);
console.log(`  tip           ${onDisk.senderTipSol} SOL`);
console.log(`  maxPreBuySol  ${onDisk.maxPreBuySol}  <- the bot refuses a curve already holding more than this`);
if (recheck.allAmountsIdentical && onDisk.wallets.length > 1) {
  console.log('\n  WARNING: every wallet buys the same amount — that is a signature, not a split');
}
console.log('\n  fund each wallet with at least:');
let need = 0n;
onDisk.wallets.forEach((w, i) => {
  need += perWallet(i);
  console.log(`    ${w.address}  ${SOL(reread[i]).padStart(12)} buy  ->  ${SOL(perWallet(i)).padStart(12)} needed`
    + (i === (onDisk.tipWalletIndex ?? onDisk.wallets.length - 1) ? '   (pays the tip)' : ''));
});
console.log(`\n  total to fund ${SOL(need)} SOL\n`);
