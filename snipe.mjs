#!/usr/bin/env node
// pump.fun launch sniper — entrypoint.
//
// Separate from index.mjs on purpose. The copy-trader is a long-lived watcher
// that reacts to whatever a roster wallet happens to do; this is pointed at one
// launch and then it is done. Folding them together would mean the copy-trader's
// config could arm a sniper by accident.
//
// Boots with no contract address. That is the normal case: the CA usually
// arrives shortly before the launch, and it is set over Telegram with /target.
// Until then the process sits primed — fee read, wallets loaded, balances
// checked, blockhash warm — so arming is a single message and no setup happens
// in the hot path.

import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadSniperWallets, auditSplit, solStringToLamports } from './src/solana/wallets.mjs';
import { JitoClient } from './src/solana/jito.mjs';
import { PumpSniper, ATA_RENT_LAMPORTS, SIGNATURE_FEE_LAMPORTS } from './src/solana/sniper.mjs';
import { decideSnipeCommand, resolveTelegram } from './src/solana/snipe-control.mjs';
import { startControl } from './src/control-io.mjs';

const args = new Set(process.argv.slice(2));
const START_LIVE = args.has('--live');

const SOL = (l) => `${(Number(l) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') || '0'} SOL`;
const log = (level, msg, extra) =>
  console.log(`${new Date().toISOString()} ${level.padEnd(6)} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
  const s = raw.sniper;
  if (!s) throw new Error('config: no "sniper" block. Copy the one in config.example.json.');
  if (!s.rpcUrl || !s.wsUrl) throw new Error('config: sniper.rpcUrl and sniper.wsUrl are both required');
  if (!Array.isArray(s.wallets) || s.wallets.length === 0) throw new Error('config: sniper.wallets is empty');
  // mints is OPTIONAL — the target normally arrives over Telegram.
  for (const m of s.mints ?? []) {
    try { new PublicKey(m); } catch { throw new Error(`config: "${m}" is not a valid contract address`); }
  }
  if ((s.mints ?? []).length > 1) {
    throw new Error(
      'config: sniper.mints holds more than one address. All five wallet budgets are spent on whichever ' +
      'launches first, so a second target would be armed against money already gone. Snipe one at a time.',
    );
  }
  return { sniper: s, telegram: raw.telegram };
}

async function main() {
  const { sniper: cfg, telegram } = loadConfig();

  const totalLamports = solStringToLamports(cfg.totalSol, 'config: sniper.totalSol');
  const tipLamports = solStringToLamports(cfg.jitoTipSol, 'config: sniper.jitoTipSol');
  const slippageBps = BigInt(cfg.slippageBps ?? 500);
  let maxPreBuySol = cfg.maxPreBuySol ?? '0.000000001';
  const maxPreBuyLamports = solStringToLamports(maxPreBuySol, 'config: sniper.maxPreBuySol');

  const wallets = loadSniperWallets(cfg.wallets, process.env);
  const split = auditSplit({
    wallets, totalLamports, tipLamports,
    ataRentLamports: ATA_RENT_LAMPORTS, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS,
  });

  console.log(`\n  mode          ${START_LIVE ? 'LIVE — this will spend real SOL' : 'PAPER — nothing signed or sent'}`);
  console.log(`  wallets       ${wallets.length}`);
  console.log(`  target        ${(cfg.mints ?? [])[0] ?? '(none — set it with /target over Telegram)'}`);
  console.log(`  budget        ${SOL(split.buyTotal)} across buys, ${SOL(split.overhead)} overhead`);
  console.log(`  declared      ${SOL(totalLamports)}${split.withinBudget ? `  (${SOL(split.headroom)} spare)` : ''}`);
  console.log(`  slippage      ${slippageBps} bps\n`);

  if (!split.withinBudget) {
    throw new Error(
      `config: the split needs ${SOL(split.required)} but sniper.totalSol declares ${SOL(totalLamports)} ` +
      `— ${SOL(split.excess)} short. Each wallet also pays token-account rent and a signature fee, and one pays the tip.`,
    );
  }
  if (split.allAmountsIdentical && wallets.length > 1) {
    log('warn', 'every wallet is buying the same amount — five identical buys is a signature, not a split');
  }

  const connection = new Connection(cfg.rpcUrl, { commitment: 'processed', wsEndpoint: cfg.wsUrl });
  const jito = new JitoClient({ authUuid: process.env.JITO_AUTH_UUID ?? '', relays: cfg.jitoRelays ?? undefined });

  const sniper = new PumpSniper({
    connection, jito, wallets,
    mints: cfg.mints ?? [],
    slippageBps, tipLamports,
    tipWalletIndex: cfg.tipWalletIndex ?? wallets.length - 1,
    computeUnitLimit: cfg.computeUnitLimit ?? 250_000,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports ?? 500_000,
    maxPreBuyLamports,
    paper: !START_LIVE,
  });

  const startedAt = Date.now();
  let lastResult = null;
  let balances = [];
  let notify = async () => {};

  sniper.on('primed', (d) => log('info', 'primed from chain', d));
  sniper.on('watching', (d) => log('info', 'watching', d));
  sniper.on('target', (d) => log('info', 'target set', d));
  sniper.on('mode', (d) => log('info', 'mode', d));
  sniper.on('skipped', (d) => { log('warn', 'skipped', d); notify(`⚠️ Skipped <code>${d.mint}</code> — ${d.reason}`); });
  sniper.on('firing', (d) => { log('signal', `LAUNCH ${d.mint}`, { slot: d.slot }); notify(`\u{1F680} <b>LAUNCH DETECTED</b>\n<code>${d.mint}</code>\nslot ${d.slot}`); });
  sniper.on('paper', (d) => {
    lastResult = `paper bundle built in ${d.elapsedMs}ms`;
    log('info', 'paper bundle built, not sent', d);
    notify(`\u{1F4C4} <b>Paper</b> — built ${d.transactions} transactions in ${d.elapsedMs}ms. Nothing sent.`);
  });
  sniper.on('sent', (d) => {
    lastResult = `bundle ${d.bundleId?.slice(0, 12)} sent in ${d.elapsedMs}ms`;
    log('signal', 'BUNDLE SENT', d);
    notify(`\u{1F4B8} <b>BUNDLE SENT</b>\n<code>${d.bundleId}</code>\n${d.acceptedBy?.length ?? 0} relay(s), ${d.elapsedMs}ms`);
  });
  sniper.on('warn', (d) => log('warn', 'warning', d));
  sniper.on('error', (d) => { log('error', 'error', d); notify(`\u{1F534} Error: ${d.error}`); });

  await sniper.prime();
  sniper.startBlockhashRefresh(cfg.blockhashRefreshMs ?? 2000);

  const refreshBalances = async () => {
    balances = await sniper.checkBalances();
    return balances;
  };
  await refreshBalances();
  for (const b of balances) {
    log(b.sufficient ? 'info' : 'error', `balance ${b.address}`, {
      have: SOL(b.balance), need: SOL(b.required), ...(b.sufficient ? {} : { short: SOL(b.shortfall) }),
    });
  }

  const previewPlan = () => {
    const p = sniper.plan(sniper.initialReserves());
    const px = (l) => Number(l.solIntoCurve) / Number(l.expectedTokens);
    return {
      legs: p.legs,
      selfImpactPct: ((px(p.legs.at(-1)) / px(p.legs[0]) - 1) * 100).toFixed(2),
    };
  };
  const preview = previewPlan();
  console.log('\n  plan against a fresh curve:');
  for (const leg of preview.legs) {
    console.log(`    ${leg.label}  ${SOL(leg.budgetLamports).padStart(14)}  -> ${leg.expectedTokens.toString().padStart(18)} tokens`);
  }
  console.log(`\n  the last wallet pays ${preview.selfImpactPct}% more per token than the first.\n`);

  const snapshot = () => ({
    mode: sniper.mode,
    armed: sniper.armed,
    target: sniper.target,
    wallets: wallets.map((w, i) => ({
      address: w.address, budgetLamports: w.budgetLamports,
      balance: balances[i]?.balance, sufficient: balances[i]?.sufficient,
    })),
    buyTotalLamports: split.buyTotal,
    slippageBps,
    feeBasisPoints: sniper.global?.feeBasisPoints?.toString(),
    uptimeMs: Date.now() - startedAt,
    maxPreBuySol,
    funded: balances.every((b) => b.sufficient),
    underfunded: balances.filter((b) => !b.sufficient).length,
    plan: preview.legs,
    selfImpactPct: preview.selfImpactPct,
    lastResult,
  });

  const tg = resolveTelegram({ config: telegram, env: process.env });

  if (tg.on) {
    const control = startControl({
      botToken: tg.botToken,
      chatId: tg.chatId,
      snapshot,
      decide: decideSnipeCommand,
      log: (m, e) => log('info', `telegram: ${m}`, e),
      startedAt,
      onAction: async (action, payload) => {
        switch (action) {
          case 'set-target':
            await sniper.setTarget(payload);
            break;
          case 'arm': {
            // Re-read balances at arm time, not just at boot: a wallet drained
            // since startup would fail its leg, and one failed leg voids the
            // bundle for all five.
            await refreshBalances();
            const short = balances.filter((b) => !b.sufficient);
            if (short.length && sniper.mode === 'live') {
              await control.send(
                `⚠️ <b>Refusing to arm.</b> ${short.length} wallet(s) cannot cover their leg:\n\n`
                + short.map((b) => `<code>${b.address}</code>\n  short ${SOL(b.shortfall)}`).join('\n')
                + '\n\nOne short leg voids the whole bundle.',
              );
              return;
            }
            await sniper.watch();
            await control.send(
              `\u{1F3AF} <b>ARMED</b> · ${sniper.mode === 'live' ? '\u{1F4B8} LIVE' : '\u{1F4C4} PAPER'}\n`
              + `<code>${sniper.target}</code>\n\n`
              + (short.length ? `⚠️ ${short.length} wallet(s) underfunded (paper, so allowed)\n\n` : '')
              + `Watching the bonding curve. /disarm or /abort to stop.`,
            );
            break;
          }
          case 'set-maxprebuy':
            maxPreBuySol = payload;
            sniper.maxPreBuyLamports = solStringToLamports(payload, '/maxprebuy');
            break;
          case 'disarm':
            await sniper.unwatch();
            break;
          case 'live':
            sniper.setMode('live');
            break;
          case 'paper':
            sniper.setMode('paper');
            break;
          case 'abort':
            await sniper.unwatch();
            sniper.setMode('paper');
            break;
        }
      },
    });
    notify = (text) => control.send(text).catch(() => {});
    log('info', 'telegram control plane up', { chatId: tg.chatId, from: tg.source });
    await control.send(
      `\u{1F916} <b>Sniper up</b> · ${sniper.mode === 'live' ? '\u{1F4B8} LIVE' : '\u{1F4C4} PAPER'}\n\n`
      + `${wallets.length} wallets · ${SOL(split.buyTotal)} budget\n`
      + `${sniper.target ? `target <code>${sniper.target}</code>` : 'no target yet'}\n\n`
      + 'Send /target when you have the contract address, then /arm. /help for everything.',
    );
  } else {
    log('warn', `telegram off (${tg.reason}) — this bot can only be controlled from the shell`);
  }

  const shutdown = async () => { await sniper.unwatch(); sniper.stopBlockhashRefresh(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (sniper.target) {
    await sniper.watch();
    log('info', sniper.mode === 'paper' ? 'armed (paper)' : 'ARMED LIVE', { target: sniper.target });
  } else {
    log('info', 'idle — waiting for /target over Telegram');
  }
}

main().catch((err) => {
  log('error', 'fatal', { error: err?.message ?? String(err) });
  process.exit(1);
});
