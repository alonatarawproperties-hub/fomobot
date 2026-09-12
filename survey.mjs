// Samples live Robinhood Chain traffic and aggregates destinations by DISTINCT
// SENDER COUNT, to tell a gas-sponsoring relayer apart from users signing for
// themselves.
//
//   many senders on one contract  -> users sign from their own EOAs
//   one sender dominating         -> a relayer; the trader is inside calldata
//
//   node survey.mjs [seconds]     # default 60
//
// Read-only. Opens one websocket, sends nothing, signs nothing, holds no keys.

import { Transaction } from 'ethers';
import { extractSignedTxs } from './src/decode.mjs';

const URL = process.env.FEED_URL ?? 'wss://feed.mainnet.chain.robinhood.com';
const SECONDS = Number(process.argv[2] ?? 60);

const byTo = new Map();
let frames = 0, txs = 0, failed = 0;
const t0 = Date.now();

const ws = new WebSocket(URL);
ws.addEventListener('open', () => console.error(`connected in ${Date.now() - t0}ms — sampling ${SECONDS}s\n`));
ws.addEventListener('error', (e) => console.error('socket error:', e?.message ?? e));

ws.addEventListener('message', (ev) => {
  frames++;
  let frame;
  try { frame = JSON.parse(ev.data); } catch { return; }

  for (const m of frame.messages ?? []) {
    const l2 = m?.message?.message?.l2Msg;
    if (!l2) continue;
    for (const raw of extractSignedTxs(l2)) {
      let tx;
      try { tx = Transaction.from('0x' + raw.toString('hex')); } catch { failed++; continue; }
      txs++;

      const to = tx.to ? tx.to.toLowerCase() : '(contract deployment)';
      let e = byTo.get(to);
      if (!e) { e = { n: 0, senders: new Map(), selectors: new Map() }; byTo.set(to, e); }
      e.n++;

      let from = null;
      try { from = tx.from?.toLowerCase() ?? null; } catch { /* recovery failed */ }
      if (from) e.senders.set(from, (e.senders.get(from) ?? 0) + 1);

      const sel = tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10).toLowerCase() : '(transfer)';
      e.selectors.set(sel, (e.selectors.get(sel) ?? 0) + 1);
    }
  }
});

setTimeout(() => {
  console.log(`frames ${frames}   txs ${txs}   undecodable ${failed}   ${(txs / SECONDS).toFixed(1)} tx/s`);
  console.log(`distinct destinations ${byTo.size}\n`);

  const rows = [...byTo.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20);

  console.log(
    'destination'.padEnd(44) + 'txs'.padStart(6) + 'senders'.padStart(9) +
    'top sender %'.padStart(14) + '   verdict'
  );
  console.log('-'.repeat(112));

  for (const [to, e] of rows) {
    const counts = [...e.senders.values()].sort((a, b) => b - a);
    const topShare = counts.length ? counts[0] / e.n : 0;
    const verdict =
      e.senders.size === 0 ? '—'
      : e.senders.size === 1 ? 'RELAYER (single sender)'
      : topShare > 0.6 ? `relayer-ish (top ${(topShare * 100).toFixed(0)}%)`
      : e.senders.size > 10 ? 'USER EOAs'
      : 'unclear, sample longer';

    console.log(
      to.padEnd(44) + String(e.n).padStart(6) + String(e.senders.size).padStart(9) +
      `${(topShare * 100).toFixed(0)}%`.padStart(14) + '   ' + verdict
    );
  }

  console.log('\nTop destinations by selector:');
  for (const [to, e] of rows.slice(0, 5)) {
    const sels = [...e.selectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([s, c]) => `${s}×${c}`).join('  ');
    console.log(`  ${to}\n    ${sels}`);
  }
  process.exit(0);
}, SECONDS * 1000);
