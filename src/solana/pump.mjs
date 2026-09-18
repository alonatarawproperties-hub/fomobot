// pump.fun bonding-curve primitives.
//
// EVERY constant, offset and account index in this file was verified against
// mainnet on 2026-09-18 rather than taken from documentation or memory. The
// probes and their output are recorded in the commit message. Where a value is
// readable from chain it is READ, not hardcoded — the one thing this file
// hardcodes is the shape of the data, never the numbers inside it.
//
// The single most important fact, and the one that most sniper code gets wrong:
//
//   pump.fun `buy` takes (amount: u64, max_sol_cost: u64) where `amount` is the
//   EXACT NUMBER OF TOKENS you receive and max_sol_cost caps the SOL. It is not
//   a minOut. Passing `1` here does not mean "accept any fill" — it means "buy
//   one raw token unit", i.e. 1e-6 of a token, and spend almost nothing.
//
// Verified on two independent mainnet buys: tokens received === arg0, exactly.

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

// ── Program IDs (all confirmed to exist and be executable on mainnet) ────────
export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// First 8 bytes of sha256("global:buy"). Confirmed as the discriminator on
// every pump buy instruction sampled from mainnet.
export const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

// ── Global account layout ───────────────────────────────────────────────────
// Mapped by locating four independently-known values as little-endian u64s and
// confirming they land at consecutive 8-byte offsets, which pins the struct:
//   73 initialVirtualTokenReserves  1_073_000_000_000_000
//   81 initialVirtualSolReserves       30_000_000_000
//   89 initialRealTokenReserves      793_100_000_000_000
//   97 tokenTotalSupply            1_000_000_000_000_000
//  105 feeBasisPoints                            95
// feeBasisPoints is 95, NOT the 100 that is widely copied around. Read it.
export const GLOBAL_OFFSET = {
  initialVirtualTokenReserves: 73,
  initialVirtualSolReserves: 81,
  initialRealTokenReserves: 89,
  tokenTotalSupply: 97,
  feeBasisPoints: 105,
  feeRecipients: 162,
};
const FEE_RECIPIENT_COUNT = 8;

// Buyback fee recipients are separate Anchor accounts owned by the fee program.
// 208 bytes, discriminator 99a64790b3bd89fb. Eight were found on mainnet.
export const BUYBACK_DISCRIMINATOR = Buffer.from('99a64790b3bd89fb', 'hex');
export const BUYBACK_ACCOUNT_SIZE = 208;

// ── Bonding curve layout ────────────────────────────────────────────────────
// Confirmed against live 151-byte curve accounts. Offsets are absolute.
const CURVE = {
  virtualTokenReserves: 8,
  virtualSolReserves: 16,
  realTokenReserves: 24,
  realSolReserves: 32,
  tokenTotalSupply: 40,
  complete: 48,
  creator: 49,
  isMayhem: 81,
  isCashback: 82,
};

/** Decode the pump.fun Global account. Every number comes off the chain. */
export function decodeGlobal(data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (data.length < GLOBAL_OFFSET.feeRecipients + FEE_RECIPIENT_COUNT * 32) {
    throw new Error(`pump Global account too short: ${data.length} bytes`);
  }
  const feeRecipients = [];
  for (let i = 0; i < FEE_RECIPIENT_COUNT; i++) {
    const at = GLOBAL_OFFSET.feeRecipients + i * 32;
    const pk = new PublicKey(data.subarray(at, at + 32));
    if (!pk.equals(PublicKey.default)) feeRecipients.push(pk);
  }
  if (feeRecipients.length === 0) throw new Error('pump Global carries no fee recipients');

  return {
    initialVirtualTokenReserves: data.readBigUInt64LE(GLOBAL_OFFSET.initialVirtualTokenReserves),
    initialVirtualSolReserves: data.readBigUInt64LE(GLOBAL_OFFSET.initialVirtualSolReserves),
    initialRealTokenReserves: data.readBigUInt64LE(GLOBAL_OFFSET.initialRealTokenReserves),
    tokenTotalSupply: data.readBigUInt64LE(GLOBAL_OFFSET.tokenTotalSupply),
    feeBasisPoints: data.readBigUInt64LE(GLOBAL_OFFSET.feeBasisPoints),
    feeRecipients,
  };
}

/** Decode a bonding curve account. Returns null for anything that is not one. */
export function decodeBondingCurve(data) {
  if (!data) return null;
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (data.length < CURVE.isCashback + 1) return null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(CURVE.virtualTokenReserves),
    virtualSolReserves: data.readBigUInt64LE(CURVE.virtualSolReserves),
    realTokenReserves: data.readBigUInt64LE(CURVE.realTokenReserves),
    realSolReserves: data.readBigUInt64LE(CURVE.realSolReserves),
    tokenTotalSupply: data.readBigUInt64LE(CURVE.tokenTotalSupply),
    complete: data[CURVE.complete] === 1,
    creator: new PublicKey(data.subarray(CURVE.creator, CURVE.creator + 32)),
    isMayhem: data[CURVE.isMayhem] === 1,
    isCashback: data[CURVE.isCashback] === 1,
  };
}

