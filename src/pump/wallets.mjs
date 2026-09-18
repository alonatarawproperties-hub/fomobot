// Sniper wallet loading.
//
// Five keys have to be on the box for the bundle to sign itself, so this file
// exists to make the blast radius of that fact as small as it can be:
//
//   * keys come from the environment and NOWHERE else. A key found in
//     config.json is a startup failure, not a warning — config.json is the one
//     file this design exists to keep them out of, and it is gitignored on the
//     assumption that it never holds one.
//   * every key is checked against the public address the operator wrote in the
//     config. A mistyped address does not throw on its own: it would plan
//     against one wallet and sign with another, quietly, forever.
//   * the loaded secret is never logged, never stringified into an error, and
//     never returned from anything that an alert path can reach.
//
// This mirrors the rule the EVM side already enforces for FIRSTFILL_PRIVATE_KEY.

import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const KEY_ENV_PREFIX = 'FIRSTFILL_SNIPER_KEY_';

/** Jito accepts at most five transactions in one bundle. */
export const MAX_BUNDLE_TRANSACTIONS = 5;

/**
 * Decode one base58 secret key into a Keypair.
 *
 * Accepts the 64-byte secret-key form that every Solana wallet exports. A
 * 32-byte seed is refused rather than expanded: both are plausible pastes, they
 * produce DIFFERENT addresses, and guessing which one was meant is exactly the
 * class of silent mistake this module exists to prevent.
 */
export function keypairFromBase58(secret, label) {
  let bytes;
  try {
    bytes = bs58.decode(secret.trim());
  } catch {
    throw new Error(`${label}: not valid base58`);
  }
  if (bytes.length !== 64) {
    throw new Error(
      `${label}: expected a 64-byte secret key, got ${bytes.length} bytes` +
      (bytes.length === 32 ? ' — that looks like a 32-byte seed, export the full secret key instead' : ''),
    );
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch (err) {
    throw new Error(`${label}: not a usable ed25519 secret key`);
  }
}

/**
 * Load the keypair for each configured wallet.
 *
 * `wallets` is the config array, in bundle order. Index N reads
 * FIRSTFILL_SNIPER_KEY_<N+1>, so the env names line up with what an operator
 * sees in the config file rather than with a zero-based array.
 */
export function loadSniperWallets(wallets, env = process.env) {
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error('sniper: no wallets configured');
  }
  if (wallets.length > MAX_BUNDLE_TRANSACTIONS) {
    throw new Error(
      `sniper: ${wallets.length} wallets configured but a Jito bundle holds at most ` +
      `${MAX_BUNDLE_TRANSACTIONS} transactions — every buy would have to be split across ` +
      'bundles and would stop being atomic',
    );
  }

  const loaded = [];
  const seen = new Set();

  wallets.forEach((w, i) => {
    const label = `${KEY_ENV_PREFIX}${i + 1}`;

    if (w.privateKey || w.secretKey || w.key) {
      throw new Error(
        `sniper: wallet ${i + 1} carries a key in the config file. Keys are read from ` +
        `${label} and nowhere else — remove it from config.json and rotate it, it must be ` +
        'treated as compromised the moment it was written to disk.',
      );
    }
    if (!w.address) throw new Error(`sniper: wallet ${i + 1} has no address`);

    const secret = env[label];
    if (!secret) throw new Error(`sniper: ${label} is not set (wallet ${i + 1}, ${w.address})`);

    const kp = keypairFromBase58(secret, label);
    const actual = kp.publicKey.toBase58();

    let expected;
    try {
      expected = new PublicKey(w.address).toBase58();
    } catch {
      throw new Error(`sniper: wallet ${i + 1} address is not a valid public key: ${w.address}`);
    }

    if (actual !== expected) {
      throw new Error(
        `sniper: ${label} belongs to ${actual} but wallet ${i + 1} is configured as ${expected}. ` +
        'Refusing to start: the plan would be computed for one wallet and signed by another.',
      );
    }
    if (seen.has(actual)) {
      throw new Error(
        `sniper: ${actual} appears more than once. Five buys from one wallet is the single ` +
        'on-chain footprint the split exists to avoid, and the later legs would be quoted ' +
        'against a balance the earlier ones already spent.',
      );
    }
    seen.add(actual);

    const budgetLamports = solStringToLamports(w.sol, `sniper: wallet ${i + 1} (${actual}) "sol"`);
    loaded.push({ index: i, label, keypair: kp, address: actual, budgetLamports, config: w });
  });

  return loaded;
}

/**
 * Parse a wallet's SOL budget into lamports.
 *
 * Config carries SOL as a decimal string, never a JS number: 0.1 + 0.2 is not
 * 0.3 in binary floating point, and a lamport count is an integer that must not
 * be reconstructed through a float.
 */
export function solStringToLamports(value, label) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`${label}: expected a positive decimal SOL amount, got "${value}"`);
  }
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 9) throw new Error(`${label}: more than 9 decimal places (${value}) — SOL has 9`);
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt((frac + '000000000').slice(0, 9));
  if (lamports <= 0n) throw new Error(`${label}: must be greater than zero`);
  return lamports;
}

/**
 * Check the split adds up to what the operator thinks they are risking.
 *
 * The buy budgets are not the whole outlay. Every wallet pays rent for the token
 * account it is about to open, and because all five buys ride in ONE transaction
 * the fee payer alone carries every signature and the whole priority fee.
 *
 * A split that sums to exactly the total leaves nothing for any of that, and the
 * shortfall does not surface as a warning — the underfunded buy fails, and one
 * failing instruction reverts the entire transaction, so every other fill goes
 * with it.
 *
 * Deliberately NOT enforced: that the amounts differ from one another. An uneven
 * split is the operator's intent, not an invariant, and a bot that refused five
 * equal amounts would be inventing a rule nobody asked for. What IS reported is
 * whether they are distinguishable, so the choice stays visible.
 */
export function auditSplit({
  wallets, totalLamports, ataRentLamports, signatureFeeLamports, priorityFeeLamports = 0n,
}) {
  const buyTotal = wallets.reduce((sum, w) => sum + w.budgetLamports, 0n);
  const signatures = signatureFeeLamports * BigInt(wallets.length);
  const overhead = BigInt(wallets.length) * ataRentLamports + signatures + priorityFeeLamports;
  const required = buyTotal + overhead;

  const amounts = wallets.map((w) => w.budgetLamports);
  const distinct = new Set(amounts.map((a) => a.toString())).size;

  return {
    buyTotal,
    overhead,
    required,
    totalLamports,
    withinBudget: required <= totalLamports,
    excess: required > totalLamports ? required - totalLamports : 0n,
    headroom: required <= totalLamports ? totalLamports - required : 0n,
    distinctAmounts: distinct,
    allAmountsIdentical: distinct === 1,
  };
}
