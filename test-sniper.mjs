// Offline tests for the pump.fun sniper. No network.
//
// The fixtures below are not invented. Every number came off Solana mainnet on
// 2026-09-18 and the probe output is in the commit message. The most important
// one is a complete, self-consistent chain from a single real launch:
//
//   a buy instruction carried  amount = 34_612_903_225_806
//   the curve it hit began at  vSol 30_000_000_000 / vTok 1_073_000_000_000_000
//   the curve it left behind:  vSol 31_000_000_000 / vTok 1_038_387_096_774_194
//
// and 1_073_000_000_000_000 - 34_612_903_225_806 == 1_038_387_096_774_194, so
// the three agree. Any change to the curve maths that breaks that breaks reality.

import assert from 'node:assert/strict';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  decodeGlobal, decodeBondingCurve, deriveAta, deriveBondingCurve,
  createAtaIdempotentInstruction, buildBuyInstruction,
  tokensForSolIn, solIntoCurveForBudget, planLadder, applyBuy,
  GLOBAL_OFFSET, BUY_DISCRIMINATOR, PUMP_PROGRAM, TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
} from './src/solana/pump.mjs';
import {
  loadSniperWallets, keypairFromBase58, solStringToLamports, auditSplit,
  MAX_BUNDLE_TRANSACTIONS,
} from './src/solana/wallets.mjs';
import { JitoClient, normaliseStatus, MAX_BUNDLE_SIZE } from './src/solana/jito.mjs';
import { PumpSniper, ATA_RENT_LAMPORTS, SIGNATURE_FEE_LAMPORTS } from './src/solana/sniper.mjs';
import { decideSnipeCommand, resolveTelegram } from './src/solana/snipe-control.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };

// ── mainnet fixtures ────────────────────────────────────────────────────────
const INITIAL_V_SOL = 30_000_000_000n;
const INITIAL_V_TOK = 1_073_000_000_000_000n;
const INITIAL_R_TOK = 793_100_000_000_000n;
const TOTAL_SUPPLY = 1_000_000_000_000_000n;
const FEE_BPS = 95n;
// The observed first buy on mint CQzFaJARBQVg…
const OBSERVED_SOL_IN = 1_000_000_000n;
const OBSERVED_TOKENS_OUT = 34_612_903_225_806n;
const OBSERVED_V_TOK_AFTER = 1_038_387_096_774_194n;

console.log('\npump.fun curve maths');

{
  const out = tokensForSolIn(INITIAL_V_SOL, INITIAL_V_TOK, OBSERVED_SOL_IN);
  assert.equal(out, OBSERVED_TOKENS_OUT);
  ok('1 SOL into a fresh curve reproduces the exact token amount mainnet paid out');
}
{
  // The program rounds the NEW RESERVE up, not the output down. The two differ
  // by one raw unit, and floor is the one that is wrong.
  const k = INITIAL_V_SOL * INITIAL_V_TOK;
  const floorOut = INITIAL_V_TOK - k / (INITIAL_V_SOL + OBSERVED_SOL_IN);
  assert.equal(floorOut, OBSERVED_TOKENS_OUT + 1n);
  assert.notEqual(floorOut, OBSERVED_TOKENS_OUT);
  ok('flooring the output instead of ceiling the reserve is off by exactly one unit');
}
{
  const after = applyBuy(
    { virtualSolReserves: INITIAL_V_SOL, virtualTokenReserves: INITIAL_V_TOK,
      realSolReserves: 0n, realTokenReserves: INITIAL_R_TOK },
    OBSERVED_SOL_IN, OBSERVED_TOKENS_OUT,
  );
  assert.equal(after.virtualTokenReserves, OBSERVED_V_TOK_AFTER);
  assert.equal(after.virtualSolReserves, 31_000_000_000n);
  ok('applying that buy lands on the reserves the chain actually shows afterwards');
}
{
  assert.equal(tokensForSolIn(INITIAL_V_SOL, INITIAL_V_TOK, 0n), 0n);
  assert.equal(tokensForSolIn(INITIAL_V_SOL, INITIAL_V_TOK, -5n), 0n);
  ok('a zero or negative input buys nothing rather than throwing or going negative');
}
{
  // Fee on top: a 1 SOL budget puts slightly less than 1 SOL into the curve,
  // so the TOTAL charged lands at the budget rather than above it.
  const solIn = solIntoCurveForBudget(1_000_000_000n, FEE_BPS);
  assert.ok(solIn < 1_000_000_000n);
  const total = solIn + (solIn * FEE_BPS) / 10000n;
  assert.ok(total <= 1_000_000_000n, `total ${total} must not exceed the budget`);
  ok('sizing for a budget keeps total outlay at or under it once the fee is added');
}

console.log('\nthe five-wallet ladder');

const LEGS = [
  { label: 'w1', index: 0, address: 'A', budgetLamports: 2_600_000_000n },
  { label: 'w2', index: 1, address: 'B', budgetLamports: 1_400_000_000n },
  { label: 'w3', index: 2, address: 'C', budgetLamports: 2_100_000_000n },
  { label: 'w4', index: 3, address: 'D', budgetLamports: 1_050_000_000n },
  { label: 'w5', index: 4, address: 'E', budgetLamports: 2_850_000_000n },
];
const FRESH = {
  virtualSolReserves: INITIAL_V_SOL, virtualTokenReserves: INITIAL_V_TOK,
  realSolReserves: 0n, realTokenReserves: INITIAL_R_TOK, complete: false,
};

