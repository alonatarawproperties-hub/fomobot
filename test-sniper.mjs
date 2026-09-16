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
  // arm() resolves these from the chain; there is no arm() here, so they are set
  // the same way arm() would set them.
  sniper.quoteTokenProgram = TOKEN_PROGRAM;
  sniper.blockhashes.current = { blockhash: BLOCKHASH, lastValidBlockHeight: 1, at: Date.now() };
  for (const b of sniper.buyers) {
    b.plan = planSnipe({ config: CONFIG, baseMint: MINT, quoteMint: WSOL_MINT, buyer: b.address, baseTokenType: 0, quoteTokenType: 0 });
    b.presigned = signSnipe({
      instructions: snipeInstructions({ plan: b.plan, amountIn: b.amountIn, minimumAmountOut: b.minimumAmountOut, computeUnitLimit: 250_000, computeUnitPriceMicroLamports: 1_000_000 }),
      payer: b.address, blockhash: BLOCKHASH, keypair: b.keypair,
    });
    b.signature = b.presigned.signature;
  }
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
  assert.equal(events[1][1].signatures[0].signature, sniper.buyers[0].signature);
  assert.equal(events[1][1].totalAmountIn, '250000000');
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
  assert.equal(sniper.state, STATE.SETTLED);
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
  // THE CASE THAT WOULD OTHERWISE LOSE THE LAUNCH.
  //
  // Some launchpads generate a fresh config per launch, in the same bundle that
  // creates the pool — so any config armed in advance is guaranteed wrong, and the
  // real pool appears at an address we never derived. Refusing there would mean
  // refusing to buy the right token at the only moment it can be bought.
  const { sniper, socket } = armedSniper();
  const events = [];
  for (const e of ['replanned', 'firing', 'refused']) sniper.on(e, (d) => events.push([e, d]));
  sniper.baseTokenProgram = TOKEN_PROGRAM;   // as `snipe.baseTokenProgram` would set it

  // Same mint, different config — so a different pool address entirely.
  const otherConfig = key(41);
  const realPool = derivePoolAddress(otherConfig, MINT, WSOL_MINT);
  socket().message(programNotification(
    poolBlob({ config: otherConfig, pool: realPool }), realPool.toBase58(),
  ));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(events.map(([e]) => e), ['replanned', 'firing']);
  assert.equal(events[0][1].actualPool, realPool.toBase58());
  // And it must now be aimed at the REAL pool, not the one it armed against.
  assert.equal(sniper.buyers[0].plan.pool.toBase58(), realPool.toBase58());
  assert.equal(sniper.buyers[0].plan.config.toBase58(), otherConfig.toBase58());
  assert.equal(sniper.buyers[0].plan.baseMint.toBase58(), MINT.toBase58());
  ok('a config that was never going to be right re-plans and fires, instead of refusing');
}
{
  // The re-plan must not become a way to buy the wrong token. A mismatched MINT
  // is still a hard refusal, however the pool address looks.
  const { sniper, socket } = armedSniper();
  const events = [];
  for (const e of ['replanned', 'firing', 'refused']) sniper.on(e, (d) => events.push([e, d]));
  sniper.baseTokenProgram = TOKEN_PROGRAM;

  const wrongMint = key(42);
  const elsewhere = derivePoolAddress(key(43), wrongMint, WSOL_MINT);
  socket().message(programNotification(
    poolBlob({ config: key(43), baseMint: wrongMint, pool: elsewhere }), elsewhere.toBase58(),
  ));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(events.map(([e]) => e), ['refused']);
  assert.equal(events[0][1].reason, REFUSE.MINT_MISMATCH);
  assert.equal(sniper.state, STATE.SETTLED);
  ok('re-planning never extends to a pool for a different mint');
}
{
  // A pool quoted in something other than what we funded must still be refused
  // on the re-plan route — it is the one thing planFromLivePool can catch.
  const { sniper, socket } = armedSniper();
  const errors = [];
  let fired = false;
  sniper.on('error', (e) => errors.push(e));
  sniper.on('firing', () => { fired = true; });
  sniper.baseTokenProgram = TOKEN_PROGRAM;

  const otherConfig = key(44);
  const realPool = derivePoolAddress(otherConfig, MINT, WSOL_MINT);
  const blob = poolBlob({ config: otherConfig, pool: realPool });
  blob.set(key(45).toBuffer(), VIRTUAL_POOL.QUOTE_VAULT);  // not our quote mint's vault
  socket().message(programNotification(blob, realPool.toBase58()));
  await new Promise((r) => setImmediate(r));

  assert.equal(fired, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /wrong quote mint configured/);
  ok('a re-planned pool quoted in another currency is caught before signing');
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

// ---------------------------------------------------------------------------
console.log('\nseveral wallets, one launch');

const KP = (n) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + n) % 251));

