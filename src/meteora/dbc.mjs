// Meteora Dynamic Bonding Curve — the protocol layer.
//
// Pure: no RPC, no keys, no clock. Everything here can be asserted offline, and
// test-meteora.mjs does exactly that against Meteora's own SDK as the oracle —
// same PDAs, same account order, same instruction bytes. That cross-check is the
// point of hand-rolling this at all.
//
// WHY HAND-ROLL IT. @meteora-ag/dynamic-bonding-curve-sdk builds the same swap,
// but its buildSwap fetches the pool and the config over RPC every call. On a
// snipe those round-trips land squarely in the window we are trying to win, and
// they happen AFTER the launch is already visible. Here the transaction is
// assembled from bytes we already hold, so firing costs a sign and a send.
//
// EVERY CONSTANT BELOW WAS EXTRACTED FROM THE IDL SHIPPED IN THAT SDK (v1.5.12),
// not from memory or a blog post:
//   - program id and pool authority: idl.address, and the pinned `address` on the
//     swap instruction's poolAuthority account
//   - discriminators: idl.instructions[].discriminator / idl.accounts[].discriminator
//   - field offsets: computed by walking idl.types, not counted by hand
// test-meteora.mjs recomputes all of it from the installed SDK and fails if a
// future version moves anything.

import { PublicKey } from '@solana/web3.js';

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');

/** Pinned in the IDL on every instruction that takes it — PDA["pool_authority"]. */
export const POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** idl.instructions.find(i => i.name === 'swap').discriminator */
export const SWAP_DISCRIMINATOR = Uint8Array.from([248, 198, 158, 145, 225, 117, 135, 200]);

/** idl.accounts.find(a => a.name === 'VirtualPool').discriminator */
export const VIRTUAL_POOL_DISCRIMINATOR = Uint8Array.from([213, 224, 5, 209, 98, 69, 119, 92]);

/**
 * Byte offsets into a VirtualPool account, discriminator included.
 *
 * BASE_MINT is the one that matters most: it is what the programSubscribe memcmp
 * filter keys on, which is how a launch is detected without knowing the config
 * in advance. Getting this wrong does not throw — it silently never fires — so it
 * is derived from the IDL in the test rather than trusted here.
 */
export const VIRTUAL_POOL = Object.freeze({
  SIZE: 424,
  CONFIG: 72,
  CREATOR: 104,
  BASE_MINT: 136,
  BASE_VAULT: 168,
  QUOTE_VAULT: 200,
  BASE_RESERVE: 232,
  QUOTE_RESERVE: 240,
  SQRT_PRICE: 280,
  ACTIVATION_POINT: 296,
});

/** Byte offsets into a PoolConfig account, discriminator included. */
export const POOL_CONFIG = Object.freeze({
  SIZE: 1048,
  QUOTE_MINT: 8,
  ACTIVATION_TYPE: 234,
  TOKEN_DECIMAL: 235,
  TOKEN_TYPE: 237,        // base mint's token program: 0 = SPL Token, 1 = Token-2022
  QUOTE_TOKEN_FLAG: 238,  // same enum, for the quote mint
});

/** TokenType in the SDK: 0 = SPLToken, 1 = Token2022. */
export function tokenProgramFor(tokenType) {
  if (tokenType === 0) return TOKEN_PROGRAM;
  if (tokenType === 1) return TOKEN_2022_PROGRAM;
  throw new Error(`unknown token type ${tokenType}`);
}

const seed = (s) => Buffer.from(s, 'utf8');

/** PDA["__event_authority"] — every DBC instruction emits through it. */
export function deriveEventAuthority() {
  return PublicKey.findProgramAddressSync([seed('__event_authority')], DBC_PROGRAM_ID)[0];
}

/**
 * The virtual pool's address.
 *
 * Seeds are ["pool", config, bigger mint, smaller mint] — compared as raw 32-byte
 * keys, NOT as base58 strings. This is the whole reason a snipe can be pre-built:
 * given the config, the pool address is known before the pool exists.
 */
export function derivePoolAddress(config, baseMint, quoteMint) {
  const [a, b] = Buffer.compare(quoteMint.toBuffer(), baseMint.toBuffer()) > 0
    ? [quoteMint, baseMint]
    : [baseMint, quoteMint];
  return PublicKey.findProgramAddressSync(
    [seed('pool'), config.toBuffer(), a.toBuffer(), b.toBuffer()],
    DBC_PROGRAM_ID,
  )[0];
}

/** PDA["token_vault", mint, pool] — note the order: mint first, then pool. */
export function deriveTokenVault(pool, mint) {
  return PublicKey.findProgramAddressSync(
    [seed('token_vault'), mint.toBuffer(), pool.toBuffer()],
    DBC_PROGRAM_ID,
  )[0];
}