{
  const { legs } = planLadder({ reserves: FRESH, legs: LEGS, feeBasisPoints: FEE_BPS, slippageBps: 500n });
  assert.equal(legs.length, 5);
  // Leg 1 sees the fresh curve; every later leg sees more SOL in it.
  assert.equal(legs[0].quotedAgainst.virtualSolReserves, INITIAL_V_SOL);
  for (let i = 1; i < legs.length; i++) {
    assert.ok(
      legs[i].quotedAgainst.virtualSolReserves > legs[i - 1].quotedAgainst.virtualSolReserves,
      `leg ${i} must be quoted against a curve the previous leg already moved`,
    );
  }
  ok('each leg is quoted against the curve the leg before it leaves behind');
}
{
  const { legs } = planLadder({ reserves: FRESH, legs: LEGS, feeBasisPoints: FEE_BPS, slippageBps: 500n });
  // Price per token, scaled, must get worse down the ladder — the later wallets
  // are buying from the earlier ones' impact. Compared per-unit, not per-leg,
  // because the budgets deliberately differ.
  const pricePerToken = (l) => (l.solIntoCurve * 10n ** 18n) / l.expectedTokens;
  for (let i = 1; i < legs.length; i++) {
    assert.ok(pricePerToken(legs[i]) > pricePerToken(legs[i - 1]), `leg ${i} should pay more per token`);
  }
  ok('the later wallets pay more per token, which is the real cost of stacking five buys');
}
{
  // The bug the ladder exists to prevent: quoting every leg against the
  // PRE-LAUNCH curve. Leg 5 would then ask for more tokens than the curve can
  // give at its cap, revert, and void the bundle for all five.
  const naive = LEGS.map((l) => tokensForSolIn(INITIAL_V_SOL, INITIAL_V_TOK, solIntoCurveForBudget(l.budgetLamports, FEE_BPS)));
  const { legs } = planLadder({ reserves: FRESH, legs: LEGS, feeBasisPoints: FEE_BPS, slippageBps: 0n });
  assert.ok(naive[4] > legs[4].expectedTokens, 'naive quoting must over-ask on the last leg');
  ok('quoting every leg against the pre-launch curve would over-ask, and the ladder does not');
}
{
  const tight = planLadder({ reserves: FRESH, legs: LEGS, feeBasisPoints: FEE_BPS, slippageBps: 0n });
  const loose = planLadder({ reserves: FRESH, legs: LEGS, feeBasisPoints: FEE_BPS, slippageBps: 2000n });
  for (let i = 0; i < 5; i++) {
    assert.ok(loose.legs[i].requestTokens < tight.legs[i].requestTokens);
    // The cap never moves with slippage — it is the wallet's budget, full stop.
    assert.equal(loose.legs[i].maxSolCost, LEGS[i].budgetLamports);
    assert.equal(tight.legs[i].maxSolCost, LEGS[i].budgetLamports);
  }
  ok('slippage shaves the tokens requested and never raises the SOL cap');
}
{
  assert.throws(() => planLadder({ reserves: FRESH, legs: [], feeBasisPoints: FEE_BPS, slippageBps: 0n }), /no legs/);
  assert.throws(() => planLadder({ reserves: FRESH, legs: LEGS, feeBasisPoints: FEE_BPS, slippageBps: 10000n }), /out of range/);
  assert.throws(
    () => planLadder({ reserves: FRESH, legs: [{ label: 'x', budgetLamports: 0n }], feeBasisPoints: FEE_BPS, slippageBps: 0n }),
    /non-positive budget/,
  );
  ok('an empty ladder, a 100% shave and a zero budget are all refused');
}

console.log('\naccount layouts');

