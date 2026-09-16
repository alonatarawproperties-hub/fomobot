#!/usr/bin/env node
// Prove the RPC endpoint can actually do what the snipe needs — before a launch,
// not during one.
//
//   node scripts/check-rpc.mjs                 # reads config.json
//   node scripts/check-rpc.mjs <helius-key>    # builds the URLs from an API key
//   node scripts/check-rpc.mjs <httpUrl> <wsUrl>
//
// THE QUESTION THIS EXISTS TO ANSWER. The sniper has two triggers, and they are
// not equally available. `accountSubscribe` is universal but needs the DBC config
// known in advance. `programSubscribe` with a memcmp filter needs nothing known —
// it is the whole discovery path — and providers routinely disable it, rate-limit
// it, or refuse `processed` on it. Finding that out at the launch means finding
// out by missing the launch.
//
// Nothing here signs, sends, or spends. It reads and it subscribes.

import { readFileSync } from 'node:fs';
import { DBC_PROGRAM_ID, VIRTUAL_POOL, WSOL_MINT } from '../src/meteora/dbc.mjs';

const argv = process.argv.slice(2);
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

function resolveUrls() {
  if (argv.length >= 2 && argv[0].startsWith('http')) return { httpUrl: argv[0], wsUrl: argv[1] };
  if (argv.length === 1) {
    const key = argv[0].trim();
    return {
      httpUrl: `https://mainnet.helius-rpc.com/?api-key=${key}`,
      wsUrl: `wss://mainnet.helius-rpc.com/?api-key=${key}`,
    };
  }
  const path = process.env.FIRSTFILL_CONFIG ?? './config.json';
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    console.error(`could not read ${path}: ${e.message}`);
    console.error('pass a Helius api key, or two URLs, as arguments instead');
    process.exit(1);
  }
  const httpUrl = raw.snipe?.httpUrl ?? raw.solana?.httpUrl;
  const wsUrl = raw.snipe?.wsUrl ?? raw.solana?.wsUrl;
  if (!httpUrl || !wsUrl) { console.error(`${path} has no httpUrl/wsUrl`); process.exit(1); }
  return { httpUrl, wsUrl };
}

const { httpUrl, wsUrl } = resolveUrls();
// Never print the key. The host is the part worth seeing.
const scrub = (u) => { try { return new URL(u).host; } catch { return '(unparseable url)'; } };
log('info', 'endpoint', { http: scrub(httpUrl), ws: scrub(wsUrl) });

let failures = 0;
const fail = (what, why) => { failures++; log('error', what, { why }); };

async function call(method, params, timeoutMs = 8000) {
  const started = Date.now();
  const res = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  return { ...json, ms: Date.now() - started, status: res.status };
}

// --- HTTP ------------------------------------------------------------------
log('info', '--- http ---');

try {
  const r = await call('getSlot', [{ commitment: 'processed' }]);
  if (r.error) fail('getSlot rejected', r.error.message);
  else log('info', 'getSlot ok', { slot: r.result, ms: r.ms });
} catch (e) { fail('getSlot failed outright', e.message); }

try {
  const r = await call('getVersion', []);
  if (!r.error) log('info', 'node version', { version: r.result?.['solana-core'] });
} catch { /* informational only */ }

// Round-trip latency matters more than any single call, so sample it.
try {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const r = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (r.error) { fail('getLatestBlockhash rejected', r.error.message); break; }
    times.push(r.ms);
  }
  if (times.length) {
    const sorted = [...times].sort((a, b) => a - b);
    log('info', 'blockhash round trip', {
      samples: times, best: sorted[0], median: sorted[Math.floor(sorted.length / 2)], worst: sorted.at(-1),
    });
  }
} catch (e) { fail('getLatestBlockhash failed outright', e.message); }

// The DBC program must be readable, and must be a program. If this is wrong,
// nothing else matters.
try {
  const r = await call('getAccountInfo', [DBC_PROGRAM_ID.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
  if (r.error) fail('could not read the DBC program', r.error.message);
  else if (!r.result?.value) fail('the DBC program does not exist on this cluster', 'is this endpoint really mainnet?');
  else log('info', 'DBC program present', { executable: r.result.value.executable, owner: r.result.value.owner });
} catch (e) { fail('reading the DBC program failed', e.message); }

// --- WebSocket -------------------------------------------------------------
log('info', '--- websocket ---');

const results = await new Promise((resolve) => {
  const out = { open: false, account: null, program: null, programError: null, accountError: null };
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (e) { fail('could not construct the websocket', e.message); return resolve(out); }

  const done = () => { try { ws.close(); } catch { /* going anyway */ } resolve(out); };
  const timer = setTimeout(() => { out.timedOut = true; done(); }, 15000);

  ws.addEventListener('open', () => {
    out.open = true;
    // 1: a plain account subscription — the trigger that always exists.
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'accountSubscribe',
      params: [WSOL_MINT.toBase58(), { encoding: 'base64', commitment: 'processed' }],
    }));
    // 2: the filtered program subscription — the one that may be refused. The
    // memcmp is a mint that cannot exist, so this matches nothing and costs
    // nothing; we only care whether the endpoint ACCEPTS the shape.
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'programSubscribe',
      params: [
        DBC_PROGRAM_ID.toBase58(),
        {
          encoding: 'base64', commitment: 'processed',
          filters: [
            { dataSize: VIRTUAL_POOL.SIZE },
            { memcmp: { offset: VIRTUAL_POOL.BASE_MINT, bytes: '11111111111111111111111111111111' } },
          ],
        },
      ],
    }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id === 1) {
      if (msg.error) out.accountError = msg.error.message ?? String(msg.error);
      else out.account = msg.result;
    }
    if (msg.id === 2) {
      if (msg.error) out.programError = msg.error.message ?? String(msg.error);
      else out.program = msg.result;
    }
    if ((out.account !== null || out.accountError) && (out.program !== null || out.programError)) {
      clearTimeout(timer);
      done();
    }
  });

  ws.addEventListener('error', (e) => { out.socketError = e?.message ?? 'socket error'; });
  ws.addEventListener('close', () => { clearTimeout(timer); resolve(out); });
});

if (!results.open) fail('the websocket never opened', results.socketError ?? 'no connection');
else log('info', 'websocket open');

if (results.account !== null) log('info', 'accountSubscribe ACCEPTED', { subscription: results.account });
else fail('accountSubscribe refused', results.accountError ?? 'no reply');

if (results.program !== null) {
  log('info', 'programSubscribe ACCEPTED', { subscription: results.program });
} else {
  // Not counted as a failure: the pre-armed path does not need it. But it decides
  // whether a snipe WITHOUT the config is possible at all, so it is stated loudly.
  log('warn', 'programSubscribe REFUSED', {
    why: results.programError ?? 'no reply',
    meaning: 'the no-config discovery trigger will not work on this endpoint — you must supply snipe.config',
  });
}

console.log();
if (failures) {
  log('error', `${failures} check(s) failed — do not arm against this endpoint`);
  process.exit(1);
}
log('info', 'endpoint is usable', {
  preArmed: 'yes',
  discovery: results.program !== null ? 'yes' : 'NO — snipe.config is required',
});
