#!/usr/bin/env node
// Grind a Solana keypair until its address starts (and/or ends) with what you want.
//
//   node scripts/vanity-wallet.mjs --starts-with sky
//   node scripts/vanity-wallet.mjs --starts-with sky --ignore-case
//   node scripts/vanity-wallet.mjs --starts-with sky --ends-with fomo
//   node scripts/vanity-wallet.mjs --starts-with sky --name FIRSTFILL_SNIPER_KEY_1
//   node scripts/vanity-wallet.mjs --starts-with skyfomo --estimate
//
// --estimate prints the cost and exits without grinding. Use it before
// committing to a pattern: the difference between a good prefix and a bad one
// of the same length is four orders of magnitude, and finding that out by
// waiting is the expensive way.
//
// There is nothing to scrape. Addresses are not a list somebody holds — an
// address IS the public half of a keypair, so the only way to get one with a
// chosen prefix is to make keypairs until one matches. Every candidate here is
// generated on this machine from the OS random source and thrown away unless it
// matches; nothing is sent anywhere, and no network call is made.
//
// NEVER use an online vanity generator, and never accept a key someone else
// ground for you. Whoever runs the generator knows the key. A wallet funded with
// a key a website produced is not your wallet, and the drain usually comes weeks
// later, once it is worth taking.
//
// Like new-wallets.mjs, the secret never reaches your terminal or this chat —
// only the address does. The key is appended to a 0600 env file.
//
// COST: the FIRST character is the expensive one, and not by a little. A random
// Solana address is 44 base58 characters 94.6% of the time and 43 the rest, and
// a 44-character one can only begin with '2'..'J' — so those sixteen characters
// lead ~5.9% of all addresses each, while every other character leads only
// ~0.10%. Measured over 300,000 keypairs and matched to four decimal places by
// the exact model in firstCharProbability() below.
//
// A prefix starting with a lowercase letter is therefore ~17x more work than a
// flat 1-in-58 would suggest. "sky" is ~3.3 million keypairs, not 195,000.
// Every character AFTER the first is a clean 1 in 58 — the rest of an address
// is uniform, and so is the last character, so --ends-with costs 58 per
// character with no surcharge.
//
// The tool prints a measured-rate estimate before it starts. Read it.

import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { homedir, cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Bitcoin/Solana base58: no 0, no O, no I, no l. A pattern containing one can
// never match, and silently grinding forever is the worst way to learn that.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function grind({ starts, ends, ignoreCase, batch }) {
  const s = ignoreCase ? starts.toLowerCase() : starts;
  const e = ignoreCase ? ends.toLowerCase() : ends;
  for (let i = 0; i < batch; i++) {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    const hay = ignoreCase ? addr.toLowerCase() : addr;
    if (s && !hay.startsWith(s)) continue;
    if (e && !hay.endsWith(e)) continue;
    return { address: addr, secret: bs58.encode(kp.secretKey) };
  }
  return null;
}