function multiSniper(sizes, over = {}) {
  let socket;
  const sniper = new DbcSniper({
    wsUrl: 'ws://offline', httpUrl: 'http://offline',
    mint: MINT, quoteMint: WSOL_MINT, config: null,
    buyers: sizes.map((amountIn, i) => ({
      keypair: KP(50 + i), amountIn, minimumAmountOut: 0n, label: `w${i + 1}`,
    })),
    dryRun: true,
    wsFactory: () => { socket = new FakeSocket(); return socket; },
    ...over,
  });
  sniper.quoteTokenProgram = TOKEN_PROGRAM;
  sniper.baseTokenProgram = TOKEN_PROGRAM;
  sniper.blockhashes.current = { blockhash: BLOCKHASH, lastValidBlockHeight: 1, at: Date.now() };
  sniper.state = STATE.ARMED;
  sniper.start();
  socket.emit('open', {});
  return { sniper, socket: () => socket };
}

{
  const sizes = [50_000_000n, 80_000_000n, 30_000_000n, 120_000_000n, 20_000_000n];
  const { sniper, socket } = multiSniper(sizes);
  const firings = [];
  sniper.on('firing', (d) => firings.push(d));

  const realPool = derivePoolAddress(key(60), MINT, WSOL_MINT);
  socket().message(programNotification(poolBlob({ config: key(60), pool: realPool }), realPool.toBase58()));
  await new Promise((r) => setImmediate(r));

  assert.equal(firings.length, 1);
  assert.equal(firings[0].wallets, 5);
  assert.equal(firings[0].totalAmountIn, '300000000');
  // Different sizes, because equal amounts across wallets is itself a pattern.
  assert.deepEqual(firings[0].signatures.map((s) => s.amountIn), sizes.map(String));
  ok('five wallets with different sizes all fire on one trigger');
}
{
  // Every wallet must sign its OWN transaction. One signature reused would mean
  // one buy pretending to be five, and four of them failing on chain.
  const { sniper, socket } = multiSniper([10_000_000n, 20_000_000n, 30_000_000n]);
  const firings = [];
  sniper.on('firing', (d) => firings.push(d));
  const realPool = derivePoolAddress(key(61), MINT, WSOL_MINT);
  socket().message(programNotification(poolBlob({ config: key(61), pool: realPool }), realPool.toBase58()));
  await new Promise((r) => setImmediate(r));

  const sigs = firings[0].signatures.map((s) => s.signature);
  assert.equal(new Set(sigs).size, 3, 'three distinct signatures');
  // And each is payable by its own wallet, not by the first.
  const payers = sniper.buyers.map((b) => b.address.toBase58());
  assert.equal(new Set(payers).size, 3);
  for (const b of sniper.buyers) {
    const tx = VersionedTransaction.deserialize(Buffer.from(b.presigned.base64, 'base64'));
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), b.address.toBase58(), `${b.label} pays for its own transaction`);
    assert.notEqual(bs58.encode(tx.signatures[0]), bs58.encode(new Uint8Array(64)), `${b.label} is signed`);
  }
  ok('each wallet signs and pays for its own transaction');
}
{
  // The pool, config and both vaults are identical for every wallet — only the
  // token accounts differ. Deriving them per wallet would be wasted hot-path work.
  const { sniper, socket } = multiSniper([10_000_000n, 20_000_000n, 30_000_000n]);
  const realPool = derivePoolAddress(key(62), MINT, WSOL_MINT);
  socket().message(programNotification(poolBlob({ config: key(62), pool: realPool }), realPool.toBase58()));
  await new Promise((r) => setImmediate(r));

  const pools = new Set(sniper.buyers.map((b) => b.plan.pool.toBase58()));
  const baseVaults = new Set(sniper.buyers.map((b) => b.plan.baseVault.toBase58()));
  const outputs = new Set(sniper.buyers.map((b) => b.plan.outputTokenAccount.toBase58()));
  assert.equal(pools.size, 1, 'one pool');
  assert.equal(baseVaults.size, 1, 'one base vault');
  assert.equal(outputs.size, 3, 'a separate output account per wallet');
  ok('wallets share the pool and its vaults, and never share a token account');
}
{
  // A wallet listed twice is two transactions spending one wrapped balance; the
  // second fails on chain having paid a fee.
  assert.throws(() => new DbcSniper({
    wsUrl: 'ws://o', httpUrl: 'http://o', mint: MINT, quoteMint: WSOL_MINT,
    buyers: [
      { keypair: KP(70), amountIn: 1n, minimumAmountOut: 0n },
      { keypair: KP(70), amountIn: 2n, minimumAmountOut: 0n },
    ],
  }), /appears more than once/);
  ok('the same wallet listed twice is refused');
}
{
  assert.throws(() => new DbcSniper({ wsUrl: 'ws://o', httpUrl: 'http://o', mint: MINT, quoteMint: WSOL_MINT, buyers: [] }), /no buyers/);
  assert.throws(() => new DbcSniper({
    wsUrl: 'ws://o', httpUrl: 'http://o', mint: MINT, quoteMint: WSOL_MINT,
    buyers: [{ keypair: KP(71), amountIn: 0n, minimumAmountOut: 0n }],
  }), /amountIn must be a positive bigint/);
  assert.throws(() => new DbcSniper({
    wsUrl: 'ws://o', httpUrl: 'http://o', mint: MINT, quoteMint: WSOL_MINT,
    buyers: [{ keypair: KP(72), amountIn: 1n, minimumAmountOut: -1n }],
  }), /minimumAmountOut must be a non-negative bigint/);
  ok('an empty list, a zero size and a negative floor are all refused');
}
{
  // PARTIAL OUTCOMES ARE NORMAL. Three wallets, one filling, one failing on
  // chain and one never seen, is a real result — and reporting it as a single
  // total would hide which wallets actually hold the token.
  const polls = [];
  // Keyed by SIGNATURE, not by position: a stub that answers positionally gives
  // the second poll's single pending wallet the first wallet's answer, which is
  // how this test passed while proving nothing the first time it was written.
  const outcomes = new Map();

  const { sniper, socket } = multiSniper([10_000_000n, 20_000_000n, 30_000_000n], {
    dryRun: false,
    confirmPollMs: 5,
    fireWindowMs: 80,
    statusFetcher: (sigs) => {
      polls.push(sigs);
      return Promise.resolve(sigs.map((sig) => outcomes.get(sig) ?? null));
    },
  });

  const filled = [], failed = [], settled = [];
  sniper.on('wallet-filled', (d) => filled.push(d));
  sniper.on('wallet-failed', (d) => failed.push(d));
  sniper.on('settled', (d) => settled.push(d));
  sniper.on('sent', () => {});
  sniper.on('send-error', () => {});
  // Signatures only exist once the transactions are built.
  sniper.on('firing', () => {
    outcomes.set(sniper.buyers[0].signature, { slot: 999, err: null, confirmations: 2 });
    outcomes.set(sniper.buyers[1].signature, { slot: 999, err: { InstructionError: [3, { Custom: 6000 }] } });
    // w3 stays absent: the cluster never saw it.
  });

  const realPool = derivePoolAddress(key(63), MINT, WSOL_MINT);
  socket().message(programNotification(poolBlob({ config: key(63), pool: realPool }), realPool.toBase58()));

  await new Promise((r) => setTimeout(r, 200));
  sniper.stop();

  assert.equal(polls[0].length, 3, 'all three signatures are polled in one call');
  assert.ok(polls.some((p) => p.length < 3), 'polling narrows to the unresolved wallets');

  assert.equal(filled.length, 1);
  assert.equal(filled[0].label, 'w1');
  assert.equal(filled[0].amountIn, '10000000');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].label, 'w2');
  assert.deepEqual(failed[0].err, { InstructionError: [3, { Custom: 6000 }] });

  assert.equal(settled.length, 1, 'settled is reported exactly once');
  assert.equal(settled[0].filled, 1);
  assert.equal(settled[0].failed, 1);
  assert.equal(settled[0].missed, 1);
  // Only what actually filled counts as spent.
  assert.equal(settled[0].totalSpent, '10000000');
  assert.equal(settled[0].wallets.length, 3);
  assert.equal(settled[0].wallets.find((w) => w.label === 'w3').state, 'abandoned');
  ok('one filled, one failed and one missed settle independently and report once');
}
{
  // A wallet that failed must not keep being re-sent: the signature is spent and
  // the resend loop would hammer a transaction that can never land.
  let calls = 0;
  const { sniper, socket } = multiSniper([10_000_000n], {
    dryRun: false, confirmPollMs: 5, resendMs: 10, fireWindowMs: 120,
    statusFetcher: (sigs) => Promise.resolve(sigs.map(() => ({ slot: 1, err: { Custom: 1 } }))),
  });
  sniper.on('sent', () => { calls++; });
  sniper.on('send-error', () => { calls++; });
  sniper.on('wallet-failed', () => {});
  sniper.on('settled', () => {});

  const realPool = derivePoolAddress(key(64), MINT, WSOL_MINT);
  socket().message(programNotification(poolBlob({ config: key(64), pool: realPool }), realPool.toBase58()));
  await new Promise((r) => setTimeout(r, 40));
  const afterFailure = calls;
  await new Promise((r) => setTimeout(r, 60));
  sniper.stop();

  assert.equal(calls, afterFailure, 'no further sends after the wallet failed');
  ok('resending stops for a wallet once its outcome is known');
}

console.log(`\n${pass} checks passed\n`);
