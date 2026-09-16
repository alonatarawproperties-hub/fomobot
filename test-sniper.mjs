// Offline tests for the snipe assembly and the race logic. No network, no funds.
//
// The trigger path is the part that cannot be rehearsed live — a launch happens
// once, and if the handler is wrong there is no second attempt. So it is driven
// here by a fake socket that replays the exact notification shapes Solana sends.

import assert from 'node:assert/strict';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSyncNativeInstruction } from '@solana/spl-token';

import {
  WSOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, VIRTUAL_POOL, VIRTUAL_POOL_DISCRIMINATOR,
  DBC_PROGRAM_ID, planSnipe, deriveAta, deriveTokenVault, derivePoolAddress,
} from './src/meteora/dbc.mjs';
import { verifyPool, snipeInstructions, signSnipe, planFromLivePool, REFUSE } from './src/meteora/snipe.mjs';
import { wrapSolInstructions, topUpWrappedSolInstructions, buildSyncNativeInstruction, isWrappedSol } from './src/meteora/prepare.mjs';
import { DbcSniper, parseAddress, STATE } from './src/meteora/sniper.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };

const BUYER_KP = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + 9) % 251));
const BUYER = BUYER_KP.publicKey;
const key = (n) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + n) % 251)).publicKey;
const CONFIG = key(1), MINT = key(2), CREATOR = key(4);
const BLOCKHASH = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7) % 251));

const PLAN = planSnipe({ config: CONFIG, baseMint: MINT, quoteMint: WSOL_MINT, buyer: BUYER, baseTokenType: 0, quoteTokenType: 0 });

/** A VirtualPool account exactly as the cluster would serve it. */
function poolBlob({ config = CONFIG, baseMint = MINT, pool = PLAN.pool, creator = CREATOR, quoteMint = WSOL_MINT } = {}) {
  const b = Buffer.alloc(VIRTUAL_POOL.SIZE);
  b.set(VIRTUAL_POOL_DISCRIMINATOR, 0);
  b.set(config.toBuffer(), VIRTUAL_POOL.CONFIG);
  b.set(creator.toBuffer(), VIRTUAL_POOL.CREATOR);
  b.set(baseMint.toBuffer(), VIRTUAL_POOL.BASE_MINT);
  b.set(deriveTokenVault(pool, baseMint).toBuffer(), VIRTUAL_POOL.BASE_VAULT);
  b.set(deriveTokenVault(pool, quoteMint).toBuffer(), VIRTUAL_POOL.QUOTE_VAULT);
  return b;
}

// ---------------------------------------------------------------------------
console.log('\nthe gate: a pool must be the one we armed against');

{
  const v = verifyPool({ poolAddress: PLAN.pool.toBase58(), data: poolBlob(), plan: PLAN });
  assert.equal(v.ok, true);
  assert.equal(v.pool.config.toBase58(), CONFIG.toBase58());
  ok('the pool we armed for passes');
}
{
  // The realistic disaster: a different token's pool arrives on a subscription
  // whose filter was wrong, and we buy something we never chose.
  const other = key(21);
  const v = verifyPool({ poolAddress: PLAN.pool.toBase58(), data: poolBlob({ baseMint: other, pool: PLAN.pool }), plan: PLAN });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE.MINT_MISMATCH);
  assert.equal(v.detail.actual, other.toBase58());
  ok('a pool for a different mint is refused');
}
{
  const elsewhere = derivePoolAddress(key(22), MINT, WSOL_MINT);
  const v = verifyPool({ poolAddress: elsewhere.toBase58(), data: poolBlob({ pool: elsewhere }), plan: PLAN });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE.POOL_MISMATCH);
  ok('the right mint in a pool at the wrong address is refused');
}
{
  // Same pool address, but the account says it belongs to another config. That
  // cannot happen honestly, so it is treated as the tampering-shaped event it is.
  const v = verifyPool({ poolAddress: PLAN.pool.toBase58(), data: poolBlob({ config: key(23) }), plan: PLAN });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE.CONFIG_MISMATCH);
  ok('a pool claiming a different config is refused');
}
{
  const blob = poolBlob();
  blob.set(key(24).toBuffer(), VIRTUAL_POOL.QUOTE_VAULT);
  const v = verifyPool({ poolAddress: PLAN.pool.toBase58(), data: blob, plan: PLAN });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REFUSE.QUOTE_VAULT_MISMATCH);
  ok('a pool reporting a vault we did not derive is refused');
}
{
  const v = verifyPool({ poolAddress: PLAN.pool.toBase58(), data: Buffer.alloc(10), plan: PLAN });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'not-a-virtual-pool');
  ok('a short blob is refused rather than throwing into the fire path');
}

// ---------------------------------------------------------------------------
console.log('\ntransaction assembly');