if (!isMainThread) {
  // Report progress between batches so the main thread can show a rate without
  // either side having to guess how fast this machine is.
  for (;;) {
    const hit = grind(workerData);
    parentPort.postMessage(hit ? { hit } : { tried: workerData.batch });
    if (hit) break;
  }
} else {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? null : argv[i + 1]; };
  const has = (n) => argv.includes(`--${n}`);

  const starts = flag('starts-with') ?? '';
  const ends = flag('ends-with') ?? '';
  const ignoreCase = has('ignore-case');
  const name = flag('name') ?? 'VANITY_KEY';
  const file = (flag('file') ?? `${homedir()}/.fomobot-vanity.env`).replace(/^~/, homedir());

  if (!starts && !ends) {
    console.error('usage: node scripts/vanity-wallet.mjs --starts-with <text> [--ends-with <text>]');
    console.error('                                      [--ignore-case] [--estimate]');
    console.error('                                      [--name <VAR>] [--file <path>]');
    process.exit(1);
  }
  for (const [label, pattern] of [['--starts-with', starts], ['--ends-with', ends]]) {
    for (const ch of pattern) {
      if (B58.includes(ch)) continue;
      if (ignoreCase && (B58.includes(ch.toLowerCase()) || B58.includes(ch.toUpperCase()))) continue;
      throw new Error(
        `${label}: "${ch}" is not a base58 character, so no address can ever contain it. `
        + 'Solana addresses never use 0 (zero), O, I or l.',
      );
    }
  }
  if (!has('estimate')
      && existsSync(file) && new RegExp(`^\\s*(export\\s+)?${name}=`, 'm').test(readFileSync(file, 'utf8'))) {
    throw new Error(`${file} already defines ${name} — refusing to overwrite a key you may be holding funds in`);
  }

  // The variants of one pattern character that count as a match.
  const variants = (ch) => {
    if (!ignoreCase) return [ch];
    const other = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    return [...new Set([ch, other])].filter((c) => B58.includes(c));
  };
  // Probability that the FIRST character of a random address is `ch`.
  //
  // A value with exactly L base58 digits lies in [58^(L-1), 58^L), so leading
  // digit d covers [d*58^(L-1), (d+1)*58^(L-1)) clipped to that band and to the
  // keyspace. '1' is the separate case: bs58 renders a leading ZERO BYTE as
  // '1', and a zero top byte is exactly V < 2^248, so every d >= 1 band is
  // clipped there too and the whole distribution sums to 1.
  const TOTAL = 1n << 256n;
  const ZERO_TOP_BYTE = 1n << 248n;
  const firstCharProbability = (ch) => {
    const d = BigInt(B58.indexOf(ch));
    if (d < 0n) return 0;
    if (d === 0n) return 1 / 256;
    let acc = 0n, place = 1n;
    for (let L = 1; L <= 44 && place <= TOTAL; L++, place *= 58n) {
      const lo = [d * place, ZERO_TOP_BYTE].reduce((a, b) => (a > b ? a : b));
      const hi = [(d + 1n) * place, place * 58n, TOTAL].reduce((a, b) => (a < b ? a : b));
      if (hi > lo) acc += hi - lo;
    }
    return Number((acc * 10n ** 12n) / TOTAL) / 1e12;
  };

  // First character by its real distribution; everything after it, and every
  // suffix character, is uniform over the 58.
  const pStart = starts
    ? variants(starts[0]).reduce((a, c) => a + firstCharProbability(c), 0)
      * [...starts.slice(1)].reduce((a, ch) => a * (variants(ch).length / 58), 1)
    : 1;
  const pEnd = [...ends].reduce((a, ch) => a * (variants(ch).length / 58), 1);
  const probability = pStart * pEnd;
  if (probability <= 0) throw new Error('that pattern can never occur in a Solana address');
  const expected = Math.round(1 / probability);

  const threads = Math.max(1, cpus().length - 1);
  console.log(`\n  pattern     ${starts ? `starts "${starts}"` : ''}${starts && ends ? ' and ' : ''}${ends ? `ends "${ends}"` : ''}`
    + `${ignoreCase ? '  (case-insensitive)' : '  (case-sensitive)'}`);
  console.log(`  expected    ~${expected.toLocaleString()} keypairs on average`);
  if (starts && firstCharProbability(starts[0]) < 0.01 && !ignoreCase) {
    console.log(`              ("${starts[0]}" leads only ${(firstCharProbability(starts[0]) * 100).toFixed(2)}% of addresses`
      + " — 2-9 and A-J are ~58x more common as a first character)");
  }
  console.log(`  threads     ${threads}`);

  // Rate measured on THIS machine, from a real batch, rather than a number
  // guessed from the core count.
  const probeStart = Date.now();
  grind({ starts: '\u0000', ends: '', ignoreCase: false, batch: 3000 });
  const perThread = 3000 / ((Date.now() - probeStart) / 1000);
  const rate = perThread * threads;
  const secs = expected / rate;
  const human = secs < 90 ? `${Math.ceil(secs)} seconds`
    : secs < 5400 ? `${Math.ceil(secs / 60)} minutes`
    : secs < 172800 ? `${(secs / 3600).toFixed(1)} hours`
    : `${(secs / 86400).toFixed(1)} days`;
  console.log(`  this machine  ~${Math.round(rate).toLocaleString()} keypairs/s  ->  about ${human}`);
  console.log('  (an average — half the time it lands sooner, sometimes much later)\n');

  if (has('estimate')) process.exit(0);

  const started = Date.now();
  let tried = 0, done = false;
  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url), {
    workerData: { starts, ends, ignoreCase, batch: 2000 },
  }));

  const timer = setInterval(() => {
    const secs = (Date.now() - started) / 1000;
    const rate = tried / secs;
    const left = Math.max(0, expected - tried) / (rate || 1);
    process.stdout.write(`\r  ${tried.toLocaleString()} tried · ${Math.round(rate).toLocaleString()}/s`
      + ` · ~${left < 90 ? `${Math.ceil(left)}s` : `${Math.ceil(left / 60)}m`} to go     `);
  }, 500);

  for (const w of workers) {
    w.on('message', (m) => {
      if (m.tried) { tried += m.tried; return; }
      if (done) return;
      done = true;
      clearInterval(timer);
      for (const x of workers) x.terminate();

      if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
      chmodSync(file, 0o600);
      appendFileSync(file, `export ${name}='${m.hit.secret}'\n`, { mode: 0o600 });

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`\r  found after ${tried.toLocaleString()} tries in ${secs}s          \n`);
      console.log(`  address   ${m.hit.address}`);
      console.log(`      ↑ safe to share. Fund THIS.\n`);
      console.log(`  key       written to ${file} as ${name}`);
      console.log('      ↑ never printed, never in config.json, never in a chat.\n');
      console.log('  load it with:  set -a; . ' + file + '; set +a\n');
      process.exit(0);
    });
    w.on('error', (err) => { clearInterval(timer); throw err; });
  }
}
