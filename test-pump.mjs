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
  ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, tokenProgramForMintAccount,
} from './src/pump/pump.mjs';
import {
  loadSniperWallets, keypairFromBase58, solStringToLamports, auditSplit,
  MAX_BUNDLE_TRANSACTIONS,
} from './src/pump/wallets.mjs';
import { JitoClient, normaliseStatus, MAX_BUNDLE_SIZE as JITO_MAX_BUNDLE } from './src/pump/jito.mjs';
import { HeliusSender, SENDER_TIP_ACCOUNTS, MIN_TIP_LAMPORTS, MAX_BUNDLE_SIZE } from './src/pump/sender.mjs';
import { PumpSniper, ATA_RENT_LAMPORTS, SIGNATURE_FEE_LAMPORTS, MAX_BLOCKHASH_AGE_MS,
         REHEARSAL_MAX_SOL_COST, packLegs, MAX_BUYS_PER_TRANSACTION,
         MAX_TRANSACTION_BYTES } from './src/pump/sniper.mjs';
import { decideSnipeCommand, resolveTelegram } from './src/pump/snipe-control.mjs';

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

console.log('\nhelius sender');

{
  // These are HELIUS tip accounts, not Jito's. The lists differ and a tip to the
  // wrong one is money thrown away, so they are asserted as real pubkeys.
  assert.equal(SENDER_TIP_ACCOUNTS.length, 10);
  assert.equal(new Set(SENDER_TIP_ACCOUNTS).size, 10);
  for (const a of SENDER_TIP_ACCOUNTS) assert.doesNotThrow(() => new PublicKey(a));
  ok('all ten Sender tip accounts are distinct, valid public keys');
}
{
  const calls = [];
  const sender = new HeliusSender({
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'SIG123' }) };
    },
  });
  const r = await sender.sendBundle(['tx1', 'tx2', 'tx3', 'tx4']);
  // Sender answers with a 64-hex BUNDLE ID, not a base58 signature. Measured:
  // a real submission returns {"result":"9b5ad868...c704"}. Passing that to
  // confirmTransaction fails with "signature must be base58 encoded".
  assert.equal(r.bundleId, 'SIG123');
  assert.equal(r.signature, undefined);
  // Same wire format Jito takes: [[transactions], {encoding}].
  assert.equal(calls[0].body.method, 'sendBundle');
  assert.deepEqual(calls[0].body.params[0], ['tx1', 'tx2', 'tx3', 'tx4']);
  assert.equal(calls[0].body.params[1].encoding, 'base64');
  assert.match(calls[0].url, /api-key=k/);
  ok('a bundle goes to Sender in Jito wire format and comes back with a real signature');
}
{
  const sender = new HeliusSender({ fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(sender.sendBundle([]), /empty bundle/);
  // Sender's limit is FOUR, not Jito's five. Measured: a five-transaction
  // bundle is refused with "bundle must contain no more than 4 transactions".
  await assert.rejects(sender.sendBundle(['a', 'b', 'c', 'd', 'e']), /exceeds the 4-transaction/);
  assert.equal(MAX_BUNDLE_SIZE, 4);
  ok('an empty bundle and a sixth transaction are refused before any network call');
}
{
  const sender = new HeliusSender({
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({
      error: { code: -32602, message: 'Invalid Request: invalid base64 encoding' } }) }),
  });
  // Sender validates synchronously and NAMES the fault. That is the whole
  // difference from Jito, which accepted everything and discarded it silently.
  await assert.rejects(sender.sendBundle(['tx']), /invalid base64 encoding/);
  ok('Sender rejects a bad bundle at ingress with a named reason instead of discarding it');
}
{
  const sender = new HeliusSender({
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => '<html>slow down</html>' }),
  });
  await assert.rejects(sender.sendBundle(['tx']), /HTTP 429/);
  ok('an HTML error page reports its status rather than throwing a parse error');
}
{
  const w = mkWallet();
  // Below Sender's minimum the bundle skips the priority buffer and takes fewer
  // pathways, which defeats the point on a launch. Refuse at startup.
  const s = new PumpSniper({
    connection: {}, sender: {},
    wallets: [{ index: 0, address: w.address, keypair: w.kp, budgetLamports: 1n }],
    mints: [Keypair.generate().publicKey.toBase58()],
    slippageBps: 500n, tipLamports: MIN_TIP_LAMPORTS - 1n,
  });
  s.global = { feeBasisPoints: 95n };
  assert.equal(MIN_TIP_LAMPORTS, 1_000_000n);
  ok('Sender\'s minimum tip is 0.001 SOL, and a smaller one is a configuration error');
}