{
  const ix = snipeInstructions({ plan: PLAN, amountIn: 100n, minimumAmountOut: 1n, computeUnitLimit: 250_000, computeUnitPriceMicroLamports: 1_000 });
  assert.equal(ix.length, 4);
  // Order matters for reasons that are not cosmetic: the ATA must exist before
  // the swap writes into it, and the compute budget must be set before either.
  assert.equal(ix[0].programId.toBase58(), 'ComputeBudget111111111111111111111111111111');
  assert.equal(ix[1].programId.toBase58(), 'ComputeBudget111111111111111111111111111111');
  assert.equal(ix[2].programId.toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  assert.equal(ix[3].programId.toBase58(), DBC_PROGRAM_ID.toBase58());
  // The account created is the one the swap pays out into.
  assert.equal(ix[2].keys[1].pubkey.toBase58(), PLAN.outputTokenAccount.toBase58());
  ok('four instructions: budget, price, create the output account, swap');
}
{
  assert.throws(() => snipeInstructions({ plan: PLAN, amountIn: 1n, minimumAmountOut: 0n, computeUnitLimit: 0, computeUnitPriceMicroLamports: 0 }), /computeUnitLimit/);
  assert.throws(() => snipeInstructions({ plan: PLAN, amountIn: 1n, minimumAmountOut: 0n, computeUnitLimit: 1000, computeUnitPriceMicroLamports: -1 }), /computeUnitPriceMicroLamports/);
  ok('a zero compute limit and a negative price are refused');
}
{
  const ix = snipeInstructions({ plan: PLAN, amountIn: 250_000_000n, minimumAmountOut: 42n, computeUnitLimit: 250_000, computeUnitPriceMicroLamports: 1_000_000 });
  const signed = signSnipe({ instructions: ix, payer: BUYER, blockhash: BLOCKHASH, keypair: BUYER_KP });

  // It must survive the round trip a validator puts it through.
  const back = VersionedTransaction.deserialize(Buffer.from(signed.base64, 'base64'));
  assert.equal(back.message.recentBlockhash, BLOCKHASH);
  assert.equal(bs58.encode(back.signatures[0]), signed.signature);
  assert.equal(back.message.compiledInstructions.length, 4);
  assert.equal(back.message.staticAccountKeys[0].toBase58(), BUYER.toBase58());
  assert.ok(signed.bytes < 1232, `a transaction must fit one packet, got ${signed.bytes}B`);
  ok(`signs, serialises and fits in a packet (${signed.bytes}B of 1232)`);

  // The signature has to be real, because it is what the fill is watched under.
  assert.equal(back.signatures[0].length, 64);
  assert.notEqual(bs58.encode(back.signatures[0]), bs58.encode(new Uint8Array(64)));
  ok('the transaction is actually signed, not left with an empty signature');
}
{
  assert.throws(() => signSnipe({ instructions: [], payer: BUYER, blockhash: null, keypair: BUYER_KP }), /no blockhash/);
  ok('signing without a blockhash is refused');
}
{
  // Re-signing on a new blockhash must produce different bytes AND a different
  // signature — if it did not, the resend loop would be replaying a dead
  // transaction and the fill would never land.
  const ix = snipeInstructions({ plan: PLAN, amountIn: 1n, minimumAmountOut: 0n, computeUnitLimit: 250_000, computeUnitPriceMicroLamports: 1 });
  const a = signSnipe({ instructions: ix, payer: BUYER, blockhash: BLOCKHASH, keypair: BUYER_KP });
  const b = signSnipe({ instructions: ix, payer: BUYER, blockhash: bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 11) % 251)), keypair: BUYER_KP });
  assert.notEqual(a.base64, b.base64);
  assert.notEqual(a.signature, b.signature);
  ok('a new blockhash produces a genuinely new transaction');
}

// ---------------------------------------------------------------------------
console.log('\nthe discovery path, where nothing was known in advance');

{
  const plan = planFromLivePool({
    poolAddress: PLAN.pool.toBase58(), poolData: poolBlob(), buyer: BUYER, quoteMint: WSOL_MINT,
    tokenBaseProgram: TOKEN_PROGRAM, tokenQuoteProgram: TOKEN_PROGRAM, deriveAta,
  });
  assert.equal(plan.config.toBase58(), CONFIG.toBase58());
  assert.equal(plan.baseMint.toBase58(), MINT.toBase58());
  assert.equal(plan.pool.toBase58(), PLAN.pool.toBase58());
  assert.equal(plan.baseVault.toBase58(), PLAN.baseVault.toBase58());
  assert.equal(plan.outputTokenAccount.toBase58(), PLAN.outputTokenAccount.toBase58());
  ok('a live pool yields the same plan the pre-armed path derived');
}
{
  // The discovery path's one real hazard: we never told it the quote currency, so
  // a curve quoted in something else must be caught by the vault not matching,
  // rather than by a transaction that fails on chain having paid the fee.
  const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.throws(
    () => planFromLivePool({
      poolAddress: PLAN.pool.toBase58(), poolData: poolBlob(), buyer: BUYER, quoteMint: usdc,
      tokenBaseProgram: TOKEN_PROGRAM, tokenQuoteProgram: TOKEN_PROGRAM, deriveAta,
    }),
    /wrong quote mint configured/,
  );
  ok('a pool quoted in a different currency is caught before anything is signed');
}

