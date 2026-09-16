// Offline tests for the Meteora DBC protocol layer. No network, no keys.
//
// The oracle is Meteora's own SDK and Anchor, both run from the IDL that ships
// in @meteora-ag/dynamic-bonding-curve-sdk. Nothing here trusts a constant
// written into src/meteora/dbc.mjs by hand: the program id, the discriminators,
// the account order and every byte offset are RECOMPUTED from that IDL and
// compared. If Meteora ships a layout change, this suite goes red instead of the
// bot quietly never firing — which is the failure mode that matters, because a
// wrong memcmp offset does not throw, it just watches nothing forever.

import assert from 'node:assert/strict';
import { PublicKey, Keypair } from '@solana/web3.js';
import { DynamicBondingCurveIdl as IDL } from '@meteora-ag/dynamic-bonding-curve-sdk';
import * as sdk from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

import {
  DBC_PROGRAM_ID, POOL_AUTHORITY, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT,
  SWAP_DISCRIMINATOR, VIRTUAL_POOL_DISCRIMINATOR, VIRTUAL_POOL, POOL_CONFIG,
  tokenProgramFor, deriveEventAuthority, derivePoolAddress, deriveTokenVault, deriveAta,
  isVirtualPool, decodeVirtualPool, decodePoolConfig,
  buildSwapInstruction, buildCreateAtaIdempotentInstruction, planSnipe,
} from './src/meteora/dbc.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };

// Deterministic keys, so a failure is reproducible rather than a different
// random pubkey every run.
const key = (n) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + n) % 251)).publicKey;
const CONFIG = key(1), BASE_MINT = key(2), BUYER = key(3), CREATOR = key(4);

// ---------------------------------------------------------------------------
// The IDL is the source of truth for every constant in dbc.mjs.
// ---------------------------------------------------------------------------
console.log('\nconstants, recomputed from the shipped IDL');

{
  assert.equal(IDL.address, DBC_PROGRAM_ID.toBase58());
  ok('program id matches idl.address');
}
{
  const swap = IDL.instructions.find((i) => i.name === 'swap');
  assert.deepEqual([...SWAP_DISCRIMINATOR], swap.discriminator);
  const pinned = swap.accounts.find((a) => a.name === 'pool_authority');
  assert.equal(pinned.address, POOL_AUTHORITY.toBase58());
  ok('swap discriminator and pinned pool authority match the IDL');
}
{
  const vp = IDL.accounts.find((a) => a.name === 'VirtualPool');
  assert.deepEqual([...VIRTUAL_POOL_DISCRIMINATOR], vp.discriminator);
  ok('VirtualPool discriminator matches the IDL');
}
{
  // PDA["pool_authority"] and PDA["__event_authority"] are derived, not typed in.
  const [derived] = PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], DBC_PROGRAM_ID);
  assert.equal(derived.toBase58(), POOL_AUTHORITY.toBase58());
  assert.equal(deriveEventAuthority().toBase58(), sdk.deriveDbcEventAuthority().toBase58());
  ok('pool authority derives to the pinned address; event authority matches the SDK');
}