// ── PDAs ────────────────────────────────────────────────────────────────────
export function deriveBondingCurve(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM)[0];
}
export function deriveBondingCurveV2(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), mint.toBuffer()], PUMP_PROGRAM)[0];
}
export function deriveCreatorVault(creator) {
  return PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM)[0];
}
export function deriveGlobalVolumeAccumulator() {
  return PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM)[0];
}
export function deriveUserVolumeAccumulator(user) {
  return PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_PROGRAM)[0];
}
export function deriveFeeConfig() {
  return PublicKey.findProgramAddressSync([Buffer.from('fee_config'), PUMP_PROGRAM.toBuffer()], PUMP_FEE_PROGRAM)[0];
}

/**
 * Associated token address.
 *
 * Derived by hand rather than via @solana/spl-token: that package pulls in
 * bigint-buffer, which carries an unfixed high-severity buffer-overflow
 * advisory, for two constants and one single-byte instruction. The derivation
 * below was proved byte-identical to getAssociatedTokenAddressSync before the
 * dependency was dropped.
 */
export function deriveAta(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

/**
 * ATA CreateIdempotent. Instruction data is the single byte 0x01 over six
 * accounts in this order — captured from the library's own output, not recalled.
 * Idempotent matters here: a wallet that already holds the mint must not fail
 * the whole bundle on a duplicate-account error.
 */
export function createAtaIdempotentInstruction({ payer, owner, mint, tokenProgram = TOKEN_PROGRAM }) {
  const ata = deriveAta(owner, mint, tokenProgram);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

// ── Curve maths ─────────────────────────────────────────────────────────────

/** ceil(a / b) for positive BigInts. */
function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/**
 * Tokens received for `solIn` lamports entering the curve.
 *
 * The program holds the constant product k = vSol * vTok and rounds the NEW
 * token reserve UP, not the token output down. Those differ by one raw unit and
 * the difference is observable: with vSol=30e9, vTok=1.073e15 and solIn=1e9 the
 * chain produced 34_612_903_225_806, which ceil reproduces exactly and floor
 * misses by one. That fixture is asserted in test-sniper.mjs.
 *
 * `solIn` is what ENTERS THE CURVE. The pump fee is charged on top of it — see
 * solIntoCurveForBudget.
 */
export function tokensForSolIn(virtualSolReserves, virtualTokenReserves, solIn) {
  if (solIn <= 0n) return 0n;
  const k = virtualSolReserves * virtualTokenReserves;
  const newVirtualToken = ceilDiv(k, virtualSolReserves + solIn);
  const out = virtualTokenReserves - newVirtualToken;
  return out > 0n ? out : 0n;
}

/**
 * Split a total lamport budget into the part that enters the curve, given that
 * the fee is charged ON TOP of the curve input.
 *
 * Proven on mainnet: a buy with max_sol_cost 1.1 SOL moved the curve's virtual
 * SOL reserve by exactly 1.000000000 SOL. A fee deducted from the input could
 * not produce a round number there. Sizing this way means the wallet's TOTAL
 * outlay lands at or under `budget` under either fee convention — if the fee
 * were in fact deducted from the input we simply spend slightly less, never
 * more. max_sol_cost enforces that bound on-chain regardless.
 */
export function solIntoCurveForBudget(budgetLamports, feeBasisPoints) {
  if (budgetLamports <= 0n) return 0n;
  return (budgetLamports * 10000n) / (10000n + feeBasisPoints);
}

/** Apply a buy to a curve and return the resulting reserves. Pure. */
export function applyBuy(reserves, solIn, tokensOut) {
  return {
    ...reserves,
    virtualSolReserves: reserves.virtualSolReserves + solIn,
    virtualTokenReserves: reserves.virtualTokenReserves - tokensOut,
    realSolReserves: reserves.realSolReserves + solIn,
    realTokenReserves: reserves.realTokenReserves - tokensOut,
  };
}

/**
 * Plan a sequence of buys that will execute back-to-back in ONE Jito bundle.
 *
 * A bundle runs its transactions in order, atomically. Each buy therefore moves
 * the curve for the one behind it, and the last wallet pays the worst price.
 * Quoting every wallet against the pre-launch reserves would set the later
 * wallets' token amounts far too high; each would then need more SOL than its
 * cap, revert, and — because the bundle is all-or-nothing — take every other
 * wallet's fill down with it.
 *
 * So each leg is quoted against the reserves AS THEY WILL BE when it runs. That
 * is deterministic: the order is fixed and the amounts are known.
 *
 * `slippageBps` shaves the requested token amount. Asking for fewer tokens than
 * the curve would give is what creates headroom: if someone lands ahead of us
 * the price rises, our fixed token request costs more SOL, and the cap absorbs
 * the difference up to the shave. Beyond it the bundle reverts and nothing is
 * spent — a miss, not a loss.
 */
export function planLadder({ reserves, legs, feeBasisPoints, slippageBps }) {
  if (!Array.isArray(legs) || legs.length === 0) throw new Error('planLadder: no legs');
  if (slippageBps < 0n || slippageBps >= 10000n) throw new Error('planLadder: slippageBps out of range');

  let curve = reserves;
  const planned = [];

  for (const leg of legs) {
    const budget = leg.budgetLamports;
    if (budget <= 0n) throw new Error(`planLadder: leg ${leg.label} has a non-positive budget`);

    const solIn = solIntoCurveForBudget(budget, feeBasisPoints);
    const expectedTokens = tokensForSolIn(curve.virtualSolReserves, curve.virtualTokenReserves, solIn);
    if (expectedTokens <= 0n) throw new Error(`planLadder: leg ${leg.label} quotes to zero tokens`);

    // Request fewer tokens than quoted; the shave is our tolerance for the
    // curve having moved under us between planning and inclusion.
    const requestTokens = (expectedTokens * (10000n - slippageBps)) / 10000n;
    if (requestTokens <= 0n) throw new Error(`planLadder: leg ${leg.label} shaves to zero tokens`);

    planned.push({
      ...leg,
      solIntoCurve: solIn,
      expectedTokens,
      requestTokens,
      maxSolCost: budget,
      quotedAgainst: {
        virtualSolReserves: curve.virtualSolReserves,
        virtualTokenReserves: curve.virtualTokenReserves,
      },
    });

    // The next leg sees the curve this one leaves behind. Advance using the
    // FULL quoted amount, not the shaved request: the program moves the curve
    // by what it actually fills, and it fills the quote when nobody is ahead.
    curve = applyBuy(curve, solIn, expectedTokens);
  }

  return { legs: planned, finalReserves: curve };
}

/**
 * Build a pump.fun buy instruction.
 *
 * The 18-account list and its ordering are ported verbatim from a
 * known-working implementation and independently corroborated: every buy
 * decoded from mainnet carried exactly 18 accounts. Do not reorder these.
 * Accounts 14-17 (fee_config, fee_program, bonding_curve_v2, buyback recipient)
 * were added by a program upgrade; omitting them fails with a missing-account
 * error rather than anything that reads like a layout problem.
 */
export function buildBuyInstruction({
  mint, buyer, creator, amountTokens, maxSolCost,
  feeRecipient, buybackRecipient, tokenProgram = TOKEN_PROGRAM,
}) {
  if (amountTokens <= 0n) throw new Error('buildBuyInstruction: amountTokens must be positive');
  if (maxSolCost <= 0n) throw new Error('buildBuyInstruction: maxSolCost must be positive');

  const bondingCurve = deriveBondingCurve(mint);
  const data = Buffer.alloc(24);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amountTokens, 8);   // exact tokens out
  data.writeBigUInt64LE(maxSolCost, 16);    // hard cap on SOL

  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },                                  // 0
      { pubkey: feeRecipient, isSigner: false, isWritable: true },                                  // 1
      { pubkey: mint, isSigner: false, isWritable: false },                                         // 2
      { pubkey: bondingCurve, isSigner: false, isWritable: true },                                  // 3
      { pubkey: deriveAta(bondingCurve, mint, tokenProgram), isSigner: false, isWritable: true },   // 4
      { pubkey: deriveAta(buyer, mint, tokenProgram), isSigner: false, isWritable: true },          // 5
      { pubkey: buyer, isSigner: true, isWritable: true },                                          // 6
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },                      // 7
      { pubkey: tokenProgram, isSigner: false, isWritable: false },                                 // 8
      { pubkey: deriveCreatorVault(creator), isSigner: false, isWritable: true },                   // 9
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },                         // 10
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },                                 // 11
      { pubkey: deriveGlobalVolumeAccumulator(), isSigner: false, isWritable: false },              // 12
      { pubkey: deriveUserVolumeAccumulator(buyer), isSigner: false, isWritable: true },            // 13
      { pubkey: deriveFeeConfig(), isSigner: false, isWritable: false },                            // 14
      { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },                             // 15
      { pubkey: deriveBondingCurveV2(mint), isSigner: false, isWritable: false },                   // 16
      { pubkey: buybackRecipient, isSigner: false, isWritable: true },                              // 17
    ],
    data,
  });
}

/**
 * Which token program owns a mint.
 *
 * NOT a detail, and NOT safely assumable. Sampling 18 mints the pump program had
 * just touched on 2026-09-18 found SIXTEEN owned by Token-2022 and two by the
 * classic Token program. Guessing the classic one — which is what most pump.fun
 * sniper code does, and what this file did in its first version — derives the
 * wrong associated token address and passes the wrong program account, so the
 * buy fails outright. The tip is spent, the bundle lands nothing.
 *
 * Anything that is neither token program is refused rather than guessed at.
 */
export function tokenProgramForMintAccount(accountInfo) {
  const owner = accountInfo?.owner;
  if (!owner) throw new Error('mint account not readable');
  if (owner.equals(TOKEN_PROGRAM)) return TOKEN_PROGRAM;
  if (owner.equals(TOKEN_2022_PROGRAM)) return TOKEN_2022_PROGRAM;
  throw new Error(`mint is owned by ${owner.toBase58()}, which is not a token program`);
}
