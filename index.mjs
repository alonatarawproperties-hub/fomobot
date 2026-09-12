// First Fill — milestone 01: detect, record, alert.
//
// Watches a roster of wallets and reports every trade they make, within
// milliseconds of it becoming public. It does NOT trade. The policy gate,
// executor and position manager are milestone 02.
//
// Two chains, independently optional — a roster is not required to trade on both:
//   Robinhood Chain  sequencer feed, sub-50ms, free
//   Solana           logsSubscribe at `processed`, then getTransaction to decode
//
//   node index.mjs                 # uses ./config.json
//   node index.mjs --config x.json
//   node index.mjs --dry           # decode and log, no Telegram
//
// Roster edits are picked up live: change config.json and it reloads on the next
// poll. A config that fails to parse is rejected and the previous roster keeps
// running, so a typo cannot blind the watcher.

import { readFileSync, watchFile } from 'node:fs';
import { SequencerFeed } from './src/feed.mjs';
import { Roster, toSignal } from './src/matcher.mjs';
import { Notifier, formatSignal } from './src/notify.mjs';
import { Recorder } from './src/record.mjs';
import { SolanaWatcher, classifyTrade } from './src/solana.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const CONFIG_PATH = flag('config', './config.json');
const DRY = argv.includes('--dry');

const log = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

function loadConfig(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.roster)) throw new Error('config: roster must be an array');
  if (raw.roster.length === 0) {
    throw new Error('config: roster is empty — add at least one wallet or there is nothing to watch');
  }

  const live = raw.roster.filter((e) => e.enabled !== false);
  const evm = live.filter((e) => e.address).length;
  const sol = live.filter((e) => e.solana).length;
  if (!evm && !sol) throw new Error('config: no enabled roster entry has an address or a solana wallet');
  if (evm && !raw.feedUrl) throw new Error('config: feedUrl is required when watching EVM addresses');
  if (sol && !(raw.solana?.wsUrl && raw.solana?.httpUrl)) {
    throw new Error('config: solana.wsUrl and solana.httpUrl are required when watching Solana wallets');
  }
  return raw;
}

let config;
try {
  config = loadConfig(CONFIG_PATH);
} catch (err) {
  log('fatal', 'config rejected', { path: CONFIG_PATH, error: err.message });
  process.exit(1);
}

const roster = new Roster(config.roster.filter((e) => e.address));
const recorder = new Recorder(config.record ?? {});
const notifier = new Notifier({ ...(config.telegram ?? {}), enabled: !DRY && config.telegram?.enabled !== false });

const solEntries = config.roster.filter((e) => e.solana && e.enabled !== false);
const solByAddress = new Map(solEntries.map((e) => [e.solana, e.handle ?? e.solana.slice(0, 6)]));

log('info', 'starting', {
  robinhoodChain: roster.size ? config.feedUrl : 'disabled',
  solana: solEntries.length ? `${solEntries.length} wallet(s)` : 'disabled',
  handles: [...new Set([...roster.list().map((e) => e.handle), ...solByAddress.values()])],
  telegram: notifier.enabled ? 'on' : 'off',
  recording: recorder.path,
});

// --- roster hot reload -------------------------------------------------------
// Only the EVM side reloads live. Solana subscriptions are bound to an open
// socket, so changing those wallets needs a restart — said plainly rather than
// silently ignored.
watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    const next = loadConfig(CONFIG_PATH);
    roster.replace(next.roster.filter((e) => e.address));
    log('info', 'roster reloaded', { watching: roster.size });
    notifier.send(`🔁 EVM roster reloaded — ${roster.size} watched. Solana changes need a restart.`);
  } catch (err) {
    log('error', 'roster reload rejected, keeping previous', { error: err.message });
    notifier.send(`⚠️ Roster reload FAILED, still on the previous one\n${err.message}`);
  }
});