/** The associated token account, which depends on WHICH token program owns the mint. */
export function deriveAta(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

const pk = (buf, at) => new PublicKey(buf.subarray(at, at + 32));
const u64 = (buf, at) => buf.readBigUInt64LE(at);

/** True when this account blob is a DBC VirtualPool. */
export function isVirtualPool(data) {
  return data.length === VIRTUAL_POOL.SIZE
    && Buffer.from(VIRTUAL_POOL_DISCRIMINATOR).equals(data.subarray(0, 8));
}

/**
 * Read a VirtualPool account.
 *
 * Only the fields the snipe path needs. The pool carries its own config, base
 * vault and quote vault, which is what makes the no-config-known path possible:
 * the account that tells us the launch happened also tells us how to trade it.
 * It does NOT carry the quote mint — that lives on the config.
 */
export function decodeVirtualPool(data) {
  if (!isVirtualPool(data)) throw new Error('not a VirtualPool account');
  return {
    config: pk(data, VIRTUAL_POOL.CONFIG),
    creator: pk(data, VIRTUAL_POOL.CREATOR),
    baseMint: pk(data, VIRTUAL_POOL.BASE_MINT),
    baseVault: pk(data, VIRTUAL_POOL.BASE_VAULT),
    quoteVault: pk(data, VIRTUAL_POOL.QUOTE_VAULT),
    baseReserve: u64(data, VIRTUAL_POOL.BASE_RESERVE),
    quoteReserve: u64(data, VIRTUAL_POOL.QUOTE_RESERVE),
    activationPoint: u64(data, VIRTUAL_POOL.ACTIVATION_POINT),
  };
}

/** Read the fields of a PoolConfig that the swap needs. */
export function decodePoolConfig(data) {
  if (data.length !== POOL_CONFIG.SIZE) throw new Error(`PoolConfig is ${data.length}B, expected ${POOL_CONFIG.SIZE}`);
  return {
    quoteMint: pk(data, POOL_CONFIG.QUOTE_MINT),
    activationType: data[POOL_CONFIG.ACTIVATION_TYPE],
    tokenDecimal: data[POOL_CONFIG.TOKEN_DECIMAL],
    tokenType: data[POOL_CONFIG.TOKEN_TYPE],
    quoteTokenFlag: data[POOL_CONFIG.QUOTE_TOKEN_FLAG],
  };
}

/**
 * The swap instruction — `swap`, the one the IDL labels "TRADING BOTS FUNCTIONS".
 *
 * Account order is copied from the IDL and is load-bearing: Anchor matches
 * positionally, so a swapped pair does not error cleanly, it addresses the wrong
 * account. test-meteora.mjs asserts this list against an instruction Anchor
 * itself builds from the same IDL.
 *
 * `referralTokenAccount` is optional. Anchor's convention for an omitted optional
 * account is to pass the program id in its slot, which is what null does here.
 */
export function buildSwapInstruction({
  config, pool, inputTokenAccount, outputTokenAccount, baseVault, quoteVault,
  baseMint, quoteMint, payer, tokenBaseProgram, tokenQuoteProgram,
  referralTokenAccount = null, amountIn, minimumAmountOut,
}) {
  for (const [name, value] of Object.entries({
    config, pool, inputTokenAccount, outputTokenAccount, baseVault, quoteVault,
    baseMint, quoteMint, payer, tokenBaseProgram, tokenQuoteProgram,
  })) {
    if (!(value instanceof PublicKey)) throw new Error(`buildSwapInstruction: ${name} must be a PublicKey`);
  }
  if (typeof amountIn !== 'bigint' || typeof minimumAmountOut !== 'bigint') {
    throw new Error('buildSwapInstruction: amountIn and minimumAmountOut must be bigints');
  }
  if (amountIn <= 0n) throw new Error('buildSwapInstruction: amountIn must be positive');
  if (minimumAmountOut < 0n) throw new Error('buildSwapInstruction: minimumAmountOut cannot be negative');

  const data = Buffer.alloc(24);
  data.set(SWAP_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(minimumAmountOut, 16);

  const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });

  return {
    programId: DBC_PROGRAM_ID,
    keys: [
      ro(POOL_AUTHORITY),
      ro(config),
      rw(pool),
      rw(inputTokenAccount),
      rw(outputTokenAccount),
      rw(baseVault),
      rw(quoteVault),
      ro(baseMint),
      ro(quoteMint),
      // Signer, NOT writable: the IDL does not mark payer `mut`, because the swap
      // debits the quote token account, not the payer's lamports. It still ends up
      // writable in the compiled message, since it is also the fee payer — but
      // declaring it writable here would diverge from what the program expects.
      { pubkey: payer, isSigner: true, isWritable: false },
      ro(tokenBaseProgram),
      ro(tokenQuoteProgram),
      referralTokenAccount ? rw(referralTokenAccount) : ro(DBC_PROGRAM_ID),
      ro(deriveEventAuthority()),
      ro(DBC_PROGRAM_ID),
    ],
    data,
  };
}

/**
 * Create the buyer's token account for a mint that may not have existed a moment
 * ago — idempotent, so it is harmless if something else got there first.
 *
 * This has to be in the snipe transaction itself. The base mint is created by the
 * launch, so its account cannot be made in advance the way the quote side is.
 * Discriminator 1 is CreateIdempotent in the associated-token-account program.
 */
export function buildCreateAtaIdempotentInstruction({ payer, owner, mint, tokenProgram }) {
  const ata = deriveAta(owner, mint, tokenProgram);
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  };
}

/**
 * Everything the fire path needs, resolved into final addresses.
 *
 * Pure so that an arm can be fully checked — and printed for a human to read —
 * before any of it is signed.
 */
export function planSnipe({ config, baseMint, quoteMint, buyer, baseTokenType, quoteTokenType }) {
  const tokenBaseProgram = tokenProgramFor(baseTokenType);
  const tokenQuoteProgram = tokenProgramFor(quoteTokenType);
  const pool = derivePoolAddress(config, baseMint, quoteMint);
  return {
    config, baseMint, quoteMint, buyer, pool,
    tokenBaseProgram, tokenQuoteProgram,
    baseVault: deriveTokenVault(pool, baseMint),
    quoteVault: deriveTokenVault(pool, quoteMint),
    outputTokenAccount: deriveAta(buyer, baseMint, tokenBaseProgram),
    inputTokenAccount: deriveAta(buyer, quoteMint, tokenQuoteProgram),
  };
}