{
  // Build a Global account with the values mainnet holds, at the offsets we read.
  const buf = Buffer.alloc(1087);
  buf.writeBigUInt64LE(INITIAL_V_TOK, GLOBAL_OFFSET.initialVirtualTokenReserves);
  buf.writeBigUInt64LE(INITIAL_V_SOL, GLOBAL_OFFSET.initialVirtualSolReserves);
  buf.writeBigUInt64LE(INITIAL_R_TOK, GLOBAL_OFFSET.initialRealTokenReserves);
  buf.writeBigUInt64LE(TOTAL_SUPPLY, GLOBAL_OFFSET.tokenTotalSupply);
  buf.writeBigUInt64LE(FEE_BPS, GLOBAL_OFFSET.feeBasisPoints);
  const r = Keypair.generate().publicKey;
  r.toBuffer().copy(buf, GLOBAL_OFFSET.feeRecipients);
  const g = decodeGlobal(buf);
  assert.equal(g.feeBasisPoints, 95n);
  assert.equal(g.initialVirtualSolReserves, INITIAL_V_SOL);
  assert.equal(g.initialVirtualTokenReserves, INITIAL_V_TOK);
  assert.equal(g.feeRecipients.length, 1); // the other seven slots are zeroed
  ok('the Global decoder reads 95 bps and the initial reserves off the real offsets');
}
{
  assert.throws(() => decodeGlobal(Buffer.alloc(100)), /too short/);
  assert.throws(() => decodeGlobal(Buffer.alloc(1087)), /no fee recipients/);
  ok('a truncated or empty Global is refused rather than decoded into zeros');
}
{
  const creator = Keypair.generate().publicKey;
  const buf = Buffer.alloc(151);
  buf.writeBigUInt64LE(OBSERVED_V_TOK_AFTER, 8);
  buf.writeBigUInt64LE(31_000_000_000n, 16);
  buf.writeBigUInt64LE(426_099_665_690_753n, 24);
  buf.writeBigUInt64LE(1_000_000_000n, 32);
  buf.writeBigUInt64LE(TOTAL_SUPPLY, 40);
  buf[48] = 0;
  creator.toBuffer().copy(buf, 49);
  buf[81] = 0;
  buf[82] = 0;
  const c = decodeBondingCurve(buf);
  assert.equal(c.virtualTokenReserves, OBSERVED_V_TOK_AFTER);
  assert.equal(c.virtualSolReserves, 31_000_000_000n);
  assert.equal(c.complete, false);
  assert.equal(c.creator.toBase58(), creator.toBase58());
  assert.equal(c.isCashback, false);
  ok('a 151-byte curve decodes to the values mainnet shows, creator included');
}
{
  const buf = Buffer.alloc(151);
  buf[48] = 1;
  assert.equal(decodeBondingCurve(buf).complete, true);
  assert.equal(decodeBondingCurve(null), null);
  assert.equal(decodeBondingCurve(Buffer.alloc(40)), null);
  ok('a graduated curve reports complete, and short data decodes to null not garbage');
}
{
  // Captured from @solana/spl-token before that dependency was dropped.
  const owner = new PublicKey('11111111111111111111111111111113');
  const mint = new PublicKey('11111111111111111111111111111114');
  assert.equal(deriveAta(owner, mint).toBase58(), 'AzFK8zEHKmPyM227MGAr8rPkX46BnAWGm7RL24TmPXg1');
  ok('the hand-rolled ATA derivation still matches what spl-token produced');
}
{
  const payer = new PublicKey('11111111111111111111111111111112');
  const owner = new PublicKey('11111111111111111111111111111113');
  const mint = new PublicKey('11111111111111111111111111111114');
  const ix = createAtaIdempotentInstruction({ payer, owner, mint });
  assert.equal(ix.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM.toBase58());
  assert.deepEqual([...ix.data], [1]); // CreateIdempotent, not Create
  assert.equal(ix.keys.length, 6);
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].pubkey.toBase58(), deriveAta(owner, mint).toBase58());
  assert.equal(ix.keys[5].pubkey.toBase58(), TOKEN_PROGRAM.toBase58());
  ok('the ATA instruction is idempotent-create over the six accounts, byte for byte');
}

console.log('\nthe buy instruction');

{
  const mint = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const feeRecipient = Keypair.generate().publicKey;
  const buybackRecipient = Keypair.generate().publicKey;
  const ix = buildBuyInstruction({
    mint, buyer, creator, amountTokens: 34_612_903_225_806n,
    maxSolCost: 1_100_000_000n, feeRecipient, buybackRecipient,
  });

  assert.equal(ix.programId.toBase58(), PUMP_PROGRAM.toBase58());
  // Every buy decoded from mainnet carried exactly 18 accounts.
  assert.equal(ix.keys.length, 18);
  assert.equal(ix.data.length, 24);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...BUY_DISCRIMINATOR]);
  assert.equal(ix.data.readBigUInt64LE(8), 34_612_903_225_806n);  // tokens OUT
  assert.equal(ix.data.readBigUInt64LE(16), 1_100_000_000n);      // SOL cap
  ok('a buy encodes as discriminator + tokens + cap over exactly 18 accounts');
}
{
  const mint = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;
  const ix = buildBuyInstruction({
    mint, buyer, creator: Keypair.generate().publicKey,
    amountTokens: 1n, maxSolCost: 1n,
    feeRecipient: Keypair.generate().publicKey,
    buybackRecipient: Keypair.generate().publicKey,
  });
  // The positions that decide where the money goes. Reordering these is the
  // single most damaging edit possible in this file.
  assert.equal(ix.keys[2].pubkey.toBase58(), mint.toBase58());
  assert.equal(ix.keys[3].pubkey.toBase58(), deriveBondingCurve(mint).toBase58());
  assert.equal(ix.keys[5].pubkey.toBase58(), deriveAta(buyer, mint).toBase58());
  assert.equal(ix.keys[6].pubkey.toBase58(), buyer.toBase58());
  assert.equal(ix.keys[6].isSigner, true);
  assert.equal(ix.keys[6].isWritable, true);
  assert.equal(ix.keys[1].isWritable, true);  // fee recipient receives
  assert.equal(ix.keys[17].isWritable, true); // buyback recipient receives
  ok('the mint, curve, buyer and both fee sinks sit at the indices the program expects');
}
{
  const args = {
    mint: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey,
    creator: Keypair.generate().publicKey, feeRecipient: Keypair.generate().publicKey,
    buybackRecipient: Keypair.generate().publicKey,
  };
  assert.throws(() => buildBuyInstruction({ ...args, amountTokens: 0n, maxSolCost: 1n }), /amountTokens/);
  assert.throws(() => buildBuyInstruction({ ...args, amountTokens: 1n, maxSolCost: 0n }), /maxSolCost/);
  ok('a zero token request or a zero cap is refused before it can be signed');
}

console.log('\nwallets and keys');

const mkWallet = () => {
  const kp = Keypair.generate();
  return { kp, secret: bs58.encode(kp.secretKey), address: kp.publicKey.toBase58() };
};

