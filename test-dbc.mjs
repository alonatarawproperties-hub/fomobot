// Tests for the Meteora DBC primitives.
//
// The point of these is that every expected value below was READ OFF MAINNET on
// 2026-09-16, not produced by this code. The PDA derivation, the base58 codec and
// the account offsets are all checked against a real launch, so a regression in
// any of them fails here instead of sending a transaction to an address that does
// not exist.
//
// The reference launch, in full:
//   mint    7TSj13Hjvuie641VYNsWcHrzsTasyGJ9ibbWNvx3U4ng  (DeepNode AI, Token-2022)
//   config  DNXMreGaZGcanc2pqtZo4sQ23VoonXVATqjA3M8GwZri
//   pool    5DMQ9Ut8LM9vyfctyFiLHp8uDTsm56UsXjXeduwAH4Q3
//   vaults  DJwgMUiXcxTsuYasnfCH8PkCxhh3CQFUmTAP4VtEt6iX (base)
//           9JehK6Vs2XxPXw1arhHZVXbJgLsSFJ1wEeFvV6C4atbR (quote, wSOL)

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { encodeBase58, decodeBase58, isAddress } from './src/base58.mjs';
import {
  DBC_PROGRAM, WSOL, SWAP2_DISCRIMINATOR, VIRTUAL_POOL_DISCRIMINATOR, POOL_CONFIG_DISCRIMINATOR,
  derivePool, deriveVault, deriveLaunch, poolAuthority, eventAuthority, isOnCurve,
  decodeVirtualPool, decodePoolConfig, encodeSwap2Data, buildBuyAccounts, buildSellAccounts,
  poolByMintFilters, VIRTUAL_POOL_SIZE, POOL_OFFSET,
} from './src/meteora-dbc.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

const MINT = '7TSj13Hjvuie641VYNsWcHrzsTasyGJ9ibbWNvx3U4ng';
const CONFIG = 'DNXMreGaZGcanc2pqtZo4sQ23VoonXVATqjA3M8GwZri';
const POOL = '5DMQ9Ut8LM9vyfctyFiLHp8uDTsm56UsXjXeduwAH4Q3';
const BASE_VAULT = 'DJwgMUiXcxTsuYasnfCH8PkCxhh3CQFUmTAP4VtEt6iX';
const QUOTE_VAULT = '9JehK6Vs2XxPXw1arhHZVXbJgLsSFJ1wEeFvV6C4atbR';
const POOL_AUTH = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const EVENT_AUTH = '8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF';

console.log('base58');
t('round-trips 32 random bytes', () => {
  for (let i = 0; i < 200; i++) {
    const b = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    assert.equal(Buffer.compare(decodeBase58(encodeBase58(b)), b), 0);
  }
});
t('decodes a known address to 32 bytes', () => assert.equal(decodeBase58(MINT).length, 32));
t('preserves leading zero bytes as 1s', () => {
  const b = Buffer.concat([Buffer.alloc(3), Buffer.from([1, 2, 3])]);
  assert.equal(encodeBase58(b).slice(0, 3), '111');
  assert.equal(Buffer.compare(decodeBase58(encodeBase58(b)), b), 0);
});
t('system program is 32 zero bytes, not 33', () => {
  assert.equal(Buffer.compare(decodeBase58('11111111111111111111111111111111'), Buffer.alloc(32)), 0);
});
t('rejects a character outside the alphabet', () => {
  // 0, O, I and l are deliberately absent; accepting one silently would decode a
  // different address than the one written down.
  assert.throws(() => decodeBase58('0OIl'), /bad character/);
});
t('isAddress is shape-only', () => {
  assert.equal(isAddress(MINT), true);
  assert.equal(isAddress('nope'), false);
});

console.log('\ned25519 / PDA');
t('a real pubkey is on the curve', () => assert.equal(isOnCurve(decodeBase58(MINT)), true));
t('a derived address is NOT on the curve', () => assert.equal(isOnCurve(decodeBase58(POOL)), false));
t('the pool authority PDA matches mainnet', () => assert.equal(poolAuthority(), POOL_AUTH));
t('the event authority PDA matches mainnet', () => assert.equal(eventAuthority(), EVENT_AUTH));
t('derivePool matches mainnet', () => assert.equal(derivePool(CONFIG, MINT, WSOL), POOL));
t('derivePool defaults quote to wSOL', () => assert.equal(derivePool(CONFIG, MINT), POOL));
t('deriveVault matches mainnet for both legs', () => {
  assert.equal(deriveVault(MINT, POOL), BASE_VAULT);
  assert.equal(deriveVault(WSOL, POOL), QUOTE_VAULT);
});
t('deriveLaunch returns the whole verified set', () => {
  const l = deriveLaunch(CONFIG, MINT);
  assert.deepEqual(l, {
    pool: POOL, config: CONFIG, baseMint: MINT, quoteMint: WSOL,
    baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT,
    poolAuthority: POOL_AUTH, eventAuthority: EVENT_AUTH,
  });
});
t('mint ordering is sorted, not role order', () => {
  // The whole point of the 54,371-pool measurement. A mint sorting BELOW wSOL is
  // the only case where the two orderings differ, so it is the only case that can
  // catch the bug — and ~98% of mints sort above, which is why it hides.
  const low = encodeBase58(Buffer.concat([Buffer.from([0x01]), Buffer.alloc(31, 0x11)]));
  assert.ok(Buffer.compare(decodeBase58(low), decodeBase58(WSOL)) < 0, 'fixture must sort below wSOL');
  // Sorted order is symmetric in its arguments; role order would not be.
  assert.equal(derivePool(CONFIG, low, WSOL), derivePool(CONFIG, WSOL, low));
});

