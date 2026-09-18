// Address lookup table for the single-transaction snipe.
//
// WHY THIS EXISTS. Five pump.fun buys will not fit in one transaction: each buy
// names 18 accounts, and by the fourth the message is 1432 bytes against
// Solana's 1232-byte hard limit — the fifth will not even compile. Measured, not
// estimated. A lookup table replaces each 32-byte account key in the message
// with a one-byte index into a table stored on chain, which brings all five buys
// plus their token-account creates down to about a kilobyte.
//
// That is what makes the whole thing atomic WITHOUT a block engine. One
// transaction either applies completely or not at all, enforced by the runtime
// itself rather than by a third party that can decline to forward it.
//
// WHAT CAN AND CANNOT GO IN THE TABLE. Everything here is derivable from the
// mint, which the operator supplies before the launch — so the table is built
// and warm long before it is needed, and nothing about it costs time in the fire
// path. The exception is the CREATOR VAULT: it is a PDA of the token's creator,
// and the creator is not knowable until the bonding curve account exists. It
// therefore stays a static 32-byte key in the message, which the size budget has
// room for.
//
// A table is usable one slot after it is extended, so it cannot be created at
// fire time. That is the reason /target builds it and /arm does not.

import {
  AddressLookupTableProgram, PublicKey, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  PUMP_PROGRAM, PUMP_GLOBAL, PUMP_EVENT_AUTHORITY, PUMP_FEE_PROGRAM,
  TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM,
  deriveBondingCurve, deriveBondingCurveV2, deriveAta,
  deriveGlobalVolumeAccumulator, deriveUserVolumeAccumulator, deriveFeeConfig,
} from './pump.mjs';
import { SystemProgram } from '@solana/web3.js';

/** A table holds 256 addresses; we use a fraction of that. */
export const MAX_LOOKUP_ADDRESSES = 256;

/**
 * Every address the snipe will reference that is knowable before the launch.
 *
 * Both token programs are covered, and so are BOTH variants of every account
 * whose address depends on which token program owns the mint — the associated
 * bonding curve and all five buyer token accounts. The mint does not exist yet
 * when this is built, so which program will own it is not yet knowable, and
 * guessing would put the wrong addresses in the table. Including both costs
 * eleven extra entries out of 256 and removes the question.
 *
 * Deliberately NOT included: the creator vault. It is a PDA of the creator,
 * which only exists once the curve does.
 */
export function lookupAddressesFor({ mint, wallets, feeRecipients, buybackRecipients }) {
  const bondingCurve = deriveBondingCurve(mint);
  const addresses = [
    // Fixed program and protocol accounts.
    PUMP_PROGRAM, PUMP_GLOBAL, PUMP_EVENT_AUTHORITY, PUMP_FEE_PROGRAM,
    SystemProgram.programId, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM,
    // Derivable from the mint alone.
    mint, bondingCurve, deriveBondingCurveV2(mint),
    deriveGlobalVolumeAccumulator(), deriveFeeConfig(),
    // Token-program-dependent, so both variants.
    deriveAta(bondingCurve, mint, TOKEN_PROGRAM),
    deriveAta(bondingCurve, mint, TOKEN_2022_PROGRAM),
  ];

  for (const w of wallets) {
    const owner = new PublicKey(w.address);
    addresses.push(deriveUserVolumeAccumulator(owner));
    addresses.push(deriveAta(owner, mint, TOKEN_PROGRAM));
    addresses.push(deriveAta(owner, mint, TOKEN_2022_PROGRAM));
  }

  // The fee recipient and buyback recipient are chosen at random per snipe, so
  // every candidate has to be in the table or the choice could fall outside it.
  for (const r of feeRecipients) addresses.push(r);
  for (const r of buybackRecipients) addresses.push(r);

  // Wallet public keys are signers and must stay static in the message, so they
  // are pointedly absent. Dedupe: a repeated address wastes an entry and the
  // fee/buyback sets can overlap.
  const seen = new Set();
  const unique = [];
  for (const a of addresses) {
    const k = a.toBase58();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(a);
  }
  if (unique.length > MAX_LOOKUP_ADDRESSES) {
    throw new Error(`lookup table would need ${unique.length} addresses, the limit is ${MAX_LOOKUP_ADDRESSES}`);
  }
  return unique;
}

/**
 * Create a table and fill it, returning its address once it is usable.
 *
 * Extending is chunked because the extend instruction itself is a transaction
 * and 30 addresses is about what fits. The wait afterwards is not optional: a
 * table's new entries are only visible to transactions in a LATER slot than the
 * one that added them, and a message compiled against entries that are not yet
 * visible fails to resolve rather than falling back to the full keys.
 */
export async function createLookupTable({ connection, payer, addresses, log = () => {} }) {
  const slot = await connection.getSlot('finalized');
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });

  const send = async (instructions, label) => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    const msg = new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash, instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    log(`${label}: ${sig}`);
    return sig;
  };

  await send([createIx], 'lookup table created');

  const CHUNK = 30;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    await send([AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey, authority: payer.publicKey,
      lookupTable: tableAddress, addresses: chunk,
    })], `extended with ${chunk.length} addresses`);
  }

  await waitForLookupTable({ connection, tableAddress, expected: addresses.length, log });
  return tableAddress;
}

/**
 * Block until the table resolves with every address visible.
 *
 * Polling the account is not enough on its own — the addresses can be present in
 * the account data while still being too new for a transaction to use. Requiring
 * the slot to advance past the last extension is what makes it safe to compile
 * against.
 */
export async function waitForLookupTable({ connection, tableAddress, expected, timeoutMs = 60_000, log = () => {} }) {
  const startedAt = Date.now();
  let lastCount = -1;
  while (Date.now() - startedAt < timeoutMs) {
    const res = await connection.getAddressLookupTable(tableAddress, { commitment: 'confirmed' });
    const table = res?.value;
    const count = table?.state?.addresses?.length ?? 0;
    if (count !== lastCount) { log(`lookup table holds ${count}/${expected} addresses`); lastCount = count; }
    if (table && count >= expected) {
      const slot = await connection.getSlot('confirmed');
      if (slot > (table.state.lastExtendedSlot ?? 0)) return table;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`lookup table ${tableAddress.toBase58()} did not become usable within ${timeoutMs}ms`);
}

/** Recover the rent from a table that is no longer needed. Two steps, by design. */
export function closeLookupTableInstructions({ authority, lookupTable }) {
  return {
    deactivate: AddressLookupTableProgram.deactivateLookupTable({ authority, lookupTable }),
    // Only valid once the deactivation has cooled down (~512 slots), which is
    // the protocol protecting transactions still referencing the table.
    close: AddressLookupTableProgram.closeLookupTable({ authority, lookupTable, recipient: authority }),
  };
}