// Walk the IDL's type graph and recompute every offset dbc.mjs hardcodes.
{
  const prim = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32, publickey: 32, f32: 4, f64: 8 };
  const byName = new Map(IDL.types.map((t) => [t.name, t.type]));
  const size = (t) => {
    if (typeof t === 'string') {
      const k = t.toLowerCase();
      if (!(k in prim)) throw new Error(`unknown primitive ${t}`);
      return prim[k];
    }
    if (t.array) return size(t.array[0]) * t.array[1];
    if (t.defined) {
      const n = typeof t.defined === 'string' ? t.defined : t.defined.name;
      const d = byName.get(n);
      if (!d) throw new Error(`unknown type ${n}`);
      if (d.kind === 'struct') return d.fields.reduce((s, f) => s + size(f.type), 0);
      if (d.kind === 'enum') return 1;
      throw new Error(`unhandled kind ${d.kind}`);
    }
    throw new Error(`unhandled type ${JSON.stringify(t)}`);
  };
  const layout = (structName) => {
    const out = new Map();
    let off = 8; // anchor discriminator
    for (const f of byName.get(structName).fields) { out.set(f.name, off); off += size(f.type); }
    return { fields: out, total: off };
  };

  // VirtualPool wraps a single PoolState, so its fields start at the same offsets.
  const pool = layout('PoolState');
  assert.equal(pool.total, VIRTUAL_POOL.SIZE);
  assert.equal(pool.fields.get('config'), VIRTUAL_POOL.CONFIG);
  assert.equal(pool.fields.get('creator'), VIRTUAL_POOL.CREATOR);
  assert.equal(pool.fields.get('base_mint'), VIRTUAL_POOL.BASE_MINT);
  assert.equal(pool.fields.get('base_vault'), VIRTUAL_POOL.BASE_VAULT);
  assert.equal(pool.fields.get('quote_vault'), VIRTUAL_POOL.QUOTE_VAULT);
  assert.equal(pool.fields.get('base_reserve'), VIRTUAL_POOL.BASE_RESERVE);
  assert.equal(pool.fields.get('quote_reserve'), VIRTUAL_POOL.QUOTE_RESERVE);
  assert.equal(pool.fields.get('sqrt_price'), VIRTUAL_POOL.SQRT_PRICE);
  assert.equal(pool.fields.get('activation_point'), VIRTUAL_POOL.ACTIVATION_POINT);
  ok('every VirtualPool offset recomputes from the IDL — including the memcmp one');

  const cfg = layout('PoolConfig');
  assert.equal(cfg.total, POOL_CONFIG.SIZE);
  assert.equal(cfg.fields.get('quote_mint'), POOL_CONFIG.QUOTE_MINT);
  assert.equal(cfg.fields.get('activation_type'), POOL_CONFIG.ACTIVATION_TYPE);
  assert.equal(cfg.fields.get('token_decimal'), POOL_CONFIG.TOKEN_DECIMAL);
  assert.equal(cfg.fields.get('token_type'), POOL_CONFIG.TOKEN_TYPE);
  assert.equal(cfg.fields.get('quote_token_flag'), POOL_CONFIG.QUOTE_TOKEN_FLAG);
  ok('every PoolConfig offset recomputes from the IDL');
}

// ---------------------------------------------------------------------------
// Address derivation, against the SDK's own helpers.
// ---------------------------------------------------------------------------
console.log('\naddress derivation vs the Meteora SDK');

{
  // Many mints, because the pool seed order depends on which key sorts bigger
  // and a single fixture could pass while getting the comparison backwards.
  let sawBigger = 0, sawSmaller = 0;
  for (let i = 0; i < 40; i++) {
    const base = Keypair.generate().publicKey;
    const quote = i % 2 ? WSOL_MINT : Keypair.generate().publicKey;
    if (Buffer.compare(quote.toBuffer(), base.toBuffer()) > 0) sawBigger++; else sawSmaller++;
    assert.equal(
      derivePoolAddress(CONFIG, base, quote).toBase58(),
      sdk.deriveDbcPoolAddress(quote, base, CONFIG).toBase58(),
    );
  }
  assert.ok(sawBigger > 0 && sawSmaller > 0, 'both seed orderings must be exercised');
  ok(`pool address matches the SDK over 40 mint pairs (${sawBigger} quote-bigger, ${sawSmaller} base-bigger)`);
}
{
  const pool = derivePoolAddress(CONFIG, BASE_MINT, WSOL_MINT);
  assert.equal(deriveTokenVault(pool, BASE_MINT).toBase58(), sdk.deriveDbcTokenVaultAddress(pool, BASE_MINT).toBase58());
  assert.equal(deriveTokenVault(pool, WSOL_MINT).toBase58(), sdk.deriveDbcTokenVaultAddress(pool, WSOL_MINT).toBase58());
  // The two vaults must not collide — the seed order (mint, pool) is what keeps
  // them apart, and reversing it would still produce two valid-looking PDAs.
  assert.notEqual(deriveTokenVault(pool, BASE_MINT).toBase58(), deriveTokenVault(pool, WSOL_MINT).toBase58());
  ok('base and quote vaults match the SDK and are distinct');
}
{
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    assert.equal(
      deriveAta(BUYER, BASE_MINT, program).toBase58(),
      getAssociatedTokenAddressSync(BASE_MINT, BUYER, true, program).toBase58(),
    );
  }
  // A Token-2022 mint has a DIFFERENT associated account than an SPL one. Using
  // the wrong program here sends the output somewhere the buyer cannot spend.
  assert.notEqual(
    deriveAta(BUYER, BASE_MINT, TOKEN_PROGRAM).toBase58(),
    deriveAta(BUYER, BASE_MINT, TOKEN_2022_PROGRAM).toBase58(),
  );
  ok('ATA matches spl-token for both token programs, and they differ');
}
{
  assert.equal(tokenProgramFor(0).toBase58(), TOKEN_PROGRAM.toBase58());
  assert.equal(tokenProgramFor(1).toBase58(), TOKEN_2022_PROGRAM.toBase58());
  assert.throws(() => tokenProgramFor(2), /unknown token type/);
  assert.throws(() => tokenProgramFor(undefined), /unknown token type/);
  ok('token type maps to a program, and an unknown type is refused rather than defaulted');
}