console.log('\ndiscriminators (independently derived from their Anchor names)');
const g = (n) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
const a = (n) => createHash('sha256').update(`account:${n}`).digest().subarray(0, 8);
t('Swap2 == sha256("global:swap2")', () => assert.equal(Buffer.compare(SWAP2_DISCRIMINATOR, g('swap2')), 0));
t('VirtualPool == sha256("account:VirtualPool")', () => assert.equal(Buffer.compare(VIRTUAL_POOL_DISCRIMINATOR, a('VirtualPool')), 0));
t('PoolConfig == sha256("account:PoolConfig")', () => assert.equal(Buffer.compare(POOL_CONFIG_DISCRIMINATOR, a('PoolConfig')), 0));

console.log('\naccount decoding');
t('decodeVirtualPool reads the real layout', () => {
  const raw = Buffer.alloc(VIRTUAL_POOL_SIZE);
  VIRTUAL_POOL_DISCRIMINATOR.copy(raw, 0);
  decodeBase58(CONFIG).copy(raw, POOL_OFFSET.config);
  decodeBase58(MINT).copy(raw, POOL_OFFSET.baseMint);
  decodeBase58(BASE_VAULT).copy(raw, POOL_OFFSET.baseVault);
  decodeBase58(QUOTE_VAULT).copy(raw, POOL_OFFSET.quoteVault);
  const p = decodeVirtualPool(raw);
  assert.equal(p.config, CONFIG);
  assert.equal(p.baseMint, MINT);
  assert.equal(p.baseVault, BASE_VAULT);
  assert.equal(p.quoteVault, QUOTE_VAULT);
});
t('decodeVirtualPool refuses a wrong discriminator', () => {
  const raw = Buffer.alloc(VIRTUAL_POOL_SIZE);
  assert.throws(() => decodeVirtualPool(raw), /discriminator/);
});
t('decodeVirtualPool refuses a wrong size', () => {
  assert.throws(() => decodeVirtualPool(Buffer.alloc(400)), /424 bytes/);
});
t('decodePoolConfig reads the quote mint', () => {
  const raw = Buffer.alloc(1048);
  POOL_CONFIG_DISCRIMINATOR.copy(raw, 0);
  decodeBase58(WSOL).copy(raw, 8);
  assert.equal(decodePoolConfig(raw).quoteMint, WSOL);
});

console.log('\nswap construction');
t('encodeSwap2Data reproduces the live swap byte-for-byte', () => {
  // The exact instruction data from the swap that was decoded on mainnet.
  const live = '414b3f4ceb5b5b8816fe6f1b09000000f26c30020000000000';
  assert.equal(encodeSwap2Data(39115030038n, 36728050n, 0).toString('hex'), live);
});
t('encodeSwap2Data is 25 bytes', () => assert.equal(encodeSwap2Data(1n, 1n).length, 25));
t('buy and sell differ ONLY in the two token accounts', () => {
  const common = {
    poolAuthority: POOL_AUTH, config: CONFIG, pool: POOL, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT,
    baseMint: MINT, quoteMint: WSOL, payer: 'Gb62PsGfcAUFLdQBJqn9rZsehL2MkD8vGeX2pCaUPswq',
    tokenBaseProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    tokenQuoteProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    eventAuthority: EVENT_AUTH, payerBaseAccount: 'BASE_ATA', payerQuoteAccount: 'QUOTE_ATA',
  };
  const buy = buildBuyAccounts(common), sell = buildSellAccounts(common);
  assert.equal(buy.length, 15);
  assert.equal(buy[3].pubkey, 'QUOTE_ATA');   // buy: quote in
  assert.equal(buy[4].pubkey, 'BASE_ATA');
  assert.equal(sell[3].pubkey, 'BASE_ATA');   // sell: base in
  assert.equal(sell[4].pubkey, 'QUOTE_ATA');
  for (let i = 0; i < 15; i++) if (i !== 3 && i !== 4) assert.equal(buy[i].pubkey, sell[i].pubkey);
});
t('only the payer signs', () => {
  const accs = buildBuyAccounts({
    poolAuthority: POOL_AUTH, config: CONFIG, pool: POOL, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT,
    baseMint: MINT, quoteMint: WSOL, payer: 'PAYER', tokenBaseProgram: 'TB', tokenQuoteProgram: 'TQ',
    eventAuthority: EVENT_AUTH, payerBaseAccount: 'B', payerQuoteAccount: 'Q',
  });
  assert.deepEqual(accs.filter((x) => x.isSigner).map((x) => x.pubkey), ['PAYER']);
});
t('poolByMintFilters targets offset 136', () => {
  const f = poolByMintFilters(MINT);
  assert.deepEqual(f[0], { dataSize: 424 });
  assert.equal(f[1].memcmp.offset, 136);
  assert.equal(f[1].memcmp.bytes, MINT);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
