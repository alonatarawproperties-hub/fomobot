// The blind snipe: a transaction built before the pool exists, sent until it does.
//
// This is the only shape that reaches the creation slot. The measurement in the
// README is unambiguous — three buys landed inside one launch's creation slot, and
// a listener cannot even learn the pool exists until that slot is already
// processed. So there is nothing to react to. The transaction has to be in flight
// already.
//
// ──────────────────────────────────────────────────────────────────────────────
// THE PROPERTY THE WHOLE DESIGN HANGS ON: ONE FILL, NOT HUNDREDS
// ──────────────────────────────────────────────────────────────────────────────
// Sending a buy hundreds of times raises an obvious way to lose everything: the
// pool appears and they ALL succeed. Solana has no per-sender nonce to stop that —
// it dedupes by SIGNATURE, and nothing else.
//
// Which is exactly the lever. A signature covers the blockhash, so as long as the
// blockhash does not change, every attempt is the SAME transaction with the SAME
// signature, and the network will execute at most one of them however many are
// sent. The spam is therefore free of duplicate-fill risk by construction rather
// than by a check that might lose a race.
//
// So this module signs ONCE PER BLOCKHASH and re-sends that identical payload. It
// does not sign per attempt. A blockhash lasts ~150 slots (~60s), so a refresh is
// needed roughly once a minute, and each refresh opens a NEW signature that could
// also fill — which is the one remaining window. `shouldRefresh` therefore refuses
// to re-sign until the caller has confirmed we are not already filled, and the
// fire loop checks the balance before every refresh. Stated plainly because it is
// the difference between one position and sixty.
//
// ──────────────────────────────────────────────────────────────────────────────
// WHAT IS STILL NOT KNOWN AT BUILD TIME
// ──────────────────────────────────────────────────────────────────────────────
// Whether the base mint is SPL Token or Token-2022. The mint does not exist yet,
// so it cannot be asked, and it changes both the ATA address and an account in the
// swap — a plan built for the wrong one is dead on arrival. Meteora curve launches
// are commonly Token-2022, but "commonly" is not a basis for a single attempt, so
// `buildSnipePlan` returns a plan PER token program and the caller sends both. The
// wrong one fails cheaply and the right one fills.

import {
  DBC_PROGRAM, WSOL, TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
  deriveLaunch, encodeSwap2Data, buildBuyAccounts,
} from './meteora-dbc.mjs';
import {
  associatedTokenAddress, createAtaIdempotent, systemTransfer, syncNative,
  closeAccount, setComputeUnitLimit, setComputeUnitPrice,
} from './sol-programs.mjs';
import { compileMessage } from './sol-tx.mjs';

/** A blockhash is good for 150 slots; refresh well inside that, not at the edge. */
export const BLOCKHASH_REFRESH_MS = 40_000;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Rent for a token account, so the cost estimate is not quietly wrong. */
const TOKEN_ACCOUNT_RENT = 2_039_280n;
const BASE_FEE_LAMPORTS = 5_000n;

/**
 * Build one sendable plan.
 *
 * @param {object} p
 * @param {string} p.config         the launch's Meteora config — see the README on
 *                                  why this cannot be derived and must be obtained
 * @param {string} p.baseMint       the token address, known in advance
 * @param {string} p.payer          our wallet
 * @param {bigint} p.amountInLamports  what we spend
 * @param {bigint} p.minTokensOut   floor, in the token's smallest unit. REQUIRED —
 *                                  see the note below on why 0 is not a default.
 * @param {string} [p.baseTokenProgram] SPL Token or Token-2022
 * @param {string} [p.quoteMint]    wSOL unless the config says otherwise
 * @param {number} [p.computeUnitLimit]
 * @param {number} [p.priorityFeeMicroLamports]
 * @param {boolean} [p.closeWsol]   reclaim the wSOL account's rent afterwards
 */
