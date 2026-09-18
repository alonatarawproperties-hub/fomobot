#!/usr/bin/env node
// pump.fun launch sniper — entrypoint.
//
// Separate from index.mjs on purpose. The copy-trader is a long-lived watcher
// that reacts to whatever a roster wallet happens to do; this is armed at a
// named set of contract addresses for one launch and then it is done. Folding
// the two together would mean the copy-trader's config could arm a sniper by
// accident, and there is no version of that which is worth the shared file.
//
// Refuses to sign unless --live is passed. There is deliberately no way to set
// live mode from the config file: arming five funded wallets should require a
// deliberate act at the command line, every single time.

import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadSniperWallets, auditSplit, solStringToLamports } from './src/solana/wallets.mjs';
import { JitoClient } from './src/solana/jito.mjs';
import { PumpSniper, ATA_RENT_LAMPORTS, SIGNATURE_FEE_LAMPORTS } from './src/solana/sniper.mjs';

const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const PAPER = !LIVE;

const SOL = (lamports) => `${(Number(lamports) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
const log = (level, msg, extra) =>
  console.log(`${new Date().toISOString()} ${level.padEnd(5)} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
  const s = raw.sniper;
  if (!s) throw new Error('config: no "sniper" block. Copy the one in config.example.json.');
  if (!s.rpcUrl || !s.wsUrl) throw new Error('config: sniper.rpcUrl and sniper.wsUrl are both required');
  if (!Array.isArray(s.mints) || s.mints.length === 0) {
    throw new Error('config: sniper.mints is empty — there is nothing to snipe');
  }
  for (const m of s.mints) {
    try { new PublicKey(m); } catch { throw new Error(`config: "${m}" is not a valid mint address`); }
  }
  if (!Array.isArray(s.wallets) || s.wallets.length === 0) throw new Error('config: sniper.wallets is empty');
  return s;
}