{
  const w = mkWallet();
  const kp = keypairFromBase58(w.secret, 'T');
  assert.equal(kp.publicKey.toBase58(), w.address);
  ok('a 64-byte base58 secret round-trips to the address it belongs to');
}
{
  const kp = Keypair.generate();
  assert.throws(() => keypairFromBase58(bs58.encode(kp.secretKey.slice(0, 32)), 'T'), /32-byte seed/);
  assert.throws(() => keypairFromBase58('not base58 !!!', 'T'), /not valid base58|64-byte/);
  ok('a 32-byte seed is named as such rather than silently expanded into another address');
}
{
  const a = mkWallet(), b = mkWallet();
  const cfg = [{ address: a.address, sol: '2.6' }, { address: b.address, sol: '1.4' }];
  const env = { FIRSTFILL_SNIPER_KEY_1: a.secret, FIRSTFILL_SNIPER_KEY_2: b.secret };
  const loaded = loadSniperWallets(cfg, env);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].budgetLamports, 2_600_000_000n);
  assert.equal(loaded[1].budgetLamports, 1_400_000_000n);
  ok('wallets load in order with their budgets parsed to lamports');
}
{
  const a = mkWallet(), b = mkWallet();
  // Key 1 belongs to b, but the config says a. Without this check the bot would
  // plan for a and sign with b — silently, on every trade.
  const env = { FIRSTFILL_SNIPER_KEY_1: b.secret };
  assert.throws(() => loadSniperWallets([{ address: a.address, sol: '1' }], env), /belongs to/);
  ok('a key that does not match its configured address refuses to start');
}
{
  const a = mkWallet();
  assert.throws(
    () => loadSniperWallets([{ address: a.address, sol: '1', privateKey: a.secret }], { FIRSTFILL_SNIPER_KEY_1: a.secret }),
    /carries a key in the config/,
  );
  ok('a key found in the config file is a startup failure, not a warning');
}
{
  const a = mkWallet();
  const env = { FIRSTFILL_SNIPER_KEY_1: a.secret, FIRSTFILL_SNIPER_KEY_2: a.secret };
  assert.throws(
    () => loadSniperWallets([{ address: a.address, sol: '1' }, { address: a.address, sol: '1' }], env),
    /appears more than once/,
  );
  ok('the same wallet twice is refused — it defeats the split and misprices the second leg');
}
{
  const ws = Array.from({ length: 6 }, mkWallet);
  const cfg = ws.map((w) => ({ address: w.address, sol: '1' }));
  const env = Object.fromEntries(ws.map((w, i) => [`FIRSTFILL_SNIPER_KEY_${i + 1}`, w.secret]));
  assert.throws(() => loadSniperWallets(cfg, env), /at most 5/);
  assert.equal(MAX_BUNDLE_TRANSACTIONS, 5);
  ok('a sixth wallet is refused because it could not ride the same bundle');
}
{
  const a = mkWallet();
  assert.throws(() => loadSniperWallets([{ address: a.address, sol: '1' }], {}), /is not set/);
  ok('a missing key names the env var and the wallet it belongs to');
}

console.log('\nbudget arithmetic');

{
  assert.equal(solStringToLamports('1', 'x'), 1_000_000_000n);
  assert.equal(solStringToLamports('2.6', 'x'), 2_600_000_000n);
  assert.equal(solStringToLamports('0.000000001', 'x'), 1n);
  // 0.1 + 0.2 is where a float implementation gives itself away.
  assert.equal(solStringToLamports('0.1', 'x') + solStringToLamports('0.2', 'x'), 300_000_000n);
  ok('SOL parses through integers, so a tenth plus a fifth is exactly three tenths');
}
{
  assert.throws(() => solStringToLamports('0', 'x'), /greater than zero/);
  assert.throws(() => solStringToLamports('-1', 'x'), /positive decimal/);
  assert.throws(() => solStringToLamports('1.0000000001', 'x'), /9 decimal places/);
  assert.throws(() => solStringToLamports('1e9', 'x'), /positive decimal/);
  ok('zero, negative, over-precise and exponent-notation amounts are all refused');
}
{
  const wallets = LEGS.map((l) => ({ budgetLamports: l.budgetLamports }));
  const a = auditSplit({
    wallets, totalLamports: 10_000_000_000n, tipLamports: 5_000_000n,
    ataRentLamports: ATA_RENT_LAMPORTS, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS,
  });
  assert.equal(a.buyTotal, 10_000_000_000n);
  // The buys alone eat the whole 10 SOL, so rent, fees and the tip have nowhere
  // to come from. This is the failure the audit exists to catch.
  assert.equal(a.withinBudget, false);
  assert.ok(a.excess > 0n);
  assert.equal(a.allAmountsIdentical, false);
  assert.equal(a.distinctAmounts, 5);
  ok('a split that spends the entire budget on buys is caught, not discovered mid-bundle');
}
{
  const wallets = [2_500_000_000n, 1_300_000_000n, 2_000_000_000n, 1_000_000_000n, 2_700_000_000n]
    .map((b) => ({ budgetLamports: b }));
  const a = auditSplit({
    wallets, totalLamports: 10_000_000_000n, tipLamports: 5_000_000n,
    ataRentLamports: ATA_RENT_LAMPORTS, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS,
  });
  assert.equal(a.buyTotal, 9_500_000_000n);
  assert.equal(a.withinBudget, true);
  assert.ok(a.headroom > 0n);
  ok('holding back half a SOL leaves room for rent, signatures and the tip');
}
{
  const wallets = Array.from({ length: 5 }, () => ({ budgetLamports: 1_000_000_000n }));
  const a = auditSplit({
    wallets, totalLamports: 10_000_000_000n, tipLamports: 5_000_000n,
    ataRentLamports: ATA_RENT_LAMPORTS, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS,
  });
  // Reported, never refused: an even split is legal, it is just visible.
  assert.equal(a.allAmountsIdentical, true);
  assert.equal(a.withinBudget, true);
  ok('five identical amounts are reported as identical but not refused');
}