export function buildSnipePlan({
  config, baseMint, payer, amountInLamports, minTokensOut,
  baseTokenProgram = TOKEN_2022_PROGRAM, quoteMint = WSOL,
  computeUnitLimit = 120_000, priorityFeeMicroLamports = 0, closeWsol = true,
}) {
  if (!config) throw new Error('snipe: config is required — the pool address cannot be derived without it');
  if (!baseMint || !payer) throw new Error('snipe: baseMint and payer are required');
  if (typeof amountInLamports !== 'bigint' || amountInLamports <= 0n) {
    throw new Error('snipe: amountInLamports must be a positive bigint');
  }
  // A missing floor is not the same as a floor of zero, and defaulting one to the
  // other is how a bot ends up accepting one token for a whole wallet. The caller
  // has to say 0n out loud if that is really what it wants.
  if (typeof minTokensOut !== 'bigint' || minTokensOut < 0n) {
    throw new Error('snipe: minTokensOut must be a bigint (pass 0n explicitly to accept any price)');
  }
  if (quoteMint !== WSOL) {
    // Everything below wraps native SOL. A USDC-quoted launch needs a different
    // funding path, and silently building a wSOL transaction for it would produce
    // a plan that fails at the pool with a confusing error.
    throw new Error(`snipe: only wSOL-quoted launches are supported; config quotes ${quoteMint}`);
  }

  const launch = deriveLaunch(config, baseMint, quoteMint);
  const payerBaseAccount = associatedTokenAddress(payer, baseMint, baseTokenProgram);
  const payerQuoteAccount = associatedTokenAddress(payer, quoteMint, TOKEN_PROGRAM);

  const instructions = [
    setComputeUnitLimit(computeUnitLimit),
    ...(priorityFeeMicroLamports > 0 ? [setComputeUnitPrice(priorityFeeMicroLamports)] : []),
    // Wrap: create, fund, sync. The sync is not optional — see sol-programs.mjs.
    createAtaIdempotent({ payer, ata: payerQuoteAccount, owner: payer, mint: quoteMint, tokenProgram: TOKEN_PROGRAM }),
    systemTransfer({ from: payer, to: payerQuoteAccount, lamports: amountInLamports }),
    syncNative(payerQuoteAccount),
    createAtaIdempotent({ payer, ata: payerBaseAccount, owner: payer, mint: baseMint, tokenProgram: baseTokenProgram }),
    {
      programId: DBC_PROGRAM,
      keys: buildBuyAccounts({
        poolAuthority: launch.poolAuthority, config, pool: launch.pool,
        baseVault: launch.baseVault, quoteVault: launch.quoteVault,
        baseMint, quoteMint, payer,
        tokenBaseProgram: baseTokenProgram, tokenQuoteProgram: TOKEN_PROGRAM,
        eventAuthority: launch.eventAuthority,
        payerBaseAccount, payerQuoteAccount,
      }),
      data: encodeSwap2Data(amountInLamports, minTokensOut),
    },
    ...(closeWsol ? [closeAccount({ account: payerQuoteAccount, destination: payer, owner: payer })] : []),
  ];

  return {
    ...launch,
    payer, baseTokenProgram, payerBaseAccount, payerQuoteAccount,
    amountInLamports, minTokensOut, computeUnitLimit, priorityFeeMicroLamports,
    instructions,
    /** Compile against a placeholder so the byte layout exists before we have a blockhash. */
    compile: (recentBlockhash) => compileMessage({ feePayer: payer, recentBlockhash, instructions }),
  };
}

/**
 * Both plans for a launch whose token program is not yet knowable.
 * Send both; the wrong one costs one failed transaction's fees.
 */
export function buildSnipePlans(args) {
  return [TOKEN_2022_PROGRAM, TOKEN_PROGRAM].map((baseTokenProgram) => ({
    baseTokenProgram,
    label: baseTokenProgram === TOKEN_2022_PROGRAM ? 'token-2022' : 'spl-token',
    plan: buildSnipePlan({ ...args, baseTokenProgram }),
  }));
}

/**
 * What blind sending actually costs.
 *
 * A transaction that fails because the pool does not exist yet is still INCLUDED,
 * and an included transaction pays its base fee and its priority fee. So the spam
 * has a real price, it scales with the priority fee that makes the spam worth
 * sending, and an operator should see the number before arming rather than after.
 */
export function estimateCost({ attempts, computeUnitLimit, priorityFeeMicroLamports, variants = 1 }) {
  const perAttemptPriority = (BigInt(computeUnitLimit) * BigInt(priorityFeeMicroLamports)) / 1_000_000n;
  const perAttempt = BASE_FEE_LAMPORTS + perAttemptPriority;
  const total = perAttempt * BigInt(attempts) * BigInt(variants);
  return {
    perAttemptLamports: perAttempt,
    totalLamports: total,
    totalSol: Number(total) / Number(LAMPORTS_PER_SOL),
    // Reclaimed when the wSOL account is closed, but it has to be AVAILABLE first.
    rentHeadroomLamports: TOKEN_ACCOUNT_RENT * 2n,
  };
}

/**
 * Is it safe to sign a new generation?
 *
 * Refusing while a fill is unconfirmed is the guard on the one window where the
 * signature-dedupe argument does not hold: a new blockhash means a new signature,
 * which could fill a second time. `filled` must come from a real balance read, not
 * from whether a send appeared to succeed — a send that times out may still land.
 */
export function shouldRefresh({ now, signedAt, filled, deadline }) {
  if (filled) return { refresh: false, reason: 'already-filled' };
  if (deadline && now >= deadline) return { refresh: false, reason: 'deadline-passed' };
  if (signedAt === null) return { refresh: true, reason: 'first-signature' };
  if (now - signedAt >= BLOCKHASH_REFRESH_MS) return { refresh: true, reason: 'blockhash-stale' };
  return { refresh: false, reason: 'current-signature-still-good' };
}

/** Should we keep sending? Pure, so the loop's stopping rules are testable. */
export function shouldKeepFiring({ now, filled, deadline, attempts, maxAttempts }) {
  if (filled) return { fire: false, reason: 'filled' };
  if (deadline && now >= deadline) return { fire: false, reason: 'deadline' };
  if (maxAttempts && attempts >= maxAttempts) return { fire: false, reason: 'max-attempts' };
  return { fire: true, reason: null };
}
