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
import { Roster, toSignal, handleFor } from './src/matcher.mjs';
import { Notifier, formatSignal } from './src/notify.mjs';
import { Recorder } from './src/record.mjs';
import { SolanaWatcher, classifyTrade } from './src/solana.mjs';
import { classifyRhTrade, isRhTrade } from './src/robinhood-trade.mjs';
import { decideEntry, initialState } from './src/policy.mjs';
import { executeBuy, quoteUnitsForUsd } from './src/executor.mjs';
import { makeExecutorDeps, loadPrivateKey, fetchReceipt, KEY_ENV } from './src/executor-io.mjs';
import { USD_STABLES } from './src/chain/robinhood.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const CONFIG_PATH = flag('config', './config.json');
const DRY = argv.includes('--dry');
// --paper can only ever make a run safer, so it overrides the config rather than
// being overridden by it. There is deliberately no flag in the other direction.
const FORCE_PAPER = argv.includes('--paper');

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

/**
 * Everything about the executor that must be true before a single signal is
 * watched for. Checked at boot and thrown, because the alternative is finding out
 * mid-trade — the one moment there is no good way to handle it.
 */
function validateExecutor(raw, env) {
  const ex = raw.executor;
  if (!ex || ex.enabled !== true) return { enabled: false, paper: true };

  if (!ex.rpcUrl) throw new Error('config: executor.rpcUrl is required when the executor is enabled');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(ex.wallet ?? ''))) {
    throw new Error('config: executor.wallet must be the 20-byte address we trade from');
  }

  const quoteToken = String(ex.quoteToken ?? '').toLowerCase();
  const stable = USD_STABLES.get(quoteToken);
  if (!stable) {
    throw new Error(
      `config: executor.quoteToken ${quoteToken || '(unset)'} is not a known USD stablecoin. ` +
      'Trade sizes are configured in dollars, and that conversion is only meaningful for a token ' +
      `worth a dollar — add it to USD_STABLES in src/chain/robinhood.mjs deliberately, with its ` +
      'decimals read off the chain.',
    );
  }

  const sized = raw.roster.filter((e) => e.enabled !== false && e.address)
    .every((e) => typeof (e.sizeUsd ?? ex.sizeUsd) === 'number' && (e.sizeUsd ?? ex.sizeUsd) > 0);
  if (!sized) throw new Error('config: every watched EVM trader needs a sizeUsd, or set executor.sizeUsd as the default');

  const paper = FORCE_PAPER || ex.paper !== false;
  const privateKey = loadPrivateKey(raw, env);
  if (!paper && !privateKey) {
    throw new Error(`config: executor.paper is false but ${KEY_ENV} is not set — refusing to start a live executor with no wallet`);
  }
  return { enabled: true, paper, privateKey, quoteToken, stable, cfg: ex };
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

// --- executor ----------------------------------------------------------------
let executor = { enabled: false, paper: true };
try {
  executor = validateExecutor(config, process.env);
} catch (err) {
  log('fatal', 'executor config rejected', { error: err.message });
  process.exit(1);
}

let execDeps = null;
if (executor.enabled) {
  execDeps = makeExecutorDeps({ rpcUrl: executor.cfg.rpcUrl, privateKey: executor.privateKey ?? null });
  // The configured address and the key must be the same wallet. Without this a
  // mistyped address means every simulation reads one wallet's balances while
  // every signature comes from another — which does not throw, it just trades
  // somewhere nobody is looking.
  if (execDeps.address && execDeps.address.toLowerCase() !== executor.cfg.wallet.toLowerCase()) {
    log('fatal', 'executor key does not match executor.wallet', {
      configured: executor.cfg.wallet.toLowerCase(), derived: execDeps.address.toLowerCase(),
    });
    process.exit(1);
  }
  if (!executor.paper && !execDeps.address) {
    log('fatal', 'executor armed with no wallet', {});
    process.exit(1);
  }
}

