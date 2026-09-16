// Tests for the Solana signing and transaction path.
//
// The golden hashes below are of bytes produced by @solana/web3.js and
// @solana/spl-token for the same inputs. A complete 8-instruction snipe — compute
// budget, wSOL wrap, two idempotent ATAs, the Swap2 buy and the close — serialises
// to the same 693-byte message, the same 758-byte wire transaction and the SAME
// SIGNATURE under both implementations. Those libraries are not dependencies of
// this project; they were used once, to produce these constants, and the point of
// pinning the hashes is that the hand-rolled path can never drift from them
// silently.

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { keypairFromSecret, keypairFromEnv } from './src/sol-keys.mjs';
import { encodeBase58, decodeBase58 } from './src/base58.mjs';
import {
  encodeCompactU16, compileAccounts, compileMessage, signTransaction, buildAndSign,
  blockhashOffset, resignWithBlockhash,
} from './src/sol-tx.mjs';
import { associatedTokenAddress, setComputeUnitLimit, setComputeUnitPrice } from './src/sol-programs.mjs';
import { buildSnipePlan, buildSnipePlans, estimateCost, shouldRefresh, shouldKeepFiring, BLOCKHASH_REFRESH_MS } from './src/sniper.mjs';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL } from './src/meteora-dbc.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// The fixture keypair: seed = 32 bytes of 0x09.
const SEED = Buffer.alloc(32, 9);
const PAYER = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf';
const CONFIG = 'DNXMreGaZGcanc2pqtZo4sQ23VoonXVATqjA3M8GwZri';
const MINT = '7TSj13Hjvuie641VYNsWcHrzsTasyGJ9ibbWNvx3U4ng';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const kp = keypairFromSecret(encodeBase58(Buffer.concat([SEED, decodeBase58(PAYER)])));