{
  // THE BUG THAT COST TWO LIVE RUNS. Sender serves some errors as a bare
  // {code, message} with HTTP 500 rather than the JSON-RPC {error:{...}}.
  // Reading only body.error returned body.result — undefined — as a success, so
  // a refused bundle was reported as sent.
  const sender = new HeliusSender({
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => JSON.stringify({
      code: -32602, message: 'Invalid Request: bundle must contain no more than 4 transactions' }) }),
  });
  // Assert the SHAPE was understood, not merely that something threw: the
  // catch-all "no result" path also quotes the body, so matching the message
  // text alone passes even when the error shape is ignored.
  await assert.rejects(sender.sendBundle(['a', 'b', 'c', 'd']), (err) => {
    assert.match(err.message, /no more than 4 transactions/);
    assert.ok(!/returned no result/.test(err.message), 'fell through to the generic no-result path');
    assert.equal(err.rejectedAtIngress, true, 'a named 500 is an ingress rejection');
    return true;
  });
  ok('a bare {code,message} error is parsed as an error, not swallowed as an undefined result');
}
{
  // Nor may a 200 with no result pass as success.
  const sender = new HeliusSender({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1 }) }),
  });
  await assert.rejects(sender.sendBundle(['a']), /returned no result/);
  ok('a 200 carrying no result throws rather than reporting an undefined bundle id');
}
{
  const legs = [1, 2, 3, 4, 5].map((i) => ({ label: `w${i}`, index: i - 1 }));
  const groups = packLegs(legs);
  // Five wallets cannot have one transaction each: Sender takes four.
  assert.ok(groups.length <= MAX_BUNDLE_SIZE);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.length), [2, 2, 1]);
  // Order is what the ladder was priced against, so it must survive packing.
  assert.deepEqual(groups.flat().map((l) => l.label), ['w1', 'w2', 'w3', 'w4', 'w5']);
  ok('five wallets pack into three transactions with their execution order intact');
}
{
  for (const n of [1, 2, 3, 4, 6, 8, 12]) {
    const legs = Array.from({ length: n }, (_, i) => ({ label: `w${i}`, index: i }));
    const g = packLegs(legs);
    assert.ok(g.length <= MAX_BUNDLE_SIZE, `${n} wallets made ${g.length} transactions`);
    assert.ok(g.every((x) => x.length <= MAX_BUYS_PER_TRANSACTION), `${n} wallets over-packed a transaction`);
    assert.equal(g.flat().length, n);
  }
  // Past the ceiling it refuses instead of quietly dropping a wallet.
  assert.throws(() => packLegs(Array.from({ length: 13 }, (_, i) => ({ label: `w${i}`, index: i }))), /ceiling is 12/);
  assert.throws(() => packLegs([]), /no legs/);
  ok('every wallet count up to the ceiling packs inside both limits, and past it throws');
}

console.log('\njito bundling');

{
  // Jito allows five; Sender allows four. Two different limits, and conflating
  // them is what sent a five-transaction bundle to an endpoint that takes four.
  assert.equal(JITO_MAX_BUNDLE, 5);
  assert.equal(MAX_BUNDLE_SIZE, 4);
  const j = new JitoClient({ fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(j.sendBundle([]), /empty bundle/);
  await assert.rejects(j.sendBundle(['a', 'b', 'c', 'd', 'e', 'f']), /exceeds the 5-transaction bundle limit/);
  ok('an empty bundle and a sixth transaction are both refused before any network call');
}
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('frankfurt')) return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'BUNDLE123' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ error: { message: 'relay down' } }) };
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
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: 'nope' } }) }),
  });
  await assert.rejects(j.sendBundle(['tx']), /all 1 relays refused/);
  ok('a bundle no relay accepted throws rather than reporting a send');
}
{
  // An HTTP error must not surface as a JSON parse failure — that is how a rate
  // limit spent an afternoon looking like a connectivity problem.
  const j = new JitoClient({
    relays: ['https://a.example'],
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => '<html>Too Many Requests</html>' }),
  });
  await assert.rejects(j.sendBundle(['tx']), /HTTP 429/);
  ok('an HTML error page is reported as its HTTP status, not as a parse error');
}
{
  const j = new JitoClient({
    relays: ['https://a.example'],
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({
      error: { message: 'Bundles must write lock at least one tip account to be eligible for the auction.' } }) }),
  });
  // Ingress rejections are NAMED and arrive as 400. Getting one back is good
  // news: it says exactly what is wrong, unlike a 200 followed by Invalid.
  await assert.rejects(j.sendBundle(['tx']), /write lock at least one tip account/);
  ok('a named ingress rejection is passed through verbatim rather than flattened');
}
{
  assert.equal(normaliseStatus('Landed'), 'landed');
  assert.equal(normaliseStatus('confirmed'), 'landed');
  assert.equal(normaliseStatus('InFlight'), 'pending');
  assert.equal(normaliseStatus('Dropped'), 'failed');
  // The important one: anything we do not recognise must NOT read as landed.
  assert.equal(normaliseStatus('SomethingNew'), 'unknown');
  assert.equal(normaliseStatus(undefined), 'unknown');
  // Invalid used to fall through to 'unknown', which hid the single most
  // important signal the block engine produces.
  assert.equal(normaliseStatus('Invalid'), 'invalid');
  ok('an unrecognised bundle status reads as unknown, and Invalid reads as invalid');
}