async function main() {
  const cfg = loadConfig();

  const totalLamports = solStringToLamports(cfg.totalSol, 'config: sniper.totalSol');
  const tipLamports = solStringToLamports(cfg.jitoTipSol, 'config: sniper.jitoTipSol');
  const slippageBps = BigInt(cfg.slippageBps ?? 500);
  const maxPreBuyLamports = solStringToLamports(cfg.maxPreBuySol ?? '0.000000001', 'config: sniper.maxPreBuySol');

  // Keys come from the environment only. This throws if any is missing, does
  // not match its configured address, is duplicated, or was left in the config.
  const wallets = loadSniperWallets(cfg.wallets, process.env);

  const split = auditSplit({
    wallets, totalLamports, tipLamports,
    ataRentLamports: ATA_RENT_LAMPORTS, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS,
  });

  console.log(`\n  mode          ${PAPER ? 'PAPER — nothing will be signed or sent' : 'LIVE — this will spend real SOL'}`);
  console.log(`  wallets       ${wallets.length}`);
  console.log(`  targets       ${cfg.mints.length}`);
  console.log(`  budget        ${SOL(split.buyTotal)} across buys, ${SOL(split.overhead)} overhead, ${SOL(split.required)} required`);
  console.log(`  declared      ${SOL(totalLamports)}${split.withinBudget ? `  (${SOL(split.headroom)} spare)` : ''}`);
  console.log(`  slippage      ${slippageBps} bps\n`);

  if (!split.withinBudget) {
    throw new Error(
      `config: the split needs ${SOL(split.required)} but sniper.totalSol declares ${SOL(totalLamports)} ` +
      `— ${SOL(split.excess)} short. Buys are not the whole cost: each wallet also pays token-account rent ` +
      `and a signature fee, and one pays the Jito tip.`,
    );
  }
  if (split.allAmountsIdentical && wallets.length > 1) {
    log('warn', 'every wallet is buying the same amount — five identical buys in one bundle is a signature, not a split');
  }

  for (const w of wallets) {
    log('info', `wallet ${w.index + 1}`, { address: w.address, budget: SOL(w.budgetLamports) });
  }

  const connection = new Connection(cfg.rpcUrl, { commitment: 'processed', wsEndpoint: cfg.wsUrl });
  const jito = new JitoClient({ authUuid: process.env.JITO_AUTH_UUID ?? '', relays: cfg.jitoRelays ?? undefined });

  const sniper = new PumpSniper({
    connection, jito, wallets,
    mints: cfg.mints,
    slippageBps, tipLamports,
    tipWalletIndex: cfg.tipWalletIndex ?? wallets.length - 1,
    computeUnitLimit: cfg.computeUnitLimit ?? 250_000,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports ?? 500_000,
    maxPreBuyLamports,
    paper: PAPER,
  });

  sniper.on('primed', (d) => log('info', 'primed from chain', d));
  sniper.on('watching', (d) => log('info', 'watching', d));
  sniper.on('skipped', (d) => log('warn', 'skipped', d));
  sniper.on('firing', (d) => log('signal', `LAUNCH ${d.mint}`, { slot: d.slot, creator: d.creator }));
  sniper.on('paper', (d) => log('info', 'paper bundle built, not sent', d));
  sniper.on('sent', (d) => log('signal', 'BUNDLE SENT', d));
  sniper.on('warn', (d) => log('warn', 'warning', d));
  sniper.on('error', (d) => log('error', 'error', d));

  await sniper.prime();

  // Every number in the plan comes off the chain we just read, so print it
  // before arming. An operator should be able to see what five buys will do to
  // the curve without having to trust that it worked.
  const preview = sniper.plan(sniper.initialReserves());
  console.log('\n  plan against a fresh curve:');
  for (const leg of preview.legs) {
    const px = Number(leg.solIntoCurve) / Number(leg.expectedTokens);
    console.log(
      `    ${leg.label}  ${SOL(leg.budgetLamports).padStart(14)}  ` +
      `-> ${leg.expectedTokens.toString().padStart(18)} tokens  ` +
      `ask ${leg.requestTokens.toString().padStart(18)}  @ ${px.toExponential(4)}`,
    );
  }
  const first = Number(preview.legs[0].solIntoCurve) / Number(preview.legs[0].expectedTokens);
  const last = Number(preview.legs.at(-1).solIntoCurve) / Number(preview.legs.at(-1).expectedTokens);
  console.log(`\n  the last wallet pays ${((last / first - 1) * 100).toFixed(2)}% more per token than the first.`);
  console.log('  That is this bundle moving the curve against itself, and it is unavoidable');
  console.log('  when five buys land back to back. It is the price of the split.\n');

  const balances = await sniper.checkBalances();
  let short = false;
  for (const b of balances) {
    log(b.sufficient ? 'info' : 'error', `balance ${b.address}`, {
      have: SOL(b.balance), need: SOL(b.required), ...(b.sufficient ? {} : { short: SOL(b.shortfall) }),
    });
    if (!b.sufficient) short = true;
  }
  if (short && LIVE) {
    throw new Error('refusing to arm: at least one wallet cannot cover its leg, and one failed leg voids the bundle');
  }
  if (short) log('warn', 'wallets underfunded — paper mode continues, but --live would refuse here');

  // Start the refresh BEFORE arming. prime() put one blockhash in hand, but a
  // launch that fires minutes later would be signing against a stale one, and a
  // blockhash that has aged out is rejected by the cluster rather than landing
  // late — the bundle would simply never appear.
  sniper.startBlockhashRefresh(cfg.blockhashRefreshMs ?? 2000);

  const shutdown = async () => { await sniper.unwatch(); sniper.stopBlockhashRefresh(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await sniper.watch();
  log('info', PAPER ? 'armed (paper)' : 'ARMED LIVE', { mints: cfg.mints.length });
}

main().catch((err) => {
  log('error', 'fatal', { error: err?.message ?? String(err) });
  process.exit(1);
});