console.log('\njito bundling');

{
  assert.equal(MAX_BUNDLE_SIZE, 5);
  const j = new JitoClient({ fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(j.sendBundle([]), /empty bundle/);
  await assert.rejects(j.sendBundle(['a', 'b', 'c', 'd', 'e', 'f']), /exceeds the 5-transaction bundle limit/);
  ok('an empty bundle and a sixth transaction are both refused before any network call');
}
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('frankfurt')) return { json: async () => ({ result: 'BUNDLE123' }) };
    return { json: async () => ({ error: { message: 'relay down' } }) };
  };
  const j = new JitoClient({ relays: ['https://a.example', 'https://frankfurt.example'], fetchImpl });
  const r = await j.sendBundle(['tx1', 'tx2']);
  assert.equal(r.bundleId, 'BUNDLE123');
  assert.deepEqual(r.acceptedBy, ['https://frankfurt.example']);
  assert.equal(calls.length, 2); // every relay tried, in parallel
  ok('one accepting relay is enough, and all of them are asked at once');
}
{
  const j = new JitoClient({
    relays: ['https://a.example'],
    fetchImpl: async () => ({ json: async () => ({ error: { message: 'nope' } }) }),
  });
  await assert.rejects(j.sendBundle(['tx']), /all 1 relays refused/);
  ok('a bundle no relay accepted throws rather than reporting a send');
}
{
  assert.equal(normaliseStatus('Landed'), 'landed');
  assert.equal(normaliseStatus('confirmed'), 'landed');
  assert.equal(normaliseStatus('InFlight'), 'pending');
  assert.equal(normaliseStatus('Dropped'), 'failed');
  // The important one: anything we do not recognise must NOT read as landed.
  assert.equal(normaliseStatus('SomethingNew'), 'unknown');
  assert.equal(normaliseStatus(undefined), 'unknown');
  ok('an unrecognised bundle status reads as unknown, never as landed');
}

console.log('\nthe fire gate');

{
  const w = mkWallet();
  const sniper = new PumpSniper({
    connection: {}, jito: {},
    wallets: [{ index: 0, address: w.address, keypair: w.kp, budgetLamports: 1_000_000_000n }],
    mints: [Keypair.generate().publicKey.toBase58()],
    slippageBps: 500n, tipLamports: 5_000_000n, maxPreBuyLamports: 0n, paper: true,
  });
  const mint = sniper.mints[0];
  const fresh = { complete: false, realSolReserves: 0n };

  assert.equal(sniper.assess(mint, fresh).act, true);
  assert.equal(sniper.assess(mint, { complete: true, realSolReserves: 0n }).reason, 'graduated');
  assert.equal(sniper.assess(mint, null).reason, 'undecodable');
  assert.equal(sniper.assess(mint, { complete: false, realSolReserves: 1n }).reason, 'pre-bought');

  sniper.fired.add(mint.toBase58());
  assert.equal(sniper.assess(mint, fresh).reason, 'already-fired');
  ok('graduated, undecodable, pre-bought and already-fired curves are each refused by name');
}
{
  const w = mkWallet();
  const base = {
    connection: {}, jito: {},
    wallets: [{ index: 0, address: w.address, keypair: w.kp, budgetLamports: 1n }],
    mints: [Keypair.generate().publicKey.toBase58()],
    slippageBps: 500n, tipLamports: 1n,
  };
  assert.throws(() => new PumpSniper({ ...base, wallets: [] }), /no wallets/);
  assert.throws(() => new PumpSniper({ ...base, tipWalletIndex: 3 }), /outside the wallet list/);
  assert.throws(() => new PumpSniper({ ...base, connection: null }), /connection is required/);
  assert.throws(() => new PumpSniper({ ...base, mints: 'not-an-array' }), /must be an array/);
  ok('a sniper with no wallets, a tip from a wallet it lacks, or a non-array target will not construct');
}
{
  const w = mkWallet();
  const base = {
    connection: {}, jito: {},
    wallets: [{ index: 0, address: w.address, keypair: w.kp, budgetLamports: 1n }],
    slippageBps: 500n, tipLamports: 1n,
  };
  // Booting with no contract address is the NORMAL case: it usually arrives
  // later, over Telegram. It must not be an error until something tries to watch.
  const s = new PumpSniper(base);
  assert.equal(s.target, null);
  assert.equal(s.mode, 'paper');
  await assert.rejects(s.watch(), /prime\(\) has not run/);
  s.global = { feeBasisPoints: FEE_BPS };
  await assert.rejects(s.watch(), /no target set/);
  ok('booting with no contract address is legal, and only watching without one is refused');
}
{
  const w = mkWallet();
  const s = new PumpSniper({
    connection: {}, jito: {},
    wallets: [{ index: 0, address: w.address, keypair: w.kp, budgetLamports: 1n }],
    slippageBps: 500n, tipLamports: 1n, paper: true,
  });
  const mint = Keypair.generate().publicKey.toBase58();
  await s.setTarget(mint);
  assert.equal(s.target, mint);

  // Re-targeting must clear the fired flag, or a mint bought in an earlier run
  // would be silently skipped when aimed at again.
  s.fired.add(mint);
  await s.setTarget(mint);
  assert.equal(s.fired.has(mint), false);

  await assert.rejects(s.setTarget('obviously-not-an-address'), /not a valid contract address/);
  assert.equal(s.target, mint); // a rejected target must not clear the good one
  ok('a target can be set, re-set and cleared of its fired flag, and a bad one changes nothing');
}
{
  // A curve account is written on EVERY trade, not just at creation. Without
  // the fired-set this would re-fire on somebody else's buy.
  const w = mkWallet();
  const sniper = new PumpSniper({
    connection: {}, jito: {},
    wallets: [{ index: 0, address: w.address, keypair: w.kp, budgetLamports: 1n }],
    mints: [Keypair.generate().publicKey.toBase58()],
    slippageBps: 0n, tipLamports: 1n, maxPreBuyLamports: 10n ** 18n, paper: true,
  });
  const mint = sniper.mints[0];
  assert.equal(sniper.assess(mint, { complete: false, realSolReserves: 5n }).act, true);
  sniper.fired.add(mint.toBase58());
  assert.equal(sniper.assess(mint, { complete: false, realSolReserves: 6n }).act, false);
  ok('a second write to a curve we already bought does not fire a second bundle');
}

