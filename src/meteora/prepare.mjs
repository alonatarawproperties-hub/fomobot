// Getting the money in place BEFORE the launch.
//
// The snipe pays out of an SPL token account, so that account has to exist and
// hold the buy size already. For a SOL-quoted curve that means wrapped SOL, and
// wrapping is three instructions and a rent-exempt deposit — all of it work that
// must not happen while a launch is being raced. So it happens here, whenever the
// operator gets round to it, and arm() refuses to start if it did not.
//
// Pure builders, verified against @solana/spl-token in test-meteora.mjs.

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { deriveAta, buildCreateAtaIdempotentInstruction, TOKEN_PROGRAM, WSOL_MINT } from './dbc.mjs';

/**
 * SyncNative — instruction 17 in the SPL token program, no arguments.
 *
 * Wrapping SOL is: put lamports in the token account, then tell the token program
 * to notice. Without this second step the account's reported balance stays at
 * whatever it was and the swap reads it as unfunded.
 */
export function buildSyncNativeInstruction(tokenAccount, tokenProgram = TOKEN_PROGRAM) {
  return {
    programId: tokenProgram,
    keys: [{ pubkey: tokenAccount, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  };
}

/**
 * Create and fund the wrapped-SOL account the snipe will spend from.
 *
 * `lamports` is the buy size. The account also needs rent exemption on top, which
 * the caller passes in — it is a live cluster value, not a constant, and guessing
 * it produces an account that exists but cannot be used.
 */
export function wrapSolInstructions({ owner, lamports, rentExemptLamports }) {
  if (typeof lamports !== 'bigint' || lamports <= 0n) throw new Error('wrapSolInstructions: lamports must be a positive bigint');
  if (typeof rentExemptLamports !== 'bigint' || rentExemptLamports < 0n) throw new Error('wrapSolInstructions: rentExemptLamports must be a non-negative bigint');
  const ata = deriveAta(owner, WSOL_MINT, TOKEN_PROGRAM);
  return {
    ata,
    instructions: [
      buildCreateAtaIdempotentInstruction({ payer: owner, owner, mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM }),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: lamports + rentExemptLamports }),
      buildSyncNativeInstruction(ata, TOKEN_PROGRAM),
    ],
  };
}

/**
 * Top up an already-wrapped account: no rent to add, just lamports and a sync.
 * Separated because paying rent twice silently overfunds by ~0.002 SOL each time.
 */
export function topUpWrappedSolInstructions({ owner, lamports }) {
  if (typeof lamports !== 'bigint' || lamports <= 0n) throw new Error('topUpWrappedSolInstructions: lamports must be a positive bigint');
  const ata = deriveAta(owner, WSOL_MINT, TOKEN_PROGRAM);
  return {
    ata,
    instructions: [
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
      buildSyncNativeInstruction(ata, TOKEN_PROGRAM),
    ],
  };
}

/** True when this mint is the one the system can wrap into. */
export const isWrappedSol = (mint) => new PublicKey(mint).toBase58() === WSOL_MINT.toBase58();
