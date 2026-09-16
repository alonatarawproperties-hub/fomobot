// The handful of non-Meteora instructions a snipe needs.
//
// Encodings verified rather than remembered. The ATA and close-account payloads
// below were read off a real mainnet transaction (`01` and `09` respectively, with
// the account orders shown); the rest are cross-checked against @solana/spl-token
// and @solana/web3.js in `test-sol-tx.mjs` via pinned bytes.

import { findProgramAddress } from './meteora-dbc.mjs';
import { decodeBase58 } from './base58.mjs';
import { ATA_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './meteora-dbc.mjs';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey) => ({ pubkey, isSigner: true, isWritable: true });

/**
 * A wallet's associated token account.
 *
 * THE TOKEN PROGRAM IS PART OF THE SEED, so the same owner and mint give a
 * different address under Token-2022 than under SPL Token. Meteora curve launches
 * are commonly Token-2022, and using the wrong one derives an account that does
 * not exist and never will.
 */
export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return findProgramAddress(
    [decodeBase58(owner), decodeBase58(tokenProgram), decodeBase58(mint)],
    ATA_PROGRAM,
  ).address;
}

/**
 * Create an ATA, tolerating it already existing.
 *
 * Idempotent matters more here than it looks: a sniper sends the same transaction
 * many times, and the plain `Create` variant fails outright the second time. That
 * failure would land AFTER a successful buy, so the retry that was meant to be
 * harmless would instead burn a fee and log an error that looks like the buy broke.
 */
export function createAtaIdempotent({ payer, ata, owner, mint, tokenProgram }) {
  return {
    programId: ATA_PROGRAM,
    keys: [signer(payer), rw(ata), ro(owner), ro(mint), ro(SYSTEM_PROGRAM), ro(tokenProgram)],
    data: Buffer.from([1]),
  };
}

/** Move native lamports. Used to fund the wSOL account before wrapping. */
export function systemTransfer({ from, to, lamports }) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // System instruction 2 = Transfer
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return { programId: SYSTEM_PROGRAM, keys: [signer(from), rw(to)], data };
}

/**
 * Make a wSOL account's token balance match the lamports sitting in it.
 *
 * Wrapping SOL is two steps and the second is easy to forget: transferring
 * lamports to the wSOL ATA does NOT change its token balance, so a swap that skips
 * this reads a zero balance and fails on an account that visibly holds the money.
 */
export const syncNative = (account) => ({
  programId: TOKEN_PROGRAM, keys: [rw(account)], data: Buffer.from([17]),
});

/** Close an account and return its rent (and any unwrapped lamports) to `destination`. */
export const closeAccount = ({ account, destination, owner }) => ({
  programId: TOKEN_PROGRAM,
  keys: [rw(account), rw(destination), { pubkey: owner, isSigner: true, isWritable: false }],
  data: Buffer.from([9]),
});

/**
 * Cap the transaction's compute. Worth setting explicitly: the default is 200k CU
 * per instruction, and the priority FEE is the unit price multiplied by this
 * LIMIT, so leaving it at a needlessly high default overpays for every attempt —
 * which for a bot sending the same transaction hundreds of times is the difference
 * between a rounding error and a real cost.
 */
export function setComputeUnitLimit(units) {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data };
}

/** The priority fee, in micro-lamports per compute unit. */
export function setComputeUnitPrice(microLamports) {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(BigInt(microLamports), 1);
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data };
}
