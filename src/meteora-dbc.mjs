// Meteora Dynamic Bonding Curve (DBC) — the launch venue, read off the chain.
//
// EVERY CONSTANT AND OFFSET BELOW WAS VERIFIED AGAINST MAINNET, not taken from a
// doc or an SDK. `npm run test-dbc` re-derives the PDAs and re-checks the
// discriminators against the values observed in a real swap, so a wrong constant
// fails a test rather than a trade. What was measured, 2026-09-16:
//
//   program        dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN  (executable)
//   swap ix        `Swap2`, discriminator 414b3f4ceb5b5b88, which equals
//                  sha256("global:swap2")[0..8] — two independent confirmations
//   pool account   424 bytes, disc d5e005d16245775c = sha256("account:VirtualPool")
//   config account 1048 bytes, disc 1a6c0e7b74e6812b = sha256("account:PoolConfig")
//
// THE LAUNCH IS ONE ATOMIC TRANSACTION. `InitializeVirtualPoolWithToken2022`
// creates the mint, the vaults, the metadata, mints the whole supply, revokes mint
// and freeze authority, and creates the pool — all in one tx. So the token does
// not exist before the launch, and it is tradeable the instant it does. There is
// no window between "exists" and "tradeable" to detect and act in.
//
// WHAT THAT COSTS A REACTIVE BOT, measured on a real launch (mint
// 9SgwHTxL4pNwfKoTWuG7yMNV3z4ptJCkAgt3HwnXw8qT, created slot 447445706):
//
//   +0 slots   three separate buys, in the creation slot itself
//   +1 slot    a fourth
//   +42 slots  (~17s) the next wave, and everything after
//
// Those first three cannot have reacted to the creation: a `logsSubscribe`
// notification arrives only after the slot is processed. They were already
// sending, at a pool address they had derived before it existed. A bot that waits
// to be told lands in the +42 wave. This module therefore exposes derivation
// (`derivePool`) separately from discovery (`findPoolByMint`), because the first
// is what makes a same-slot entry possible and the second is only a fallback.
//
// THE CURVE IS NOT THE ONLY VENUE. A DBC pool has a finite life, verified on the
// reference launch below: once the curve completes, `MigrationDammV2` moves both
// reserves into a Meteora DAMM v2 (cp-amm) pool and locks the position. After that
// the DBC vaults hold dust and `Swap2` is the wrong program to call. So A POSITION
// HELD THROUGH MIGRATION MUST BE SOLD SOMEWHERE ELSE, and any exit path that only
// knows about the curve silently stops working at the moment the token succeeds.
// `DAMM_V2_*` below is the minimum needed to detect that this has happened.
//
// THE CONFIG IS THE ONE THING THAT CANNOT BE GUESSED. The pool address is a PDA
// over (config, baseMint, quoteMint). The mint may be known in advance, but the
// config is chosen by whoever launches — 504,063 of them exist on mainnet. They
// are long-lived and shared (the one sampled was created ~1.3 days before the pool
// that used it, and 27 pools share it), so a config CAN be known ahead of a
// launch — but only by being told, or by recognising the launchpad from its
// earlier pools. Without it there is no same-slot entry, and this module says so
// rather than pretending otherwise.

import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58 } from './base58.mjs';

export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Meteora DAMM v2 (cp-amm) — where a completed curve migrates to. Verified from
 * the migration transaction of the reference launch: its pool account is 1112
 * bytes with discriminator f19a6d0411b16dbc, which equals
 * sha256("account:Pool")[0..8]. The two mints sit at 168 and 200, and WHICH ONE
 * HOLDS THE BASE MINT DEPENDS ON THEIR SORT ORDER — so both offsets have to be
 * checked, and `dammV2PoolFilters` returns one filter set per offset rather than
 * guessing.
 */
export const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const DAMM_V2_POOL_SIZE = 1112;
export const DAMM_V2_POOL_DISCRIMINATOR = Buffer.from('f19a6d0411b16dbc', 'hex');
export const DAMM_V2_MINT_OFFSETS = [168, 200];

/** Anchor discriminators. Both of these were also read off a real transaction. */
export const SWAP2_DISCRIMINATOR = Buffer.from('414b3f4ceb5b5b88', 'hex');
export const VIRTUAL_POOL_DISCRIMINATOR = Buffer.from('d5e005d16245775c', 'hex');
export const POOL_CONFIG_DISCRIMINATOR = Buffer.from('1a6c0e7b74e6812b', 'hex');

export const VIRTUAL_POOL_SIZE = 424;
export const POOL_CONFIG_SIZE = 1048;

/**
 * Byte offsets inside the 424-byte VirtualPool account, found by searching a real
 * pool's data for pubkeys already known from its swap transaction.
 *
 * `baseMint` at 136 is the one that matters most: it is the memcmp filter that
 * finds a pool from nothing but the token address, and the filter a
 * `programSubscribe` uses to be PUSHED the pool the instant it is created.
 */