// ---------------------------------------------------------------------------
// Account decoding.
// ---------------------------------------------------------------------------
console.log('\naccount decoding');

const virtualPoolBlob = ({ config = CONFIG, baseMint = BASE_MINT, baseVault = key(5), quoteVault = key(6), creator = CREATOR, baseReserve = 0n, quoteReserve = 0n, activationPoint = 0n } = {}) => {
  const b = Buffer.alloc(VIRTUAL_POOL.SIZE);
  b.set(VIRTUAL_POOL_DISCRIMINATOR, 0);
  b.set(config.toBuffer(), VIRTUAL_POOL.CONFIG);
  b.set(creator.toBuffer(), VIRTUAL_POOL.CREATOR);
  b.set(baseMint.toBuffer(), VIRTUAL_POOL.BASE_MINT);
  b.set(baseVault.toBuffer(), VIRTUAL_POOL.BASE_VAULT);
  b.set(quoteVault.toBuffer(), VIRTUAL_POOL.QUOTE_VAULT);
  b.writeBigUInt64LE(baseReserve, VIRTUAL_POOL.BASE_RESERVE);
  b.writeBigUInt64LE(quoteReserve, VIRTUAL_POOL.QUOTE_RESERVE);
  b.writeBigUInt64LE(activationPoint, VIRTUAL_POOL.ACTIVATION_POINT);
  return b;
};

{
  const vault = key(5), qvault = key(6);
  const got = decodeVirtualPool(virtualPoolBlob({ baseVault: vault, quoteVault: qvault, baseReserve: 123n, quoteReserve: 456n, activationPoint: 789n }));
  assert.equal(got.config.toBase58(), CONFIG.toBase58());
  assert.equal(got.creator.toBase58(), CREATOR.toBase58());
  assert.equal(got.baseMint.toBase58(), BASE_MINT.toBase58());
  assert.equal(got.baseVault.toBase58(), vault.toBase58());
  assert.equal(got.quoteVault.toBase58(), qvault.toBase58());
  assert.equal(got.baseReserve, 123n);
  assert.equal(got.quoteReserve, 456n);
  assert.equal(got.activationPoint, 789n);
  ok('a VirtualPool round-trips through the offsets');
}
{
  // The vaults the pool REPORTS must be the vaults we would have derived. If
  // these ever disagree, the pre-armed plan is pointing at the wrong accounts,
  // and that is worth catching rather than assuming.
  const pool = derivePoolAddress(CONFIG, BASE_MINT, WSOL_MINT);
  const blob = virtualPoolBlob({ baseVault: deriveTokenVault(pool, BASE_MINT), quoteVault: deriveTokenVault(pool, WSOL_MINT) });
  const got = decodeVirtualPool(blob);
  assert.equal(got.baseVault.toBase58(), deriveTokenVault(pool, BASE_MINT).toBase58());
  ok('reported vaults agree with derived vaults');
}
{
  assert.equal(isVirtualPool(virtualPoolBlob()), true);
  const wrongSize = Buffer.alloc(VIRTUAL_POOL.SIZE - 1);
  wrongSize.set(VIRTUAL_POOL_DISCRIMINATOR, 0);
  assert.equal(isVirtualPool(wrongSize), false);
  const wrongDisc = virtualPoolBlob();
  wrongDisc[0] ^= 0xff;
  assert.equal(isVirtualPool(wrongDisc), false);
  assert.throws(() => decodeVirtualPool(wrongDisc), /not a VirtualPool/);
  ok('a blob of the wrong size or discriminator is refused, not decoded');
}
{
  const b = Buffer.alloc(POOL_CONFIG.SIZE);
  b.set(WSOL_MINT.toBuffer(), POOL_CONFIG.QUOTE_MINT);
  b[POOL_CONFIG.TOKEN_TYPE] = 1;
  b[POOL_CONFIG.QUOTE_TOKEN_FLAG] = 0;
  b[POOL_CONFIG.TOKEN_DECIMAL] = 6;
  b[POOL_CONFIG.ACTIVATION_TYPE] = 1;
  const got = decodePoolConfig(b);
  assert.equal(got.quoteMint.toBase58(), WSOL_MINT.toBase58());
  assert.equal(got.tokenType, 1);
  assert.equal(got.quoteTokenFlag, 0);
  assert.equal(got.tokenDecimal, 6);
  assert.equal(got.activationType, 1);
  assert.throws(() => decodePoolConfig(Buffer.alloc(100)), /expected 1048/);
  ok('a PoolConfig round-trips, and a short buffer is refused');
}