// --- Robinhood Chain ---------------------------------------------------------
// Skipped entirely when no roster entry carries an EVM address, so a Solana-only
// roster does not hold a socket open against a chain nobody trades on.
let feed = null;
if (roster.size) {
  feed = new SequencerFeed({ url: config.feedUrl, silenceMs: config.silenceMs ?? 15_000 });

  feed.on('open', ({ connectMs }) => log('info', 'rh feed connected', { connectMs }));
  feed.on('closed', (d) => log('warn', 'rh feed closed, reconnecting', d));
  feed.on('warn', (w) => log('warn', 'rh feed warning', w));

  feed.on('gap', (g) => {
    log('warn', 'rh sequence gap', g);
    recorder.write({ kind: 'gap', chain: 'robinhood', ...g });
  });

  feed.on('stall', ({ quietMs }) => {
    log('error', 'rh feed stalled', { quietMs });
    recorder.write({ kind: 'stall', chain: 'robinhood', quietMs });
    notifier.send(`🔴 <b>Robinhood feed stalled</b> — no frames for ${Math.round(quietMs / 1000)}s. Detection DOWN until it clears.`);
  });

  feed.on('recovered', () => {
    log('info', 'rh feed recovered');
    notifier.send('🟢 Robinhood feed recovered.');
  });

  feed.on('txs', (txs) => {
    for (const tx of txs) {
      const hit = roster.match(tx);
      if (!hit) continue;
      const sig = toSignal(tx, hit);
      log('signal', 'rh roster hit', { handle: sig.handle, via: sig.via, to: sig.to, tx: sig.txHash });
      recorder.write({ ...sig, chain: 'robinhood' });
      notifier.send(formatSignal(sig, config.explorerBase));
    }
  });

  feed.start();
} else {
  log('info', 'robinhood chain watcher disabled', { reason: 'no EVM addresses in roster' });
}

// --- Solana ------------------------------------------------------------------
let sol = null;
if (solEntries.length) {
  sol = new SolanaWatcher({
    wsUrl: config.solana.wsUrl,
    httpUrl: config.solana.httpUrl,
    addresses: [...solByAddress.keys()],
    commitment: config.solana.commitment ?? 'processed',
  });

  sol.on('open', (d) => log('info', 'solana connected', d));
  sol.on('subscribed', (d) => log('info', 'solana subscribed', d));
  sol.on('closed', (d) => log('warn', 'solana closed, reconnecting', d));
  sol.on('warn', (w) => log('warn', 'solana warning', w));

  // Stage 1 — the wallet moved. Nothing is known yet about what it did, and
  // waiting to find out would hand back the entire lead.
  sol.on('hit', (hit) => {
    const handle = solByAddress.get(hit.address) ?? hit.address;
    log('signal', 'solana hit', { handle, slot: hit.slot, sig: hit.signature });
    recorder.write({ kind: 'signal', chain: 'solana', handle, ...hit });
    notifier.send(
      `⚡ <b>${handle}</b> moved on Solana\n` +
      `slot <code>${hit.slot}</code>\n` +
      `https://solscan.io/tx/${hit.signature}`
    );
  });

  // Stage 2 — what it actually was, once the transaction is queryable.
  sol.on('enriched', (e) => {
    const handle = solByAddress.get(e.address) ?? e.address;
    const t = classifyTrade(e.tx, e.address);
    const lagMs = e.enrichedAt - e.seenAt;
    log('signal', 'solana classified', { handle, side: t.side, mint: t.mint, lagMs });
    recorder.write({
      kind: t.side === 'funding' ? 'funding' : 'trade',
      chain: 'solana', handle, wallet: e.address, signature: e.signature,
      slot: e.slot, side: t.side, direction: t.direction ?? null, mint: t.mint,
      amount: t.amount?.toString() ?? null, decimals: t.decimals,
      seenAt: e.seenAt, enrichedAt: e.enrichedAt, lagMs,
    });
    if (!t.side) return;

    const ui = Number(t.amount) / 10 ** (t.decimals || 0);
    const pretty = ui.toLocaleString('en-US', { maximumFractionDigits: 4 });

    if (t.side === 'funding') {
      // Deliberately understated: this is not a trade and must not read like one.
      notifier.send(
        `💵 <b>${handle}</b> funding ${t.direction}\n` +
        `<code>${pretty}</code> — no token traded`
      );
      return;
    }

    notifier.send(
      `${t.side === 'buy' ? '🟢' : '🔴'} <b>${handle}</b> ${t.side.toUpperCase()}\n` +
      `<code>${t.mint}</code>\n` +
      `amount <code>${pretty}</code>\n` +
      `decoded ${lagMs}ms after the alert`
    );
  });

  sol.start();
} else {
  log('info', 'solana watcher disabled', { reason: 'no solana wallets in roster' });
}

// --- heartbeat ---------------------------------------------------------------
// Proves liveness even when the roster is quiet, so "nothing happened" is always
// distinguishable from "nothing is running".
const heartbeat = setInterval(() => {
  log('info', 'heartbeat', {
    rh: feed?.stats ?? 'disabled',
    solana: sol?.stats ?? 'disabled',
    recorded: recorder.written,
    recordErrors: recorder.errors,
    alertsDropped: notifier.dropped,
  });
}, config.heartbeatMs ?? 60_000);

// --- shutdown ----------------------------------------------------------------
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log('info', 'shutting down', { signal, rh: feed?.stats, solana: sol?.stats });
  clearInterval(heartbeat);
  feed?.stop();
  sol?.stop();
  await recorder.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  log('error', 'unhandled rejection', { error: err?.message ?? String(err) });
});
