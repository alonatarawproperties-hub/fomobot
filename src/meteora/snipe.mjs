// Assembling the snipe transaction, and the gate it has to pass first.
//
// Pure: takes addresses and numbers, returns instructions and bytes. No RPC, no
// clock, no key material beyond the one signature at the end. That is what lets
// the whole transaction be asserted offline — and, more importantly, pre-signed
// and held ready, so that firing is a socket write rather than a build.

import { PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildSwapInstruction, buildCreateAtaIdempotentInstruction, decodeVirtualPool, deriveTokenVault } from './dbc.mjs';

export const REFUSE = Object.freeze({
  MINT_MISMATCH: 'pool-is-for-another-mint',
  CONFIG_MISMATCH: 'pool-config-is-not-the-armed-config',
  POOL_MISMATCH: 'pool-address-is-not-the-derived-one',
  BASE_VAULT_MISMATCH: 'pool-reports-a-different-base-vault',
  QUOTE_VAULT_MISMATCH: 'pool-reports-a-different-quote-vault',
});

/**
 * Check a live pool account against the plan we armed, before spending anything.
 *
 * THE HOLE THIS CLOSES. A pre-armed snipe fires at accounts derived minutes or
 * hours earlier from a config the operator typed in. If any of that was wrong —
 * wrong config, wrong quote mint, a mint that launched against a different pair —
 * the derived pool address is simply some other account, and the swap would be
 * pointed at a pool that has nothing to do with the token we meant to buy. Every
 * field below is one the pool states about itself, compared against what we
 * assumed. Mismatch is a refusal, never a reconciliation: silently retargeting at
 * whatever the pool says would defeat the point of arming in advance.
 *
 * @returns {{ok: true, pool: object} | {ok: false, reason: string, detail: object}}
 */
export function verifyPool({ poolAddress, data, plan }) {
  let pool;
  try {
    pool = decodeVirtualPool(data);
  } catch (e) {
    return { ok: false, reason: 'not-a-virtual-pool', detail: { message: e.message } };
  }

  const eq = (a, b) => a.toBase58() === b.toBase58();

  if (!eq(pool.baseMint, plan.baseMint)) {
    return { ok: false, reason: REFUSE.MINT_MISMATCH, detail: { expected: plan.baseMint.toBase58(), actual: pool.baseMint.toBase58() } };
  }
  if (!eq(new PublicKey(poolAddress), plan.pool)) {
    return { ok: false, reason: REFUSE.POOL_MISMATCH, detail: { expected: plan.pool.toBase58(), actual: String(poolAddress) } };
  }
  if (!eq(pool.config, plan.config)) {
    return { ok: false, reason: REFUSE.CONFIG_MISMATCH, detail: { expected: plan.config.toBase58(), actual: pool.config.toBase58() } };
  }
  // The vaults are PDAs of the pool, so these cannot disagree while the rest
  // agrees — unless Meteora changed a seed. Checked anyway: the cost is two
  // comparisons, and the failure it catches is us funding the wrong account.
  if (!eq(pool.baseVault, plan.baseVault)) {
    return { ok: false, reason: REFUSE.BASE_VAULT_MISMATCH, detail: { expected: plan.baseVault.toBase58(), actual: pool.baseVault.toBase58() } };
  }
  if (!eq(pool.quoteVault, plan.quoteVault)) {
    return { ok: false, reason: REFUSE.QUOTE_VAULT_MISMATCH, detail: { expected: plan.quoteVault.toBase58(), actual: pool.quoteVault.toBase58() } };
  }
  return { ok: true, pool };
}

/**
 * The instructions of the snipe, in the order they are sent.
 *
 * The ATA creation cannot be done in advance the way the quote side can: the base
 * mint does not exist until the launch creates it, so its token account has to be
 * made in the same transaction that buys. Idempotent, so it costs nothing but a
 * little compute if something else created it first.
 */