// ---------------------------------------------------------------------------
// Instruction encoding, against Anchor building from the same IDL.
// ---------------------------------------------------------------------------
console.log('\ninstruction encoding vs Anchor');

{
  const { Program } = await import('@coral-xyz/anchor');
  const BN = (await import('bn.js')).default;

  // Anchor only needs a provider to SEND. Building an instruction is offline, so
  // a connection-shaped stub is enough and nothing here can touch a network.
  const program = new Program(IDL, { connection: { rpcEndpoint: 'http://offline' }, publicKey: BUYER });

  const plan = planSnipe({ config: CONFIG, baseMint: BASE_MINT, quoteMint: WSOL_MINT, buyer: BUYER, baseTokenType: 0, quoteTokenType: 0 });
  const amountIn = 250_000_000n, minOut = 1n;

  const mine = buildSwapInstruction({
    config: plan.config, pool: plan.pool,
    inputTokenAccount: plan.inputTokenAccount, outputTokenAccount: plan.outputTokenAccount,
    baseVault: plan.baseVault, quoteVault: plan.quoteVault,
    baseMint: plan.baseMint, quoteMint: plan.quoteMint, payer: plan.buyer,
    tokenBaseProgram: plan.tokenBaseProgram, tokenQuoteProgram: plan.tokenQuoteProgram,
    amountIn, minimumAmountOut: minOut,
  });

  const theirs = await program.methods
    .swap({ amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minOut.toString()) })
    .accountsPartial({
      poolAuthority: POOL_AUTHORITY, config: plan.config, pool: plan.pool,
      inputTokenAccount: plan.inputTokenAccount, outputTokenAccount: plan.outputTokenAccount,
      baseVault: plan.baseVault, quoteVault: plan.quoteVault,
      baseMint: plan.baseMint, quoteMint: plan.quoteMint, payer: plan.buyer,
      tokenBaseProgram: plan.tokenBaseProgram, tokenQuoteProgram: plan.tokenQuoteProgram,
      referralTokenAccount: null,
    })
    .instruction();

  assert.equal(mine.programId.toBase58(), theirs.programId.toBase58());
  assert.equal(Buffer.from(mine.data).toString('hex'), Buffer.from(theirs.data).toString('hex'));
  assert.equal(mine.keys.length, theirs.keys.length);
  for (let i = 0; i < theirs.keys.length; i++) {
    const a = mine.keys[i], b = theirs.keys[i];
    assert.equal(a.pubkey.toBase58(), b.pubkey.toBase58(), `account ${i} pubkey`);
    assert.equal(a.isSigner, b.isSigner, `account ${i} isSigner`);
    assert.equal(a.isWritable, b.isWritable, `account ${i} isWritable`);
  }
  ok(`swap instruction is byte-identical to Anchor's, all ${theirs.keys.length} accounts`);

  // And the amounts really are in the bytes, little-endian, where the program
  // reads them — a discriminator-only comparison would pass with both zeroed.
  assert.equal(Buffer.from(mine.data).readBigUInt64LE(8), amountIn);
  assert.equal(Buffer.from(mine.data).readBigUInt64LE(16), minOut);
  ok('amountIn and minimumAmountOut are encoded where the program reads them');
}
{
  const ata = deriveAta(BUYER, BASE_MINT, TOKEN_PROGRAM);
  const mine = buildCreateAtaIdempotentInstruction({ payer: BUYER, owner: BUYER, mint: BASE_MINT, tokenProgram: TOKEN_PROGRAM });
  const theirs = createAssociatedTokenAccountIdempotentInstruction(BUYER, ata, BUYER, BASE_MINT, TOKEN_PROGRAM);
  assert.equal(mine.programId.toBase58(), theirs.programId.toBase58());
  assert.equal(Buffer.from(mine.data).toString('hex'), Buffer.from(theirs.data).toString('hex'));
  assert.equal(mine.keys.length, theirs.keys.length);
  for (let i = 0; i < theirs.keys.length; i++) {
    assert.equal(mine.keys[i].pubkey.toBase58(), theirs.keys[i].pubkey.toBase58(), `ata account ${i}`);
    assert.equal(mine.keys[i].isSigner, theirs.keys[i].isSigner, `ata account ${i} signer`);
    assert.equal(mine.keys[i].isWritable, theirs.keys[i].isWritable, `ata account ${i} writable`);
  }
  ok('idempotent ATA creation matches spl-token exactly');
}