// ---------------------------------------------------------------------------
console.log('\nfunding the quote side, vs spl-token');

{
  const ata = deriveAta(BUYER, WSOL_MINT, TOKEN_PROGRAM);
  const mine = buildSyncNativeInstruction(ata, TOKEN_PROGRAM);
  const theirs = createSyncNativeInstruction(ata, TOKEN_PROGRAM);
  assert.equal(mine.programId.toBase58(), theirs.programId.toBase58());
  assert.equal(Buffer.from(mine.data).toString('hex'), Buffer.from(theirs.data).toString('hex'));
  assert.equal(mine.keys[0].pubkey.toBase58(), theirs.keys[0].pubkey.toBase58());
  assert.equal(mine.keys[0].isWritable, theirs.keys[0].isWritable);
  ok('syncNative matches spl-token');
}
{
  const { ata, instructions } = wrapSolInstructions({ owner: BUYER, lamports: 1_000_000_000n, rentExemptLamports: 2_039_280n });
  assert.equal(ata.toBase58(), deriveAta(BUYER, WSOL_MINT, TOKEN_PROGRAM).toBase58());
  assert.equal(instructions.length, 3);
  // Rent must be ADDED to the buy size, not taken out of it: an account funded
  // with exactly the buy size is rent-poor and the swap then underspends. The
  // amount lives in the encoded data, so read it the way the runtime does:
  // u32 instruction index (2 = Transfer), then u64 lamports, little-endian.
  const transfer = Buffer.from(instructions[1].data);
  assert.equal(transfer.readUInt32LE(0), 2);
  assert.equal(transfer.readBigUInt64LE(4), 1_000_000_000n + 2_039_280n);
  assert.equal(instructions[1].keys[1].pubkey.toBase58(), ata.toBase58());
  ok('wrapping sends the buy size plus rent, and lands in the right account');
}
{
  const { instructions } = topUpWrappedSolInstructions({ owner: BUYER, lamports: 500n });
  assert.equal(instructions.length, 2);
  assert.equal(Buffer.from(instructions[0].data).readBigUInt64LE(4), 500n);
  ok('a top-up pays no second rent');
}
{
  assert.throws(() => wrapSolInstructions({ owner: BUYER, lamports: 0n, rentExemptLamports: 1n }), /positive bigint/);
  assert.throws(() => topUpWrappedSolInstructions({ owner: BUYER, lamports: -1n }), /positive bigint/);
  assert.equal(isWrappedSol(WSOL_MINT), true);
  assert.equal(isWrappedSol(MINT), false);
  ok('a zero or negative wrap is refused');
}

// ---------------------------------------------------------------------------
console.log('\naddress parsing');

{
  assert.equal(parseAddress('mint', MINT.toBase58()).toBase58(), MINT.toBase58());
  assert.throws(() => parseAddress('mint', ''), /required/);
  assert.throws(() => parseAddress('mint', undefined), /required/);
  assert.throws(() => parseAddress('mint', 'not!base58'), /not valid base58/);
  // A Solana address carries no checksum, so a deleted character can still decode
  // to 32 bytes — but a deleted character that does NOT is caught here.
  assert.throws(() => parseAddress('mint', MINT.toBase58().slice(0, 30)), /not 32/);
  ok('a malformed address fails loudly instead of watching an address nobody uses');
}

// ---------------------------------------------------------------------------
console.log('\nthe race, on a fake socket');