// Per-trader config, by handle. The Roster class deliberately keeps only what
// matching needs, so sizing and cooldowns are read from the raw config entry.
//
// The key is `handleFor` and not a local copy of it: a signal arrives under the
// name Roster gave it, so anything deriving that name a second time is free to
// disagree — and it disagrees silently, skipping a rostered trader as
// `unknown-trader`.
let traderConfig = new Map();
const indexTraders = (raw) => {
  traderConfig = new Map(raw.roster.filter((e) => e.address).map((e) => [handleFor(e), e]));
};
indexTraders(config);

const policyState = initialState();
const copiedTxs = new Set(); // txHash dedupe: a replayed feed frame must not buy twice
const execStats = { considered: 0, skipped: 0, refused: 0, bought: 0, papered: 0, errors: 0, queued: 0 };

// Entries run ONE AT A TIME, and this is not tidiness.
//
// He trades in bursts — six transactions inside two minutes, measured on his
// Solana history — so two buys landing while the first is still resolving is the
// normal case, not a corner. Run concurrently they break two things at once:
// `maxOpenPositions` is read by both before either increments it, so the limit
// is exceeded by however many are in flight; and both `send` calls ask the node
// for the same pending nonce, so one of the two transactions is rejected after
// the other has already moved money.
//
// Receipt fetching and classification stay parallel. Only the part that spends
// is serialised, so nothing about detection slows down.
let entryChain = Promise.resolve();
const serialise = (fn) => {
  execStats.queued++;
  const next = entryChain.then(fn, fn);
  entryChain = next.catch(() => {});
  return next.finally(() => { execStats.queued--; });
};

const solEntries = config.roster.filter((e) => e.solana && e.enabled !== false);
const solByAddress = new Map(solEntries.map((e) => [e.solana, e.handle ?? e.solana.slice(0, 6)]));

// Parsing a transaction is dominated by ECDSA signature recovery. Doing it for
// every transaction on the chain pegged a core in production (8min CPU in 8min
// wall, 12,794 transactions), which on a shared-core VM burns through burst
// credits and then throttles detection. Scanning the raw bytes first costs
// almost nothing. The exception is a wallet that signs its own transactions:
// its address is never IN the bytes, so one such entry turns the filter off.
const prefilterOn = roster.size > 0 && !roster.anySelfSends;

log('info', 'starting', {
  robinhoodChain: roster.size ? config.feedUrl : 'disabled',
  solana: solEntries.length ? `${solEntries.length} wallet(s)` : 'disabled',
  handles: [...new Set([...roster.list().map((e) => e.handle), ...solByAddress.values()])],
  scan: roster.size ? (prefilterOn ? 'prefiltered (cheap)' : 'full recovery (selfSends set)') : 'n/a',
  telegram: notifier.enabled ? 'on' : 'off',
  recording: recorder.path,
  executor: executor.enabled
    ? { mode: executor.paper ? 'PAPER (signs nothing)' : 'LIVE', wallet: executor.cfg.wallet, quote: executor.stable.symbol, sizeUsd: executor.cfg.sizeUsd ?? 'per-trader' }
    : 'disabled',
});

