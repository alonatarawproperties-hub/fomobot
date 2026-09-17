#!/usr/bin/env node
// Read a known-good buy and list the contracts it went through.
//
//   node scripts/find-venues.mjs <txHash> [--rpc <url>]
//
// WHY THIS EXISTS RATHER THAN A HARDCODED ADDRESS. The venue whitelist decides
// what counts as a purchase, so a wrong address there does not throw — it stops
// every real buy being copied, quietly. fomo's router is proprietary and can be
// redeployed, so the address cannot be shipped in the source and trusted.
//
// So it is READ from a transaction that is known to be a real buy. Point this at
// one and it prints every contract the transaction touched, ranked by how many
// events each emitted — a router is the one doing the work, and shows up at the
// top. Tokens are labelled so they are not mistaken for venues: the token is
// never the venue, which is the whole point of the rule above it.
//
// Reads only. Nothing signs, sends or spends.

import { readFileSync } from 'node:fs';
import { JsonRpcProvider } from 'ethers';
import { TRANSFER_TOPIC } from '../src/robinhood-trade.mjs';
import { ADDRESSES } from '../src/chain/robinhood.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
const die = (m) => { log('error', m); process.exit(1); };

if (!positional.length) {
  console.error('usage: node scripts/find-venues.mjs <txHash> [--rpc <url>]');
  console.error('point it at a transaction you KNOW was a real buy.');
  process.exit(1);
}
const txHash = positional[0];

let rpcUrl = flag('rpc');
if (!rpcUrl) {
  try {
    const raw = JSON.parse(readFileSync(process.env.FIRSTFILL_CONFIG ?? './config.json', 'utf8'));
    rpcUrl = raw.executor?.rpcUrl;
  } catch { /* fall through */ }
}
if (!rpcUrl) die('no rpcUrl — set executor.rpcUrl in config.json, or pass --rpc');

const provider = new JsonRpcProvider(rpcUrl);
const lower = (s) => String(s ?? '').toLowerCase();

const [tx, receipt] = await Promise.all([
  provider.getTransaction(txHash),
  provider.getTransactionReceipt(txHash),
]);
if (!receipt) die(`transaction ${txHash} not found on this RPC`);
if (receipt.status !== 1) log('warn', 'this transaction FAILED on chain', { status: receipt.status });

log('info', 'transaction', {
  to: lower(tx?.to),
  from: lower(tx?.from),
  selector: tx?.data ? tx.data.slice(0, 10) : null,
  logs: receipt.logs.length,
  gasUsed: receipt.gasUsed?.toString() ?? null,
});

// Who emitted, and how much. A router does the work and says so.
const emitters = new Map();
const tokens = new Set();
for (const l of receipt.logs) {
  const addr = lower(l.address);
  emitters.set(addr, (emitters.get(addr) ?? 0) + 1);
  // A 3-topic Transfer is an ERC-20 announcing itself. Tokens are never venues.
  if (l.topics?.length === 3 && lower(l.topics[0]) === TRANSFER_TOPIC) tokens.add(addr);
}

const known = new Map(Object.entries(ADDRESSES).map(([name, addr]) => [lower(addr), name]));

const ranked = [...emitters.entries()]
  .map(([address, events]) => ({
    address,
    events,
    isToken: tokens.has(address),
    known: known.get(address) ?? null,
  }))
  .sort((a, b) => b.events - a.events);

console.log();
log('info', 'contracts this transaction touched, most active first');
for (const r of ranked) {
  log(r.isToken ? 'info' : 'signal', r.isToken ? 'token (never a venue)' : 'CANDIDATE VENUE', {
    address: r.address,
    events: r.events,
    knownAs: r.known,
  });
}

// The transaction's own target counts too: a swap sent directly to a router has
// that router as `to`, and it may emit nothing itself.
const to = lower(tx?.to);
if (to && !emitters.has(to)) {
  log('signal', 'CANDIDATE VENUE (the transaction target, emitted nothing)', { address: to, knownAs: known.get(to) ?? null });
}

const candidates = ranked.filter((r) => !r.isToken).map((r) => r.address);
if (to && !candidates.includes(to)) candidates.unshift(to);

console.log();
log('info', 'put the ones you recognise in config.json', {
  'executor.venues': candidates,
  caveat: 'REVIEW THIS LIST. Anything here becomes proof that a token arrival was a purchase, so an address that is not really a venue lets a false positive back in — and a missing one stops real buys being copied.',
});