{
  const w = mkWallet();
  const s = new PumpSniper({
    connection: {}, jito: {},
    wallets: [{ index: 0, address: w.address, keypair: w.kp, budgetLamports: 1n }],
    slippageBps: 500n, tipLamports: 1n, paper: true,
  });
  assert.equal(s.setMode('live'), false);
  assert.equal(s.mode, 'live');
  assert.equal(s.setMode('paper'), true);
  assert.throws(() => s.setMode('sideways'), /unknown mode/);

  // The dangerous one: flipping paper->live while armed would mean the next
  // write to that curve is handled under rules set for a different mode.
  s.armed = true;
  assert.throws(() => s.setMode('live'), /disarm before changing mode/);
  assert.equal(s.mode, 'paper');
  ok('mode switches both ways but is refused while armed, so rules cannot change mid-launch');
}

console.log('\nbundle assembly');

// Stand the sniper up with the chain-derived values injected, so the whole
// build path runs with no network. These are the values mainnet actually holds.
function offlineSniper(overrides = {}) {
  const ws = Array.from({ length: 5 }, mkWallet);
  const amounts = [2_600_000_000n, 1_350_000_000n, 2_150_000_000n, 1_050_000_000n, 2_400_000_000n];
  const wallets = ws.map((w, i) => ({ index: i, address: w.address, keypair: w.kp, budgetLamports: amounts[i] }));
  const s = new PumpSniper({
    connection: {}, jito: {}, wallets,
    mints: ['Hn6C4FTuyK9Z5jZeDsiCe5i6YG56a3LYyPKWoV6Dpump'],
    slippageBps: 500n, tipLamports: 5_000_000n, maxPreBuyLamports: 500_000_000n,
    paper: false, ...overrides,
  });
  s.global = {
    initialVirtualTokenReserves: INITIAL_V_TOK, initialVirtualSolReserves: INITIAL_V_SOL,
    initialRealTokenReserves: INITIAL_R_TOK, tokenTotalSupply: TOTAL_SUPPLY,
    feeBasisPoints: FEE_BPS, feeRecipients: [Keypair.generate().publicKey],
  };
  s.buybackRecipients = [Keypair.generate().publicKey];
  s.tipAccounts = [Keypair.generate().publicKey.toBase58()];
  s.blockhash = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
  return s;
}
const CURVE = {
  creator: Keypair.generate().publicKey, complete: false, isCashback: false,
  virtualSolReserves: INITIAL_V_SOL, virtualTokenReserves: INITIAL_V_TOK,
  realSolReserves: 0n, realTokenReserves: INITIAL_R_TOK,
};

{
  const s = offlineSniper();
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE) });
  assert.equal(b.transactions.length, 5);
  // Solana refuses any transaction over 1232 bytes outright. Adding an
  // instruction to the hot path is exactly how that limit gets crossed.
  for (const tx of b.transactions) {
    assert.ok(Buffer.from(tx, 'base64').length <= 1232, 'transaction exceeds the 1232-byte limit');
  }
  ok('all five transactions are built and every one fits inside the 1232-byte limit');
}
{
  const s = offlineSniper();
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE) });
  // Bundle order IS execution order, and execution order is what the ladder was
  // priced against. If these ever disagree the later legs are mispriced.
  b.transactions.forEach((b64, i) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), s.wallets[i].address);
    assert.ok(tx.signatures.some((sg) => sg.some((byte) => byte !== 0)), 'transaction is unsigned');
  });
  ok('the bundle is signed and in wallet order, which is the order the ladder priced');
}
{
  const s = offlineSniper();
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE) });
  const counts = b.transactions.map((b64) =>
    VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).message.compiledInstructions.length);
  // Four instructions each (2 compute budget, ATA, buy); the tip wallet has five.
  assert.deepEqual(counts, [4, 4, 4, 4, 5]);
  assert.equal(counts.filter((c) => c === 5).length, 1);
  ok('exactly one transaction carries the Jito tip, and it is the configured one');
}
{
  const s = offlineSniper({ paper: true });
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE) });
  // Paper must produce nothing sendable at all, not an unsigned transaction that
  // some later code path could still hand to a relay.
  assert.equal(b.transactions.length, 0);
  assert.equal(b.built.length, 5);
  assert.equal(b.paper, true);
  assert.ok(b.built.every((x) => x.signed === false));
  ok('paper mode builds and measures all five but emits nothing that could be sent');
}
{
  const s = offlineSniper();
  s.blockhash = null;
  assert.throws(() => s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE) }), /no blockhash/);
  ok('building without a blockhash in hand throws instead of signing something unlandable');
}