// --- copying a Robinhood Chain buy -------------------------------------------
// The feed sees a transaction before it executes, so the alert above has already
// gone out by the time any of this runs. What happens here is the decision, and
// it is deliberately downstream of the alert: finding out what he bought costs a
// receipt, and nothing about that should delay telling the operator he moved.

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function handleRhSignal(sig) {
  // A reconnecting feed can replay frames. Deduping on the hash is exact and
  // costs nothing; the policy gate's ALREADY_HOLDING would catch most of this
  // too, but "most" is not the right standard when the duplicate spends money.
  if (copiedTxs.has(sig.txHash)) return;
  copiedTxs.add(sig.txHash);
  if (copiedTxs.size > 5000) {
    for (const h of copiedTxs) { copiedTxs.delete(h); if (copiedTxs.size <= 4000) break; }
  }

  const receipt = await fetchReceipt(execDeps.provider, sig.txHash);
  if (!receipt) {
    execStats.errors++;
    log('warn', 'rh receipt never arrived', { tx: sig.txHash });
    recorder.write({ kind: 'rh-unresolved', chain: 'robinhood', handle: sig.handle, txHash: sig.txHash });
    return;
  }

  const trade = classifyRhTrade(receipt, sig.trader);
  recorder.write({
    kind: isRhTrade(trade) ? 'trade' : trade.side === 'funding' ? 'funding' : 'non-trade',
    chain: 'robinhood', handle: sig.handle, wallet: sig.trader, txHash: sig.txHash,
    side: trade.side, direction: trade.direction ?? null, token: trade.token,
    amount: trade.amount?.toString() ?? null, seenAt: sig.seenAt, classifiedAt: Date.now(),
  });

  if (!isRhTrade(trade)) {
    if (trade.side === 'funding') {
      notifier.send(`\u{1F4B5} <b>${esc(sig.handle)}</b> funding ${trade.direction} on Robinhood Chain \u2014 no token traded`);
    }
    return;
  }

  notifier.send(
    `${trade.side === 'buy' ? '\u{1F7E2}' : '\u{1F534}'} <b>${esc(sig.handle)}</b> ${trade.side.toUpperCase()} on Robinhood Chain\n` +
    `<code>${esc(trade.token)}</code>`
  );

  // Only a buy is copied. Following him out is the position manager's job and it
  // is not wired yet — see the known limits in the README.
  if (trade.side !== 'buy') return;
  await serialise(() => copyBuy(sig, trade));
}

async function copyBuy(sig, trade) {
  execStats.considered++;
  const ex = executor.cfg;
  const decision = decideEntry(
    { handle: sig.handle, side: 'buy', mint: trade.token, chain: 'robinhood', traderAddress: sig.trader },
    traderConfig.get(sig.handle),
    policyState,
    {
      defaultSizeUsd: ex.sizeUsd,
      maxOpenPositions: ex.maxOpenPositions,
      dailyLossLimitUsd: ex.dailyLossLimitUsd,
      cooldownMs: ex.cooldownMs,
      denylistMints: ex.denylistTokens,
    },
  );

  if (decision.action === 'skip') {
    execStats.skipped++;
    log('info', 'entry skipped', { handle: sig.handle, token: trade.token, reason: decision.reason });
    recorder.write({ kind: 'entry-skipped', chain: 'robinhood', handle: sig.handle, token: trade.token, reason: decision.reason, detail: decision.detail });
    notifier.send(`\u26AA not copying <b>${esc(sig.handle)}</b> \u2014 ${esc(decision.reason)}`);
    return;
  }

  const amountIn = quoteUnitsForUsd(decision.sizeUsd, executor.quoteToken);
  if (amountIn === null) {
    execStats.errors++;
    log('error', 'size could not be expressed in the quote token', { sizeUsd: decision.sizeUsd, quoteToken: executor.quoteToken });
    return;
  }

  let result;
  try {
    result = await executeBuy(execDeps, {
      wallet: ex.wallet,
      tokenIn: executor.quoteToken,
      tokenOut: trade.token,
      amountIn,
      slippageBps: ex.slippageBps ?? 300,
      maxOutputDriftBps: ex.maxOutputDriftBps ?? 300,
      quoteRetryMs: ex.quoteRetryMs ?? 15_000,
      quoteRetryIntervalMs: ex.quoteRetryIntervalMs ?? 1000,
      paper: executor.paper,
    });
  } catch (err) {
    execStats.errors++;
    log('error', 'executor threw', { token: trade.token, error: err?.message ?? String(err) });
    recorder.write({ kind: 'entry-error', chain: 'robinhood', handle: sig.handle, token: trade.token, error: err?.message ?? String(err) });
    notifier.send(`\u26A0\uFE0F copy FAILED on <code>${esc(trade.token)}</code>\n${esc(err?.message ?? 'unknown error')}`);
    return;
  }

  recorder.write({
    kind: result.ok ? (result.sent ? 'entry' : 'entry-paper') : 'entry-refused',
    chain: 'robinhood', handle: sig.handle, token: trade.token, sourceTx: sig.txHash,
    sizeUsd: decision.sizeUsd, reason: result.reason ?? null, detail: result.detail ?? null,
    plan: result.plan ?? null, hash: result.hash ?? null, at: Date.now(),
  });

  if (!result.ok) {
    execStats.refused++;
    log('warn', 'entry refused', { token: trade.token, reason: result.reason, detail: result.detail });
    notifier.send(`\u{1F6D1} refused to buy <code>${esc(trade.token)}</code>\nreason <b>${esc(result.reason)}</b>`);
    return;
  }

  // Paper and live must move the SAME state, or paper stops being a rehearsal:
  // position limits, cooldowns and already-holding would all behave differently
  // on the day the switch is flipped.
  policyState.openCount++;
  policyState.openMints.add(trade.token);
  policyState.lastEntryAt.set(sig.handle, Date.now());

  const out = Number(result.plan.simulatedOut);
  if (result.sent) {
    execStats.bought++;
    notifier.send(
      `\u2705 <b>COPIED ${esc(sig.handle)}</b> $${decision.sizeUsd}\n` +
      `<code>${esc(trade.token)}</code>\n` +
      `got ~${out.toLocaleString('en-US', { maximumFractionDigits: 0 })} units\n` +
      `${(config.explorerBase ?? '').replace(/\/$/, '')}/tx/${result.hash}`
    );
  } else {
    execStats.papered++;
    notifier.send(
      `\u{1F4C4} <b>PAPER</b> would have copied ${esc(sig.handle)} for $${decision.sizeUsd}\n` +
      `<code>${esc(trade.token)}</code>\n` +
      `simulated ~${out.toLocaleString('en-US', { maximumFractionDigits: 0 })} units, nothing signed`
    );
  }
}