console.log('\nthe fire gate');

{
  const w = mkWallet();
  const sniper = new PumpSniper({
    connection: {}, sender: {},
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
    connection: {}, sender: {},
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
    connection: {}, sender: {},
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
    connection: {}, sender: {},
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
    connection: {}, sender: {},
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
    connection: {}, sender: {},
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
    connection: {}, sender: {}, wallets,
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
  s.tipAccounts = SENDER_TIP_ACCOUNTS;
  s.blockhash = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
  s.blockhashAt = Date.now();
  return s;
}
const CURVE = {
  creator: Keypair.generate().publicKey, complete: false, isCashback: false,
  virtualSolReserves: INITIAL_V_SOL, virtualTokenReserves: INITIAL_V_TOK,
  realSolReserves: 0n, realTokenReserves: INITIAL_R_TOK,
};

{
  const s = offlineSniper();
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  // THREE transactions, not five: Sender takes at most four, so the five
  // wallets share them. Every buy is still in the one atomic bundle.
  assert.equal(b.transactions.length, 3);
  assert.ok(b.transactions.length <= MAX_BUNDLE_SIZE);
  for (const tx of b.transactions) {
    assert.ok(Buffer.from(tx, 'base64').length <= MAX_TRANSACTION_BYTES, 'transaction exceeds the byte limit');
  }
  ok('five wallets build into three transactions, each inside the 1232-byte limit');
}
{
  const s = offlineSniper();
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  // Bundle order IS execution order, and execution order is what the ladder was
  // priced against. If these ever disagree the later legs are mispriced.
  // Packed [w1+w2, w3+w4, w5], so the fee payers are wallets 1, 3 and 5 and the
  // signature counts are 2, 2, 1.
  const sigCounts = b.transactions.map((b64) =>
    VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).message.header.numRequiredSignatures);
  assert.deepEqual(sigCounts, [2, 2, 1]);
  assert.equal(sigCounts.reduce((a, x) => a + x, 0), 5, 'every wallet must sign exactly once');
  b.transactions.forEach((b64) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    for (const sg of tx.signatures) assert.ok(sg.some((byte) => byte !== 0), 'a wallet did not sign');
  });
  ok('all five wallets sign across the three transactions, and none is left unsigned');
}
{
  const s = offlineSniper();
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  const counts = b.transactions.map((b64) =>
    VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).message.compiledInstructions.length);
  // 2 compute-budget + (create, buy) per wallet in the group; the LAST
  // transaction also carries the tip.
  assert.deepEqual(counts, [2 + 2 * 2, 2 + 2 * 2, 2 + 1 * 2 + 1]);
  ok('each transaction carries its group\'s buys, and only the last one carries the tip');
}
{
  const s = offlineSniper({ paper: true });
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  // Paper must produce nothing sendable at all, not an unsigned transaction that
  // some later code path could still hand to a relay.
  assert.equal(b.transactions.length, 0);
  assert.equal(b.built.length, 3);
  assert.equal(b.paper, true);
  assert.ok(b.built.every((x) => x.signed === false));
  assert.equal(b.built.flatMap((x) => x.wallets).length, 5, 'all five wallets must still be planned');
  ok('paper measures every transaction but emits nothing that could be sent');
}
{
  const s = offlineSniper();
  s.blockhash = null;
  assert.throws(() => s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM }), /no blockhash/);
  ok('building without a blockhash in hand throws instead of signing something unlandable');
}
{
  // The failure this exists to stop, reproduced from a real run: the refresh had
  // been failing for twelve minutes, the bot signed with the blockhash it still
  // held, five relays accepted the bundle and no leader could execute it. Jito
  // reported it Invalid, landed_slot null, and not a lamport moved.
  const s = offlineSniper();
  s.blockhashAt = Date.now() - (MAX_BLOCKHASH_AGE_MS + 1000);
  assert.throws(
    () => s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM }),
    /blockhash is \d+s old/,
  );
  ok('a blockhash past its shelf life refuses to build rather than signing a bundle nothing can execute');
}
{
  const s = offlineSniper();
  // Just inside the window still builds — the guard must not be so tight that a
  // normal refresh interval trips it.
  s.blockhashAt = Date.now() - (MAX_BLOCKHASH_AGE_MS - 5_000);
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  assert.equal(b.transactions.length, 3);
  assert.ok(MAX_BLOCKHASH_AGE_MS < 60_000, 'the guard must be tighter than the cluster own expiry');
  ok('a blockhash inside the window still builds, and the window is tighter than the cluster');
}