export const POOL_OFFSET = { config: 72, creator: 104, baseMint: 136, baseVault: 168, quoteVault: 200 };

/** The quote mint lives in the config, not the pool — the config predates the mint. */
export const CONFIG_OFFSET = { quoteMint: 8 };

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();

// ---------------------------------------------------------------------------
// ed25519 curve check, needed for PDA derivation
// ---------------------------------------------------------------------------
// A program-derived address is sha256(seeds || programId || bump || marker) that
// is NOT a valid ed25519 point — that is precisely what makes it unsignable. So
// deriving one means being able to reject candidates that ARE points, which needs
// real curve arithmetic. 40 lines of BigInt beats a 2MB dependency for this, and
// `test-dbc.mjs` proves it right by re-deriving five addresses whose correct
// values were read off mainnet.

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

const mod = (a) => ((a % P) + P) % P;
function powMod(base, exp) {
  let r = 1n, b = mod(base), e = exp;
  while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; }
  return r;
}

/**
 * Is this 32-byte little-endian value a point on ed25519?
 *
 * Decompress y and try to recover x from x² = (y²−1)/(dy²+1). If that has no
 * square root, the bytes are not a point — which is the case a PDA needs.
 */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n; // drop the sign bit; it selects x, not validity

  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  if (v === 0n) return false;

  // x² = u/v = u * v^(p−2)
  const x2 = mod(u * powMod(v, P - 2n));
  if (x2 === 0n) return true; // x = 0 is a legitimate point

  // A square root exists iff x2^((p−1)/2) == 1.
  return powMod(x2, (P - 1n) / 2n) === 1n;
}

const PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'utf8');

/**
 * findProgramAddress. Walks bump 255 down to 0 and returns the first candidate
 * that is off the curve, exactly as the runtime does.
 *
 * @param {Array<Buffer|Uint8Array|string>} seeds  strings are taken as utf8 seeds
 * @param {string} programId  base58
 * @returns {{address: string, bump: number}}
 */
export function findProgramAddress(seeds, programId) {
  const parts = seeds.map((s) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s)));
  for (const s of parts) if (s.length > 32) throw new Error('pda: seed longer than 32 bytes');
  const pid = decodeBase58(programId);

  // THE BUMP IS A SEED, so it goes BEFORE the program id, not after it. Getting
  // that backwards yields a stable, plausible-looking address for every input —
  // it just is not the account. Every derivation in this file was wrong in
  // exactly that way until the tests compared them against mainnet.
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(...parts, Buffer.from([bump]), pid, PDA_MARKER);
    if (!isOnCurve(candidate)) return { address: encodeBase58(candidate), bump };
  }
  // 1-in-2^256 territory; a throw is correct because a caller cannot continue.
  throw new Error('pda: no off-curve bump found');
}

// ---------------------------------------------------------------------------
// The addresses a swap needs
// ---------------------------------------------------------------------------

/** Constant for the whole program — it owns every pool's vaults. */
export const poolAuthority = () => findProgramAddress(['pool_authority'], DBC_PROGRAM).address;
/** Anchor's CPI event authority. */
export const eventAuthority = () => findProgramAddress(['__event_authority'], DBC_PROGRAM).address;

/**
 * The pool address, derivable BEFORE the pool exists.
 *
 * The two mints are sorted descending, NOT passed in role order. That was
 * established rather than assumed: across 54,371 pools whose base mint sorts
 * below wSOL — the only pools where the two orderings differ — 47,749 matched the
 * sorted order and ZERO matched (baseMint, quoteMint). The remaining 6,622 are
 * pools quoted in something other than wSOL, so they correctly match neither.
 * Getting this backwards yields a real-looking address that is simply not the
 * pool, and for ~98% of mints the bug is invisible because the orders coincide.
 */
export function derivePool(config, baseMint, quoteMint = WSOL) {
  const a = decodeBase58(baseMint);
  const b = decodeBase58(quoteMint);
  const [hi, lo] = Buffer.compare(a, b) > 0 ? [a, b] : [b, a];
  return findProgramAddress(['pool', decodeBase58(config), hi, lo], DBC_PROGRAM).address;
}

/** A pool's vault for one of its mints. */
export function deriveVault(mint, pool) {
  return findProgramAddress(['token_vault', decodeBase58(mint), decodeBase58(pool)], DBC_PROGRAM).address;
}

/** Everything derivable from (config, mint) in one call, for pre-building. */
export function deriveLaunch(config, baseMint, quoteMint = WSOL) {
  const pool = derivePool(config, baseMint, quoteMint);
  return {
    pool,
    config,
    baseMint,
    quoteMint,
    baseVault: deriveVault(baseMint, pool),
    quoteVault: deriveVault(quoteMint, pool),
    poolAuthority: poolAuthority(),
    eventAuthority: eventAuthority(),
  };
}

// ---------------------------------------------------------------------------
// Reading accounts
// ---------------------------------------------------------------------------