export function snipeInstructions({ plan, amountIn, minimumAmountOut, computeUnitLimit, computeUnitPriceMicroLamports }) {
  if (!Number.isInteger(computeUnitLimit) || computeUnitLimit <= 0) {
    throw new Error('snipeInstructions: computeUnitLimit must be a positive integer');
  }
  if (!Number.isInteger(computeUnitPriceMicroLamports) || computeUnitPriceMicroLamports < 0) {
    throw new Error('snipeInstructions: computeUnitPriceMicroLamports must be a non-negative integer');
  }
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports }),
    buildCreateAtaIdempotentInstruction({
      payer: plan.buyer, owner: plan.buyer, mint: plan.baseMint, tokenProgram: plan.tokenBaseProgram,
    }),
    buildSwapInstruction({
      config: plan.config,
      pool: plan.pool,
      inputTokenAccount: plan.inputTokenAccount,
      outputTokenAccount: plan.outputTokenAccount,
      baseVault: plan.baseVault,
      quoteVault: plan.quoteVault,
      baseMint: plan.baseMint,
      quoteMint: plan.quoteMint,
      payer: plan.buyer,
      tokenBaseProgram: plan.tokenBaseProgram,
      tokenQuoteProgram: plan.tokenQuoteProgram,
      amountIn,
      minimumAmountOut,
    }),
  ];
}

/**
 * Compile and sign. Returns the bytes to put on the wire, and the signature they
 * will land under — which is known before sending, and is how the fill is watched.
 *
 * Signing here rather than at fire time is the whole trick: a pre-signed
 * transaction turns firing into a socket write. It is re-signed whenever the
 * blockhash rolls, which is a background tick, not the hot path.
 */
export function signSnipe({ instructions, payer, blockhash, keypair }) {
  if (!blockhash) throw new Error('signSnipe: no blockhash');
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);

  const raw = tx.serialize();
  return {
    base64: Buffer.from(raw).toString('base64'),
    // base58, because that is what every explorer and getSignatureStatuses speak.
    signature: bs58.encode(tx.signatures[0]),
    bytes: raw.length,
  };
}

/**
 * Re-derive the vaults from a pool address we did NOT derive ourselves.
 *
 * Used only on the discovery path, where the pool arrived from a subscription
 * rather than from a config we armed with. Kept separate from planSnipe so that
 * the pre-armed path can never quietly fall back to trusting a pool it was not
 * told about.
 */
export function planFromLivePool({ poolAddress, poolData, buyer, quoteMint, tokenBaseProgram, tokenQuoteProgram, deriveAta }) {
  // Named, because the alternative is "Cannot read properties of null" arriving
  // mid-race with no indication of which of five addresses was missing.
  for (const [name, value] of Object.entries({ buyer, quoteMint, tokenBaseProgram, tokenQuoteProgram })) {
    if (!(value instanceof PublicKey)) throw new Error(`planFromLivePool: ${name} is not a PublicKey (got ${value})`);
  }
  const pool = decodeVirtualPool(poolData);
  const poolKey = new PublicKey(poolAddress);
  const baseVault = deriveTokenVault(poolKey, pool.baseMint);
  const quoteVault = deriveTokenVault(poolKey, quoteMint);
  if (baseVault.toBase58() !== pool.baseVault.toBase58()) {
    throw new Error(`live pool reports base vault ${pool.baseVault.toBase58()}, derived ${baseVault.toBase58()}`);
  }
  // A quote vault that does not match means the pool's quote mint is NOT the one
  // configured — the single most likely way a discovery-path snipe buys the right
  // token with the wrong currency, or fails on-chain having paid the fee.
  if (quoteVault.toBase58() !== pool.quoteVault.toBase58()) {
    throw new Error(`live pool quote vault ${pool.quoteVault.toBase58()} does not match one derived from quote mint ${quoteMint.toBase58()} — wrong quote mint configured`);
  }
  return {
    config: pool.config,
    baseMint: pool.baseMint,
    quoteMint,
    buyer,
    pool: poolKey,
    baseVault,
    quoteVault,
    tokenBaseProgram,
    tokenQuoteProgram,
    outputTokenAccount: deriveAta(buyer, pool.baseMint, tokenBaseProgram),
    inputTokenAccount: deriveAta(buyer, quoteMint, tokenQuoteProgram),
  };
}