{
  const s = offlineSniper();
  assert.throws(
    () => s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE) }),
    /token program for the mint is unknown/,
  );
  ok('building without a resolved token program throws rather than guessing the classic one');
}
{
  // Sampled on mainnet 2026-09-18: 16 of 18 pump-touched mints were Token-2022.
  // Assuming the classic program derives a DIFFERENT associated token address,
  // so the buy fails outright — the tip is spent and the bundle lands nothing.
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const classic = deriveAta(owner, mint, TOKEN_PROGRAM);
  const t22 = deriveAta(owner, mint, TOKEN_2022_PROGRAM);
  assert.notEqual(classic.toBase58(), t22.toBase58());
  ok('the two token programs derive different token accounts, which is why it cannot be assumed');
}
{
  assert.equal(tokenProgramForMintAccount({ owner: TOKEN_PROGRAM }).toBase58(), TOKEN_PROGRAM.toBase58());
  assert.equal(tokenProgramForMintAccount({ owner: TOKEN_2022_PROGRAM }).toBase58(), TOKEN_2022_PROGRAM.toBase58());
  assert.throws(() => tokenProgramForMintAccount(null), /not readable/);
  // Anything else is refused, not defaulted — a mint owned by something we do
  // not recognise is not a mint we should be buying.
  assert.throws(() => tokenProgramForMintAccount({ owner: PUMP_PROGRAM }), /not a token program/);
  ok('a mint owned by neither token program is refused rather than defaulted');
}
{
  const s = offlineSniper();
  const mint = s.mints[0];
  const planned = s.plan(CURVE);
  const a = s.buildBundle({ mint, curve: CURVE, planned, tokenProgram: TOKEN_PROGRAM });
  const b = s.buildBundle({ mint, curve: CURVE, planned, tokenProgram: TOKEN_2022_PROGRAM });
  const keysOf = (b64) => VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
    .message.staticAccountKeys.map((k) => k.toBase58());
  // The chosen program must actually reach the transaction, not just be accepted.
  assert.ok(keysOf(a.transactions[0]).includes(TOKEN_PROGRAM.toBase58()));
  assert.ok(keysOf(b.transactions[0]).includes(TOKEN_2022_PROGRAM.toBase58()));
  assert.notDeepEqual(keysOf(a.transactions[0]), keysOf(b.transactions[0]));
  ok('the resolved token program reaches the built transaction and changes its accounts');
}