console.log('\ntelegram control');

const VALID_CA = 'Hn6C4FTuyK9Z5jZeDsiCe5i6YG56a3LYyPKWoV6Dpump';
const snap = (over = {}) => ({
  mode: 'paper', armed: false, target: null,
  wallets: [{ address: 'W1', budgetLamports: 2_600_000_000n, balance: 3_000_000_000n, sufficient: true }],
  buyTotalLamports: 9_550_000_000n, slippageBps: 500n, feeBasisPoints: '95',
  uptimeMs: 3_600_000, funded: true, underfunded: 0, plan: [], ...over,
});
const cmd = (line) => {
  const [head, ...args] = line.slice(1).split(/\s+/);
  return { cmd: head.toLowerCase(), args };
};

{
  const r = decideSnipeCommand(cmd(`/target ${VALID_CA}`), snap());
  assert.equal(r.action, 'set-target');
  assert.equal(r.payload, VALID_CA);
  // A Solana address has no checksum, so the warning is not optional decoration.
  assert.match(r.reply, /no checksum/);
  ok('a valid contract address sets the target and warns that a typo cannot be caught');
}
{
  const r = decideSnipeCommand(cmd('/target not-an-address'), snap());
  assert.equal(r.action, 'none');
  assert.match(r.reply, /not a valid contract address/);
  const bare = decideSnipeCommand(cmd('/target'), snap());
  assert.equal(bare.action, 'none');
  assert.match(bare.reply, /Usage/);
  ok('a malformed or missing address changes nothing and says how to use the command');
}
{
  // The CA arrives as untrusted text and the reply is sent with parse_mode HTML.
  // Unescaped, this would break the message or inject markup.
  const r = decideSnipeCommand(cmd('/target <b>x</b>&y'), snap());
  assert.equal(r.action, 'none');
  assert.ok(!r.reply.includes('<b>x</b>'), 'raw HTML from user input must not reach the reply');
  assert.match(r.reply, /&lt;b&gt;/);
  assert.match(r.reply, /&amp;y/);
  ok('user text is HTML-escaped, so a crafted address cannot inject markup into the reply');
}
{
  const r = decideSnipeCommand(cmd(`/target ${VALID_CA}`), snap({ armed: true, target: 'old' }));
  assert.equal(r.action, 'set-target');
  // Re-targeting drops the old subscription; saying so is the difference between
  // a deliberate change and silently ceasing to watch a launch.
  assert.match(r.reply, /disarmed/i);
  ok('re-targeting while armed says plainly that it disarmed you');
}
{
  assert.match(decideSnipeCommand(cmd('/arm'), snap()).reply, /No target/);
  assert.equal(decideSnipeCommand(cmd('/arm'), snap()).action, 'none');
  const armed = decideSnipeCommand(cmd('/arm'), snap({ target: VALID_CA, armed: true }));
  assert.equal(armed.action, 'none');
  assert.match(armed.reply, /Already armed/);
  const ready = decideSnipeCommand(cmd('/arm'), snap({ target: VALID_CA }));
  assert.equal(ready.action, 'arm');
  // Deliberately empty: the caller replies once it has re-read balances, so the
  // confirmation reflects the funding check rather than pre-empting it.
  assert.equal(ready.reply, '');
  ok('arming needs a target, is idempotent, and defers its reply until balances are re-read');
}
{
  const r = decideSnipeCommand(cmd('/live'), snap());
  assert.equal(r.action, 'live');
  assert.match(r.reply, /real SOL/);
  assert.equal(decideSnipeCommand(cmd('/live'), snap({ mode: 'live' })).action, 'none');
  // The dangerous one: mode must not flip under a live subscription.
  const whileArmed = decideSnipeCommand(cmd('/live'), snap({ armed: true }));
  assert.equal(whileArmed.action, 'none');
  assert.match(whileArmed.reply, /Disarm first/);
  ok('going live is refused while armed, so the rules cannot change mid-launch');
}
{
  const whileArmed = decideSnipeCommand(cmd('/paper'), snap({ mode: 'live', armed: true }));
  assert.equal(whileArmed.action, 'none');
  assert.equal(decideSnipeCommand(cmd('/paper'), snap({ mode: 'live' })).action, 'paper');
  assert.equal(decideSnipeCommand(cmd('/paper'), snap()).action, 'none');
  ok('paper is reachable from live, refused while armed, and a no-op when already there');
}
{
  // /abort has to land somewhere safe from EVERY state — someone reaching for it
  // is not in a position to work out whether they needed /disarm or /paper.
  for (const st of [snap(), snap({ armed: true, mode: 'live', target: VALID_CA }), snap({ mode: 'live' })]) {
    const r = decideSnipeCommand(cmd('/abort'), st);
    assert.equal(r.action, 'abort');
    assert.match(r.reply, /ABORTED/);
  }
  // And it must never imply it sold anything.
  assert.match(decideSnipeCommand(cmd('/abort'), snap()).reply, /cannot sell/);
  ok('abort works from every state and never implies it closed a position');
}
{
  const r = decideSnipeCommand(cmd('/status'), snap({ target: VALID_CA, mode: 'live', armed: true }));
  assert.match(r.reply, /ARMED/);
  assert.match(r.reply, /LIVE/);
  assert.match(r.reply, /95 bps/);
  const idle = decideSnipeCommand(cmd('/status'), snap());
  assert.match(idle.reply, /IDLE/);
  assert.match(idle.reply, /PAPER/);
  assert.match(idle.reply, /none yet/);
  ok('status names the mode, the target and the on-chain fee it primed with');
}
{
  const r = decideSnipeCommand(cmd('/status'), snap({ funded: false, underfunded: 2 }));
  assert.match(r.reply, /2 wallet\(s\) underfunded/);
  assert.match(r.reply, /voids the whole bundle/);
  ok('status surfaces underfunded wallets and what that costs');
}
{
  assert.equal(decideSnipeCommand(cmd('/disarm'), snap()).action, 'none');
  const r = decideSnipeCommand(cmd('/disarm'), snap({ armed: true }));
  assert.equal(r.action, 'disarm');
  assert.match(r.reply, /Nothing was sold/);
  ok('disarm is a no-op when idle and never implies it exited a position');
}
{
  const r = decideSnipeCommand(cmd('/nonsense'), snap());
  assert.equal(r.action, 'none');
  assert.match(r.reply, /Unknown command/);
  assert.match(r.reply, /\/target/); // the help comes with it
  assert.match(decideSnipeCommand(cmd('/help'), snap()).reply, /\/abort/);
  ok('an unknown command is refused with the full command list attached');
}