// --- Robinhood Chain ---------------------------------------------------------
// Skipped entirely when no roster entry carries an EVM address, so a Solana-only
// roster does not hold a socket open against a chain nobody trades on.
let feed = null;
if (roster.size) {
  feed = new SequencerFeed({
    url: config.feedUrl,
    prefilter: prefilterOn ? roster.needles() : null,
    silenceMs: config.silenceMs ?? 15_000,
  });

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
      // Deliberately not awaited: resolving what he bought takes a receipt, and
      // the next transaction in this frame must not wait behind it.
      if (executor.enabled) {
        handleRhSignal(sig).catch((err) =>
          log('error', 'rh signal handler threw', { tx: sig.txHash, error: err?.message ?? String(err) }));
      }
    }
  });

  feed.start();
} else {
  log('info', 'robinhood chain watcher disabled', { reason: 'no EVM addresses in roster' });
}

// --- roster hot reload -------------------------------------------------------
// Only the EVM side reloads live. Solana subscriptions are bound to an open
// socket, so changing those wallets needs a restart — said plainly rather than
// silently ignored.
watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    const next = loadConfig(CONFIG_PATH);
    roster.replace(next.roster.filter((e) => e.address));
    // Sizing and cooldowns live on the raw entries, so they must follow the
    // roster or a reloaded trader keeps trading on the old numbers.
    indexTraders(next);
    // The filter must follow the roster, or a newly added wallet is scanned for
    // using the old list and never matches.
    feed?.setPrefilter(roster.size > 0 && !roster.anySelfSends ? roster.needles() : null);
    log('info', 'roster reloaded', { watching: roster.size });
    notifier.send(`🔁 EVM roster reloaded — ${roster.size} watched. Solana changes need a restart.`);
  } catch (err) {
    log('error', 'roster reload rejected, keeping previous', { error: err.message });
    notifier.send(`⚠️ Roster reload FAILED, still on the previous one\n${err.message}`);
  }
});

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
    executor: executor.enabled ? { mode: executor.paper ? 'paper' : 'live', ...execStats, open: policyState.openCount } : 'disabled',
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