console.log('ed25519');
t('reproduces RFC 8032 test 1 public key', () => {
  const k = keypairFromSecret(encodeBase58(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')));
  assert.equal(k.publicKey.toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
});
t('reproduces RFC 8032 test 1 signature', () => {
  const k = keypairFromSecret(encodeBase58(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')));
  assert.equal(k.sign(Buffer.alloc(0)).toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
});
t('accepts the 64-number JSON array form', () => {
  const arr = JSON.stringify([...SEED, ...decodeBase58(PAYER)]);
  assert.equal(keypairFromSecret(arr).address, PAYER);
});
t('REFUSES a key whose public half disagrees with its seed', () => {
  // A truncated or corrupted paste. Signing anyway would produce valid signatures
  // for an address nobody is funding or watching.
  const wrong = Buffer.concat([SEED, Buffer.alloc(32, 1)]);
  assert.throws(() => keypairFromSecret(encodeBase58(wrong)), /public half does not match/);
});
t('refuses a wrong-length key', () => {
  assert.throws(() => keypairFromSecret(encodeBase58(Buffer.alloc(10))), /expected 32 or 64 bytes/);
});
t('keypairFromEnv reports a missing variable by name', () => {
  assert.throws(() => keypairFromEnv({}), /FIRSTFILL_SOLANA_KEY is not set/);
});

console.log('\ncompact-u16');
t('encodes the documented boundaries', () => {
  assert.equal(encodeCompactU16(0).toString('hex'), '00');
  assert.equal(encodeCompactU16(127).toString('hex'), '7f');
  assert.equal(encodeCompactU16(128).toString('hex'), '8001');
  assert.equal(encodeCompactU16(16383).toString('hex'), 'ff7f');
  assert.equal(encodeCompactU16(16384).toString('hex'), '808001');
});
t('refuses out of range', () => assert.throws(() => encodeCompactU16(65536), /out of range/));

console.log('\naccount compilation');
t('the fee payer is first, signer and writable', () => {
  const { keys } = compileAccounts(PAYER, [{ programId: TOKEN_PROGRAM, keys: [], data: Buffer.alloc(0) }]);
  assert.equal(keys[0].pubkey, PAYER);
  assert.equal(keys[0].isSigner, true);
  assert.equal(keys[0].isWritable, true);
});
t('a duplicate account keeps the STRONGER flags', () => {
  // Read-only in one instruction, writable in another: it must end up writable, or
  // the instruction that writes it fails at runtime.
  const { keys } = compileAccounts(PAYER, [
    { programId: TOKEN_PROGRAM, keys: [{ pubkey: MINT, isSigner: false, isWritable: false }], data: Buffer.alloc(0) },
    { programId: TOKEN_PROGRAM, keys: [{ pubkey: MINT, isSigner: false, isWritable: true }], data: Buffer.alloc(0) },
  ]);
  const m = keys.filter((k) => k.pubkey === MINT);
  assert.equal(m.length, 1, 'must be merged, not duplicated');
  assert.equal(m[0].isWritable, true);
});
t('the header counts match the positions', () => {
  const { keys, header } = compileAccounts(PAYER, [
    { programId: TOKEN_PROGRAM, keys: [
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
    ], data: Buffer.alloc(0) },
  ]);
  assert.equal(header.numRequiredSignatures, keys.filter((k) => k.isSigner).length);
  assert.equal(header.numReadonlyUnsigned, keys.filter((k) => !k.isSigner && !k.isWritable).length);
  // signers first, then writables, then the rest — no interleaving
  const ranks = keys.map((k) => (k.isSigner && k.isWritable ? 0 : k.isSigner ? 1 : k.isWritable ? 2 : 3));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});
t('a program used only as a program is still in the account list', () => {
  const { keys } = compileAccounts(PAYER, [{ programId: TOKEN_PROGRAM, keys: [], data: Buffer.alloc(0) }]);
  assert.ok(keys.some((k) => k.pubkey === TOKEN_PROGRAM));
});

console.log('\ncompute budget');
t('setComputeUnitLimit encodes discriminator 2 + u32', () =>
  assert.equal(setComputeUnitLimit(120_000).data.toString('hex'), '02c0d40100'));
t('setComputeUnitPrice encodes discriminator 3 + u64', () =>
  assert.equal(setComputeUnitPrice(500_000).data.toString('hex'), '0320a1070000000000'));

console.log('\nthe full snipe transaction, pinned against @solana/web3.js');
const plan = buildSnipePlan({
  config: CONFIG, baseMint: MINT, payer: PAYER, amountInLamports: 250_000_000n,
  minTokensOut: 1_000_000n, computeUnitLimit: 120_000, priorityFeeMicroLamports: 500_000,
  baseTokenProgram: TOKEN_2022_PROGRAM,
});
t('has the 8 expected instructions', () => assert.equal(plan.instructions.length, 8));
t('derives the same ATAs as @solana/spl-token', () => {
  assert.equal(plan.payerBaseAccount, 'ABo71DfVVGYZy57EQNLNCUr7jjh8svi9k6BewrN59NAr');
  assert.equal(plan.payerQuoteAccount, 'GXZz22k7KGw8pRjCZknCRggsscFuo3drHp6JoGRjkGt');
});
t('message is byte-identical to web3.js (693 bytes, pinned sha256)', () => {
  const c = plan.compile(BLOCKHASH);
  assert.equal(c.message.length, 693);
  assert.equal(sha(c.message), '715f4f826b8f0a9a7d9bbb21f9c9d0c3544c5da97f9115164592f68effb0e02b');
});
t('signed wire and signature are byte-identical to web3.js', () => {
  const signed = buildAndSign({ feePayer: PAYER, recentBlockhash: BLOCKHASH, instructions: plan.instructions }, kp);
  assert.equal(signed.wire.length, 758);
  assert.equal(sha(signed.wire), 'fc518da234ca03e6c8bec3c1d97b3d0c083974a97c8879dbf56e479076b434ba');
  assert.equal(signed.signature, '5YesYKDaL6ayceZE71pgTPJB5X8g3UX6TkRnbS5bmUbkuzDKvWfSefw463fGVSf1EikEfWZgRgUrL8KjRJvRHgPu');
});

console.log('\nONE FILL, NOT HUNDREDS — the property the spam depends on');
t('the same blockhash always yields the SAME signature', () => {
  // This is what makes blind re-sending safe: identical bytes mean the network
  // dedupes by signature and at most one attempt can ever execute.
  const a = buildAndSign({ feePayer: PAYER, recentBlockhash: BLOCKHASH, instructions: plan.instructions }, kp);
  const b = buildAndSign({ feePayer: PAYER, recentBlockhash: BLOCKHASH, instructions: plan.instructions }, kp);
  assert.equal(a.signature, b.signature);
  assert.equal(Buffer.compare(a.wire, b.wire), 0);
});
t('a different blockhash yields a DIFFERENT signature', () => {
  const a = buildAndSign({ feePayer: PAYER, recentBlockhash: BLOCKHASH, instructions: plan.instructions }, kp);
  const b = buildAndSign({ feePayer: PAYER, recentBlockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', instructions: plan.instructions }, kp);
  assert.notEqual(a.signature, b.signature);
});
t('blockhashOffset points at the blockhash, and resigning in place matches a rebuild', () => {
  const compiled = plan.compile(BLOCKHASH);
  const at = blockhashOffset(compiled);
  assert.equal(Buffer.compare(compiled.message.subarray(at, at + 32), decodeBase58(BLOCKHASH)), 0);
  const other = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
  const resigned = resignWithBlockhash(compiled, other, kp);
  const rebuilt = buildAndSign({ feePayer: PAYER, recentBlockhash: other, instructions: plan.instructions }, kp);
  assert.equal(resigned.signature, rebuilt.signature);
  assert.equal(Buffer.compare(resigned.wire, rebuilt.wire), 0);
});
t('shouldRefresh refuses to open a new signature once filled', () => {
  assert.equal(shouldRefresh({ now: 1e9, signedAt: 0, filled: true }).refresh, false);
  assert.equal(shouldRefresh({ now: 1e9, signedAt: 0, filled: true }).reason, 'already-filled');
});
t('shouldRefresh signs first, then only when stale', () => {
  assert.equal(shouldRefresh({ now: 1000, signedAt: null, filled: false }).refresh, true);
  assert.equal(shouldRefresh({ now: 1000, signedAt: 900, filled: false }).refresh, false);
  assert.equal(shouldRefresh({ now: 1000 + BLOCKHASH_REFRESH_MS, signedAt: 1000, filled: false }).refresh, true);
});
t('shouldRefresh stops at the deadline', () =>
  assert.equal(shouldRefresh({ now: 500, signedAt: null, filled: false, deadline: 500 }).reason, 'deadline-passed'));
t('shouldKeepFiring stops on fill, deadline and attempt cap', () => {
  assert.equal(shouldKeepFiring({ now: 0, filled: true, attempts: 0 }).reason, 'filled');
  assert.equal(shouldKeepFiring({ now: 10, filled: false, deadline: 10, attempts: 0 }).reason, 'deadline');
  assert.equal(shouldKeepFiring({ now: 0, filled: false, attempts: 5, maxAttempts: 5 }).reason, 'max-attempts');
  assert.equal(shouldKeepFiring({ now: 0, filled: false, attempts: 1, maxAttempts: 5 }).fire, true);
});

console.log('\nsnipe plan guards');
t('refuses a missing config, because the pool cannot be derived without it', () =>
  assert.throws(() => buildSnipePlan({ baseMint: MINT, payer: PAYER, amountInLamports: 1n, minTokensOut: 0n }), /config is required/));
t('refuses a missing minTokensOut rather than defaulting it to 0', () =>
  assert.throws(() => buildSnipePlan({ config: CONFIG, baseMint: MINT, payer: PAYER, amountInLamports: 1n }), /minTokensOut must be a bigint/));
t('accepts 0n when it is stated explicitly', () =>
  assert.ok(buildSnipePlan({ config: CONFIG, baseMint: MINT, payer: PAYER, amountInLamports: 1n, minTokensOut: 0n })));
t('refuses a non-positive amount', () =>
  assert.throws(() => buildSnipePlan({ config: CONFIG, baseMint: MINT, payer: PAYER, amountInLamports: 0n, minTokensOut: 0n }), /positive bigint/));
t('refuses a non-wSOL quote instead of silently wrapping SOL for it', () =>
  assert.throws(() => buildSnipePlan({ config: CONFIG, baseMint: MINT, payer: PAYER,
    amountInLamports: 1n, minTokensOut: 0n, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }), /only wSOL-quoted/));
t('buildSnipePlans covers both token programs, with different ATAs', () => {
  const plans = buildSnipePlans({ config: CONFIG, baseMint: MINT, payer: PAYER, amountInLamports: 1n, minTokensOut: 0n });
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.label), ['token-2022', 'spl-token']);
  // The token program is part of the ATA seed, so these must differ — if they did
  // not, one of the two variants would be pointless.
  assert.notEqual(plans[0].plan.payerBaseAccount, plans[1].plan.payerBaseAccount);
});
t('omits the priority-fee instruction when the fee is 0', () => {
  const p = buildSnipePlan({ config: CONFIG, baseMint: MINT, payer: PAYER, amountInLamports: 1n, minTokensOut: 0n, priorityFeeMicroLamports: 0 });
  assert.equal(p.instructions.length, 7);
});

console.log('\ncost of sending blind');
t('charges base fee plus priority fee per attempt', () => {
  // 120,000 CU x 500,000 microLamports / 1e6 = 60,000 lamports, + 5,000 base.
  const c = estimateCost({ attempts: 1, computeUnitLimit: 120_000, priorityFeeMicroLamports: 500_000 });
  assert.equal(c.perAttemptLamports, 65_000n);
});
t('scales with attempts and with both token-program variants', () => {
  const c = estimateCost({ attempts: 600, computeUnitLimit: 120_000, priorityFeeMicroLamports: 500_000, variants: 2 });
  assert.equal(c.totalLamports, 78_000_000n);
  assert.ok(Math.abs(c.totalSol - 0.078) < 1e-9);
});
t('a zero priority fee still costs the base fee', () =>
  assert.equal(estimateCost({ attempts: 10, computeUnitLimit: 120_000, priorityFeeMicroLamports: 0 }).totalLamports, 50_000n));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