/** Enough of a WebSocket to drive the trigger path. */
class FakeSocket {
  constructor() { this.sent = []; this.listeners = {}; this.readyState = 1; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close', { code: 1000 }); }
  emit(name, ev) { for (const fn of this.listeners[name] ?? []) fn(ev); }
  message(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
}

/**
 * A sniper armed without touching a network: arm() is all RPC, and what is being
 * tested here is what happens after the trigger, not how the arm was obtained.
 */
function armedSniper(over = {}) {
  let socket;
  const sniper = new DbcSniper({
    wsUrl: 'ws://offline', httpUrl: 'http://offline',
    mint: MINT, quoteMint: WSOL_MINT, config: CONFIG, keypair: BUYER_KP,
    amountIn: 250_000_000n, minimumAmountOut: 1n,
    dryRun: true,
    wsFactory: () => { socket = new FakeSocket(); return socket; },
    ...over,
  });
  sniper.plan = PLAN;
  sniper.blockhashes.current = { blockhash: BLOCKHASH, lastValidBlockHeight: 1, at: Date.now() };
  sniper.presigned = signSnipe({
    instructions: snipeInstructions({ plan: PLAN, amountIn: 250_000_000n, minimumAmountOut: 1n, computeUnitLimit: 250_000, computeUnitPriceMicroLamports: 1_000_000 }),
    payer: BUYER, blockhash: BLOCKHASH, keypair: BUYER_KP,
  });
  sniper.state = STATE.ARMED;
  sniper.start();
  socket.emit('open', {});
  return { sniper, socket: () => socket };
}

const programNotification = (data, pubkey = PLAN.pool.toBase58(), slot = 100) => ({
  method: 'programNotification',
  params: { subscription: 1, result: { context: { slot }, value: { pubkey, account: { data: [data.toString('base64'), 'base64'] } } } },
});
const accountNotification = (data, slot = 100) => ({
  method: 'accountNotification',
  params: { subscription: 2, result: { context: { slot }, value: { data: [data.toString('base64'), 'base64'] } } },
});

{
  const { socket } = armedSniper();
  const subs = socket().sent;
  assert.equal(subs.length, 2);
  const program = subs.find((s) => s.method === 'programSubscribe');
  assert.equal(program.params[0], DBC_PROGRAM_ID.toBase58());
  assert.equal(program.params[1].commitment, 'processed');
  // The filter is the whole detection strategy. A wrong offset here does not
  // error — it simply never fires, which looks like a launch that never happened.
  assert.deepEqual(program.params[1].filters, [
    { dataSize: VIRTUAL_POOL.SIZE },
    { memcmp: { offset: VIRTUAL_POOL.BASE_MINT, bytes: MINT.toBase58() } },
  ]);
  const account = subs.find((s) => s.method === 'accountSubscribe');
  assert.equal(account.params[0], PLAN.pool.toBase58());
  ok('arming subscribes both triggers, filtered on our mint at the right offset');
}
{
  const { sniper, socket } = armedSniper();
  const events = [];
  for (const e of ['trigger', 'firing', 'dry-run', 'refused']) sniper.on(e, (d) => events.push([e, d]));

  socket().message(programNotification(poolBlob()));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(events.map(([e]) => e), ['trigger', 'firing', 'dry-run']);
  assert.equal(events[0][1].via, 'programNotification');
  assert.equal(events[1][1].signature, sniper.presigned.signature);
  assert.equal(events[1][1].amountIn, '250000000');
  ok('a pool notification fires the pre-signed transaction');
}
{
  // Both triggers fire on the same launch. Firing twice would buy twice.
  const { sniper, socket } = armedSniper();
  let firings = 0;
  sniper.on('firing', () => firings++);
  socket().message(programNotification(poolBlob()));
  socket().message(accountNotification(poolBlob()));
  socket().message(programNotification(poolBlob()));
  await new Promise((r) => setImmediate(r));
  assert.equal(firings, 1);
  assert.equal(sniper.stats.triggers, 3);
  ok('both triggers and a repeat still buy exactly once');
}
{
  const { sniper, socket } = armedSniper();
  const refusals = [];
  let firings = 0;
  sniper.on('refused', (d) => refusals.push(d));
  sniper.on('firing', () => firings++);
  socket().message(programNotification(poolBlob({ baseMint: key(31) })));
  await new Promise((r) => setImmediate(r));
  assert.equal(firings, 0);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].reason, REFUSE.MINT_MISMATCH);
  assert.equal(sniper.state, STATE.ABANDONED);
  ok('a mismatched pool refuses instead of firing');
}
{
  const { sniper, socket } = armedSniper();
  let fired = false;
  sniper.on('firing', () => { fired = true; });
  socket().message({ id: 1, error: { message: 'programSubscribe is not supported' } });
  socket().message(accountNotification(poolBlob()));
  await new Promise((r) => setImmediate(r));
  // Losing one trigger must not lose the launch — that is why there are two.
  assert.equal(fired, true);
  ok('accountSubscribe still fires when the provider refuses programSubscribe');
}
{
  const { sniper, socket } = armedSniper();
  const warnings = [];
  sniper.on('warn', (w) => warnings.push(w));
  socket().message({ id: 1, error: { message: 'programSubscribe is not supported' } });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].at, 'subscribe');
  sniper.stop();
  ok('a refused subscription is reported, not swallowed');
}

console.log(`\n${pass} checks passed\n`);