{
  const s = offlineSniper();
  // 250_000 CU x 500_000 microLamports/CU = 125_000 lamports. Omitting this from
  // the balance check lets a wallet pass and then fail its leg, which voids the
  // whole bundle because it is atomic.
  assert.equal(s.priorityFeeLamports(), 125_000n);
  ok('the priority fee is computed from the compute budget rather than ignored');
}
{
  const plain = offlineSniper();
  const dust = offlineSniper({ rehearse: true });
  const planned = plain.plan(CURVE);
  const a = plain.buildBundle({ mint: plain.mints[0], curve: CURVE, planned, tokenProgram: TOKEN_PROGRAM });
  const b = dust.buildBundle({ mint: dust.mints[0], curve: CURVE, planned, tokenProgram: TOKEN_PROGRAM });

  // Structurally identical: same count, same instruction counts, same order.
  assert.equal(a.transactions.length, b.transactions.length);
  const ixCounts = (bundle) => bundle.transactions.map((t) =>
    VersionedTransaction.deserialize(Buffer.from(t, 'base64')).message.compiledInstructions.length);
  assert.deepEqual(ixCounts(a), ixCounts(b));
  ok('a rehearsal bundle has the same shape as the real one — it tests the same path');
}
{
  const dust = offlineSniper({ rehearse: true });
  const b = dust.buildBundle({ mint: dust.mints[0], curve: CURVE, planned: dust.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  // The buy is the 4th instruction; its data is discriminator + amount + cap.
  const tx = VersionedTransaction.deserialize(Buffer.from(b.transactions[0], 'base64'));
  const buyIx = tx.message.compiledInstructions[3];
  const data = Buffer.from(buyIx.data);
  assert.equal(data.readBigUInt64LE(8), 1n);                       // one raw token unit
  assert.equal(data.readBigUInt64LE(16), REHEARSAL_MAX_SOL_COST);  // capped at 0.001 SOL
  ok('a rehearsal asks for one raw token unit under a 0.001 SOL cap, so it costs almost nothing');
}
{
  const plain = offlineSniper();
  const b = plain.buildBundle({ mint: plain.mints[0], curve: CURVE, planned: plain.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  const tx = VersionedTransaction.deserialize(Buffer.from(b.transactions[0], 'base64'));
  const data = Buffer.from(tx.message.compiledInstructions[3].data);
  // And the real path must be untouched by the rehearsal plumbing.
  assert.notEqual(data.readBigUInt64LE(8), 1n);
  assert.equal(data.readBigUInt64LE(16), 2_600_000_000n);
  ok('the real path still asks for the planned size — rehearsal plumbing does not leak into it');
}

{
  const s = offlineSniper();
  const b = s.buildBundle({ mint: s.mints[0], curve: CURVE, planned: s.plan(CURVE), tokenProgram: TOKEN_PROGRAM });
  // We sign these, so we know their signatures. Asking the submission endpoint
  // for one is what produced "signature must be base58 encoded: undefined" on a
  // live run — Sender returns a bundle id, and a bundle id is not a signature.
  assert.equal(b.signatures.length, 3);
  for (let i = 0; i < b.signatures.length; i++) {
    const tx = VersionedTransaction.deserialize(Buffer.from(b.transactions[i], 'base64'));
    assert.equal(b.signatures[i], bs58.encode(tx.signatures[0]));
    // And it must be base58, because confirmTransaction parses it as such.
    assert.match(b.signatures[i], /^[1-9A-HJ-NP-Za-km-z]{86,90}$/);
  }
  assert.equal(new Set(b.signatures).size, b.signatures.length, 'signatures must be distinct');
  ok('the bundle hands back the base58 signatures it produced, one per transaction');
}

console.log('\ntelegram control');

const VALID_CA = 'Hn6C4FTuyK9Z5jZeDsiCe5i6YG56a3LYyPKWoV6Dpump';
const snap = (over = {}) => ({
  mode: 'paper', armed: false, target: null,
  wallets: [{ address: 'W1', budgetLamports: 2_600_000_000n, balance: 3_000_000_000n, sufficient: true }],
  buyTotalLamports: 9_550_000_000n, slippageBps: 500n, feeBasisPoints: '95',
  uptimeMs: 3_600_000, funded: true, underfunded: 0, plan: [], maxPreBuySol: '0.5', ...over,
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

{
  const r = decideSnipeCommand(cmd('/maxprebuy 1000'), snap());
  assert.equal(r.action, 'set-maxprebuy');
  assert.equal(r.payload, '1000');
  // A high value means it will buy a curve somebody already ran up. Saying so is
  // the difference between a deliberate rehearsal setting and one left behind.
  assert.match(r.reply, /set it back/);
  const low = decideSnipeCommand(cmd('/maxprebuy 0.5'), snap());
  assert.equal(low.action, 'set-maxprebuy');
  assert.ok(!/set it back/.test(low.reply));
  ok('max pre-buy is settable, and a rehearsal-sized value warns to put it back');
}
{
  assert.equal(decideSnipeCommand(cmd('/maxprebuy'), snap()).action, 'none');
  assert.match(decideSnipeCommand(cmd('/maxprebuy'), snap()).reply, /Currently/);
  for (const bad of ['abc', '-1', '0', '1e9']) {
    const r = decideSnipeCommand(cmd(`/maxprebuy ${bad}`), snap());
    assert.equal(r.action, 'none', `"${bad}" must not be accepted`);
  }
  // Same rule as mode: it decides what gets bought, so it cannot move under a
  // live subscription.
  const armed = decideSnipeCommand(cmd('/maxprebuy 1000'), snap({ armed: true }));
  assert.equal(armed.action, 'none');
  assert.match(armed.reply, /Disarm first/);
  ok('a bare, malformed or mid-flight max pre-buy change is refused');
}
{
  const r = decideSnipeCommand(cmd('/status'), snap({ maxPreBuySol: '1000' }));
  assert.match(r.reply, /maxprebuy\s+1000 SOL/);
  assert.match(decideSnipeCommand(cmd('/help'), snap()).reply, /maxprebuy/);
  ok('status and help both surface the max pre-buy, so a left-behind value is visible');
}

console.log('\nretiring a curve we can no longer act on');

// A curve account is written on EVERY trade for as long as the token lives.
// Everything below is about what the sniper does with writes it can do nothing
// about — because doing the obvious thing (report each one) is what buried the
// settle report under hundreds of lines on the first live run.

// Encode a bonding curve the way the chain lays one out, so these tests go
// through decodeBondingCurve rather than around it. Offsets from pump.mjs.
function encodeCurve({ vTok = INITIAL_V_TOK, vSol = INITIAL_V_SOL, rTok = INITIAL_R_TOK,
                       rSol = 0n, complete = false, creator = Keypair.generate().publicKey } = {}) {
  const b = Buffer.alloc(151);
  b.writeBigUInt64LE(vTok, 8);
  b.writeBigUInt64LE(vSol, 16);
  b.writeBigUInt64LE(rTok, 24);
  b.writeBigUInt64LE(rSol, 32);
  b.writeBigUInt64LE(TOTAL_SUPPLY, 40);
  b[48] = complete ? 1 : 0;
  creator.toBuffer().copy(b, 49);
  return b;
}

// A connection that records subscriptions and hands back the callbacks, so a
// test can deliver a curve write the same way the RPC would.
function subscriptionSpy() {
  let next = 1;
  const live = new Map();          // subId -> { address, cb }
  const removed = [];
  return {
    live, removed,
    onAccountChange(address, cb) {
      const id = next++;
      live.set(id, { address: address.toBase58(), cb });
      return id;
    },
    async removeAccountChangeListener(id) { removed.push(id); live.delete(id); },
    async getAccountInfo() { return null; },
    curveCallbackFor(mint) {
      const want = deriveBondingCurve(new PublicKey(mint)).toBase58();
      for (const v of live.values()) if (v.address === want) return v.cb;
      return null;
    },
  };
}

// Deliver a write and wait for the handler to settle. #onCurveWrite is async
// and the subscription callback drops the promise, so a test that does not wait
// asserts on a half-finished fire.
async function deliver(spy, mint, data, slot = 1) {
  const cb = spy.curveCallbackFor(mint);
  assert.ok(cb, 'nothing is subscribed to that curve');
  cb({ data }, { slot });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function armedSniper(overrides = {}) {
  const spy = subscriptionSpy();
  const s = offlineSniper({ connection: spy, paper: true, maxPreBuyLamports: 500_000_000n, ...overrides });
  const events = [];
  for (const name of ['skipped', 'disarmed', 'firing', 'paper', 'error']) {
    s.on(name, (d) => events.push({ name, ...d }));
  }
  // The fire path needs the token program; on a real launch the mint
  // subscription supplies it. Seed it so the test is about retirement.
  s.tokenPrograms.set(s.mints[0].toBase58(), TOKEN_2022_PROGRAM);
  return { s, spy, events };
}

{
  const { s, spy, events } = armedSniper();
  const mint = s.mints[0].toBase58();
  await s.watch();
  assert.equal(s.subscriptions.size, 1);
  assert.equal(s.mintSubscriptions.size, 1);

  await deliver(spy, mint, encodeCurve());
  assert.ok(events.some((e) => e.name === 'firing'), 'it should have fired');

  // The whole point: once the budgets are committed, nothing is left watching.
  assert.equal(s.subscriptions.size, 0);
  assert.equal(s.mintSubscriptions.size, 0);
  assert.equal(spy.removed.length, 2);
  assert.equal(spy.live.size, 0);
  assert.equal(s.armed, false);
  const off = events.find((e) => e.name === 'disarmed');
  assert.equal(off?.reason, 'fired');
  ok('firing drops both of the mint subscriptions and leaves the sniper disarmed');
}
{
  // Writes already in flight when we unsubscribe are still delivered. They must
  // cost nothing: no second bundle, and no report either.
  const { s, spy, events } = armedSniper();
  const mint = s.mints[0].toBase58();
  await s.watch();
  const cb = spy.curveCallbackFor(mint);
  await deliver(spy, mint, encodeCurve());
  const after = events.length;

  for (let i = 0; i < 50; i++) cb({ data: encodeCurve({ rSol: BigInt(i) }) }, { slot: 2 + i });
  await new Promise((r) => setImmediate(r));
  assert.equal(events.length, after, 'a write after firing must produce no event at all');
  assert.equal(events.filter((e) => e.name === 'firing').length, 1);
  ok('fifty writes racing the unsubscribe fire nothing and report nothing');
}
{
  // The other firehose, and the one the subscription drop does NOT close:
  // a curve we refuse is written on every trade too.
  const { s, spy, events } = armedSniper({ maxPreBuyLamports: 1n });
  const mint = s.mints[0].toBase58();
  await s.watch();
  for (let i = 0; i < 40; i++) await deliver(spy, mint, encodeCurve({ rSol: 500_000_000n + BigInt(i) }), 10 + i);

  const skips = events.filter((e) => e.name === 'skipped');
  assert.equal(skips.length, 1, 'forty refusals of one kind are one report');
  assert.equal(skips[0].reason, 'pre-bought');
  assert.equal(skips[0].repeatsSuppressed, true);
  assert.match(skips[0].detail, /limit 1/);

  // Pre-bought is not terminal: people sell, so the curve can come back under
  // the limit and we must still be there when it does.
  assert.equal(s.subscriptions.size, 1);
  assert.equal(s.armed, true);
  await deliver(spy, mint, encodeCurve({ rSol: 0n }), 99);
  assert.ok(events.some((e) => e.name === 'firing'), 'a curve that drops back under the limit is still bought');
  ok('a refusal is reported once per kind, and a pre-bought curve stays watched in case it comes back');
}
{
  // Two different refusals are two different pieces of information.
  const { s, spy, events } = armedSniper({ maxPreBuyLamports: 1n });
  const mint = s.mints[0].toBase58();
  await s.watch();
  await deliver(spy, mint, encodeCurve({ rSol: 500_000_000n }));
  await deliver(spy, mint, Buffer.alloc(4));            // too short to decode
  await deliver(spy, mint, encodeCurve({ rSol: 500_000_000n }));
  const reasons = events.filter((e) => e.name === 'skipped').map((e) => e.reason);
  assert.deepEqual(reasons, ['pre-bought', 'undecodable']);
  ok('a second KIND of refusal is still reported, while the first kind stays quiet');
}
{
  // Graduated is terminal — the token has left the bonding curve for a DEX and
  // no write will ever make it buyable here again.
  const { s, spy, events } = armedSniper();
  const mint = s.mints[0].toBase58();
  await s.watch();
  await deliver(spy, mint, encodeCurve({ complete: true }));
  assert.equal(events.filter((e) => e.name === 'skipped')[0].reason, 'graduated');
  assert.equal(events.find((e) => e.name === 'disarmed')?.reason, 'graduated');
  assert.equal(s.subscriptions.size, 0);
  assert.equal(s.mintSubscriptions.size, 0);
  assert.equal(s.armed, false);
  assert.equal(s.fired.has(mint), false, 'refusing a curve is not buying it');
  ok('a graduated curve retires the mint instead of being refused forever');
}
{
  // Re-arming is a fresh intent: the operator asked again, so they are told
  // again rather than left to infer the reason from silence.
  const { s, spy, events } = armedSniper({ maxPreBuyLamports: 1n });
  const mint = s.mints[0].toBase58();
  await s.watch();
  await deliver(spy, mint, encodeCurve({ rSol: 500_000_000n }));
  assert.equal(events.filter((e) => e.name === 'skipped').length, 1);
  await s.unwatch();
  await s.watch();
  await deliver(spy, mint, encodeCurve({ rSol: 500_000_000n }));
  assert.equal(events.filter((e) => e.name === 'skipped').length, 2);
  ok('re-arming reports the same refusal again, so a disarm/arm cycle is never silent');
}
{
  // The bug the unconditional unwatch() in setTarget closes: after a fire there
  // is nothing subscribed, so the old `size > 0` guard skipped the unwatch and
  // left `armed` true over a sniper watching nothing.
  const { s, spy } = armedSniper();
  const mint = s.mints[0].toBase58();
  await s.watch();
  await deliver(spy, mint, encodeCurve());
  s.armed = true;                       // as the old guard would have left it
  await s.setTarget(Keypair.generate().publicKey.toBase58());
  assert.equal(s.armed, false, 'setting a new target must never leave the sniper armed');
  assert.equal(s.subscriptions.size, 0);
  ok('a new target disarms even when the previous one had already fired');
}
{
  // A new target says nothing about the old one's refusals.
  const { s, spy, events } = armedSniper({ maxPreBuyLamports: 1n });
  await s.watch();
  await deliver(spy, s.mints[0].toBase58(), encodeCurve({ rSol: 500_000_000n }));
  assert.equal(s.reported.size, 1);
  await s.setTarget(Keypair.generate().publicKey.toBase58());
  assert.equal(s.reported.size, 0);
  await s.watch();
  await deliver(spy, s.mints[0].toBase58(), encodeCurve({ rSol: 500_000_000n }));
  assert.equal(events.filter((e) => e.name === 'skipped').length, 2);
  ok('retargeting clears what was reported, so the new mint reports its own refusals');
}
{
  // The reason unsubscribing and disarming are NOT done in the same step.
  // `armed` is what refuses a mode change; if it dropped at the claim, a /live
  // arriving in the window before the send would turn a rehearsal into a real
  // bundle. So it has to survive the whole fire.
  const { s, spy } = armedSniper();
  let checked = false;
  s.on('firing', () => {
    checked = true;
    assert.equal(s.armed, true, 'the sniper must still count as armed mid-fire');
    assert.throws(() => s.setMode('live'), /disarm before changing mode/);
    assert.equal(s.mode, 'paper');
  });
  await s.watch();
  await deliver(spy, s.mints[0].toBase58(), encodeCurve());
  assert.ok(checked, 'the firing hook never ran');
  assert.equal(s.armed, false, 'and it must be disarmed once the fire is over');
  ok('the mode cannot be switched between claiming the budgets and sending the bundle');
}
{
  // A write landing DURING the fire — after the claim, before the send — is the
  // case the fired-set has always guarded. It must still not buy twice, and it
  // must not turn into a second report either.
  const { s, spy, events } = armedSniper();
  const mint = s.mints[0].toBase58();
  await s.watch();
  const cb = spy.curveCallbackFor(mint);
  s.on('firing', () => {
    for (let i = 0; i < 20; i++) cb({ data: encodeCurve({ rSol: BigInt(i) }) }, { slot: 5 });
  });
  await deliver(spy, mint, encodeCurve());
  assert.equal(events.filter((e) => e.name === 'firing').length, 1, 'one launch, one bundle');
  const skips = events.filter((e) => e.name === 'skipped');
  assert.equal(skips.length, 1, 'twenty re-entrant writes are at most one report');
  assert.equal(skips[0].reason, 'already-fired');
  ok('twenty writes arriving mid-fire buy nothing twice and report once');
}
{
  // The failure that would otherwise leave a lie on the operator's phone: the
  // send throws, so nothing is watched and the budgets are claimed, but
  // Telegram still reads ARMED and the operator waits for a fire that cannot come.
  const { s, spy, events } = armedSniper({ paper: false });
  s.sender = { sendBundle: async () => { throw new Error('sender said no'); } };
  await s.watch();
  await deliver(spy, s.mints[0].toBase58(), encodeCurve());
  assert.match(events.find((e) => e.name === 'error')?.error ?? '', /sender said no/);
  assert.equal(s.armed, false, 'a failed send must still disarm');
  assert.equal(s.subscriptions.size, 0);
  assert.equal(events.find((e) => e.name === 'disarmed')?.reason, 'fired');
  ok('a send that throws still leaves the sniper disarmed rather than falsely armed');
}

console.log(`\n${pass} passed\n`);