/** @param {Buffer} raw the 424-byte account */
export function decodeVirtualPool(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== VIRTUAL_POOL_SIZE) {
    throw new Error(`virtual pool: expected ${VIRTUAL_POOL_SIZE} bytes, got ${raw?.length}`);
  }
  if (!raw.subarray(0, 8).equals(VIRTUAL_POOL_DISCRIMINATOR)) {
    throw new Error('virtual pool: wrong discriminator');
  }
  const at = (o) => encodeBase58(raw.subarray(o, o + 32));
  return {
    config: at(POOL_OFFSET.config),
    creator: at(POOL_OFFSET.creator),
    baseMint: at(POOL_OFFSET.baseMint),
    baseVault: at(POOL_OFFSET.baseVault),
    quoteVault: at(POOL_OFFSET.quoteVault),
  };
}

/** @param {Buffer} raw the 1048-byte account */
export function decodePoolConfig(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== POOL_CONFIG_SIZE) {
    throw new Error(`pool config: expected ${POOL_CONFIG_SIZE} bytes, got ${raw?.length}`);
  }
  if (!raw.subarray(0, 8).equals(POOL_CONFIG_DISCRIMINATOR)) {
    throw new Error('pool config: wrong discriminator');
  }
  return { quoteMint: encodeBase58(raw.subarray(CONFIG_OFFSET.quoteMint, CONFIG_OFFSET.quoteMint + 32)) };
}

/**
 * Filter sets that find a migrated pool on DAMM v2 by its token. One per possible
 * mint offset, because the pair is stored sorted — a caller runs both and takes
 * whichever returns something.
 */
export const dammV2PoolFilters = (mint) => DAMM_V2_MINT_OFFSETS.map((offset) => [
  { dataSize: DAMM_V2_POOL_SIZE },
  { memcmp: { offset, bytes: mint } },
]);

/** The memcmp filters that find a pool by its token, for getProgramAccounts or programSubscribe. */
export const poolByMintFilters = (baseMint) => [
  { dataSize: VIRTUAL_POOL_SIZE },
  { memcmp: { offset: POOL_OFFSET.baseMint, bytes: baseMint } },
];

// ---------------------------------------------------------------------------
// Building the swap
// ---------------------------------------------------------------------------

/**
 * `Swap2` instruction data: discriminator, amountIn, minimumAmountOut, and one
 * trailing byte. The trailing byte was 0x00 on the live swap decoded — an
 * ExactIn-style mode selector. It is exposed rather than hardcoded so that a
 * future need for another mode does not require re-reading this file's history,
 * but 0 is the only value observed and the only one this project has tested.
 */
export function encodeSwap2Data(amountIn, minimumAmountOut, mode = 0) {
  const buf = Buffer.alloc(8 + 8 + 8 + 1);
  SWAP2_DISCRIMINATOR.copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(amountIn), 8);
  buf.writeBigUInt64LE(BigInt(minimumAmountOut), 16);
  buf.writeUInt8(mode, 24);
  return buf;
}

/**
 * The 15 accounts `Swap2` takes, in the order read off a live transaction.
 *
 * `inputTokenAccount` / `outputTokenAccount` are the caller's own token accounts
 * and they swap places between a buy and a sell — the program does not infer the
 * direction from anything else, so passing them the wrong way round sells what you
 * meant to buy. `buildBuyAccounts` and `buildSellAccounts` exist so no call site
 * has to remember which way round it goes.
 *
 * Slot 12 is an optional referral token account; Anchor's convention for "none" is
 * the program's own id, which is what the live transaction carried.
 */
export function buildSwap2Accounts({
  poolAuthority: auth, config, pool, inputTokenAccount, outputTokenAccount,
  baseVault, quoteVault, baseMint, quoteMint, payer,
  tokenBaseProgram, tokenQuoteProgram, referralTokenAccount = DBC_PROGRAM, eventAuthority: evt,
}) {
  return [
    { pubkey: auth, isSigner: false, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: baseVault, isSigner: false, isWritable: true },
    { pubkey: quoteVault, isSigner: false, isWritable: true },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tokenBaseProgram, isSigner: false, isWritable: false },
    { pubkey: tokenQuoteProgram, isSigner: false, isWritable: false },
    { pubkey: referralTokenAccount, isSigner: false, isWritable: false },
    { pubkey: evt, isSigner: false, isWritable: false },
    { pubkey: DBC_PROGRAM, isSigner: false, isWritable: false },
  ];
}

/** Quote in, base out. */
export const buildBuyAccounts = (a) => buildSwap2Accounts({
  ...a, inputTokenAccount: a.payerQuoteAccount, outputTokenAccount: a.payerBaseAccount,
});

/** Base in, quote out. */
export const buildSellAccounts = (a) => buildSwap2Accounts({
  ...a, inputTokenAccount: a.payerBaseAccount, outputTokenAccount: a.payerQuoteAccount,
});