// ---------------------------------------------------------------------------
// Refusals. A snipe that builds something wrong is worse than one that refuses.
// ---------------------------------------------------------------------------
console.log('\nrefusals');

{
  const plan = planSnipe({ config: CONFIG, baseMint: BASE_MINT, quoteMint: WSOL_MINT, buyer: BUYER, baseTokenType: 0, quoteTokenType: 0 });
  const args = {
    config: plan.config, pool: plan.pool,
    inputTokenAccount: plan.inputTokenAccount, outputTokenAccount: plan.outputTokenAccount,
    baseVault: plan.baseVault, quoteVault: plan.quoteVault,
    baseMint: plan.baseMint, quoteMint: plan.quoteMint, payer: plan.buyer,
    tokenBaseProgram: plan.tokenBaseProgram, tokenQuoteProgram: plan.tokenQuoteProgram,
    amountIn: 1n, minimumAmountOut: 0n,
  };
  assert.throws(() => buildSwapInstruction({ ...args, pool: plan.pool.toBase58() }), /pool must be a PublicKey/);
  assert.throws(() => buildSwapInstruction({ ...args, amountIn: 1 }), /must be bigints/);
  assert.throws(() => buildSwapInstruction({ ...args, amountIn: 0n }), /amountIn must be positive/);
  assert.throws(() => buildSwapInstruction({ ...args, minimumAmountOut: -1n }), /cannot be negative/);
  // A base58 string where a PublicKey belongs is the realistic mistake: it reads
  // fine in a config file and would otherwise encode as garbage.
  ok('a string address, a Number amount, a zero buy and a negative floor are all refused');
}
{
  const plan = planSnipe({ config: CONFIG, baseMint: BASE_MINT, quoteMint: WSOL_MINT, buyer: BUYER, baseTokenType: 1, quoteTokenType: 0 });
  assert.equal(plan.tokenBaseProgram.toBase58(), TOKEN_2022_PROGRAM.toBase58());
  assert.equal(plan.tokenQuoteProgram.toBase58(), TOKEN_PROGRAM.toBase58());
  assert.equal(plan.outputTokenAccount.toBase58(), deriveAta(BUYER, BASE_MINT, TOKEN_2022_PROGRAM).toBase58());
  assert.throws(() => planSnipe({ config: CONFIG, baseMint: BASE_MINT, quoteMint: WSOL_MINT, buyer: BUYER, baseTokenType: 7, quoteTokenType: 0 }), /unknown token type/);
  ok('a Token-2022 base mint plans a Token-2022 output account');
}

console.log(`\n${pass} checks passed\n`);