{
  // Env beats config, because the token can arm live spending and therefore
  // belongs in the same root-only file as the signing keys.
  const r = resolveTelegram({
    config: { enabled: true, botToken: 'from-config', chatId: '111' },
    env: { FIRSTFILL_SNIPER_TELEGRAM_TOKEN: 'from-env', FIRSTFILL_SNIPER_TELEGRAM_CHAT_ID: '222' },
  });
  assert.equal(r.on, true);
  assert.equal(r.botToken, 'from-env');
  assert.equal(r.chatId, '222');
  assert.equal(r.source, 'env');
  ok('a token in the environment overrides one in the config file');
}
{
  const r = resolveTelegram({ config: { enabled: true, botToken: 't', chatId: 999 }, env: {} });
  assert.equal(r.on, true);
  assert.equal(r.source, 'config');
  // Chat ids exceed what a JS number holds exactly, and the auth check compares
  // strings — so this must come back as a string or the comparison silently fails.
  assert.equal(r.chatId, '999');
  assert.equal(typeof r.chatId, 'string');
  ok('the chat id comes back as a string, which is what the auth check compares');
}
{
  // The exact failure this prevents: a copied config.example.json whose
  // placeholders were never filled in. Telegram refuses a nonsense token
  // immediately instead of long-polling, so the loop would spin.
  const ph = resolveTelegram({ config: { enabled: true, botToken: 'PUT_A_SECOND_BOT_TOKEN_HERE', chatId: 'PUT_CHAT_ID_HERE' }, env: {} });
  assert.equal(ph.on, false);
  assert.equal(ph.reason, 'no bot token');
  const halfPh = resolveTelegram({ config: { enabled: true, botToken: 'real', chatId: 'PUT_CHAT_ID_HERE' }, env: {} });
  assert.equal(halfPh.on, false);
  assert.equal(halfPh.reason, 'no chat id');
  ok('an unfilled placeholder counts as not configured, rather than spinning the poll loop');
}
{
  assert.equal(resolveTelegram({ config: { enabled: false, botToken: 't', chatId: '1' }, env: {} }).on, false);
  assert.equal(resolveTelegram({ config: {}, env: {} }).on, false);
  // A token placed in the environment is already a deliberate act; requiring a
  // second opt-in in another file is discovered at the wrong moment.
  const envOnly = resolveTelegram({ config: {}, env: { FIRSTFILL_SNIPER_TELEGRAM_TOKEN: 't', FIRSTFILL_SNIPER_TELEGRAM_CHAT_ID: '5' } });
  assert.equal(envOnly.on, true);
  // But an explicit false in config still wins — it is an explicit instruction.
  const off = resolveTelegram({ config: { enabled: false }, env: { FIRSTFILL_SNIPER_TELEGRAM_TOKEN: 't', FIRSTFILL_SNIPER_TELEGRAM_CHAT_ID: '5' } });
  assert.equal(off.on, false);
  ok('env credentials self-enable, but an explicit enabled:false still wins');
}
{
  const r = resolveTelegram({ config: { enabled: true, botToken: 't', chatId: '1' }, env: {} });
  // Never hand back a credential on a path that decided not to start.
  const offPaths = [
    resolveTelegram({ config: { enabled: false, botToken: 'secret', chatId: '1' }, env: {} }),
    resolveTelegram({ config: { enabled: true, botToken: 'secret', chatId: '' }, env: {} }),
  ];
  for (const o of offPaths) {
    assert.equal(o.on, false);
    assert.equal(o.botToken, '');
    assert.equal(o.chatId, '');
  }
  assert.equal(r.on, true);
  ok('a refused configuration returns empty credentials, not the ones it rejected');
}

console.log(`\n${pass} passed\n`);
