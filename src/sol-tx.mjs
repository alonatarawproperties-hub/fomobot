// Building and signing a legacy Solana transaction, by hand.
//
// Hand-rolled for the same reason base58 and the PDA derivation are: the only
// alternative is a multi-megabyte dependency for a few hundred bytes of
// serialisation, in a project whose whole point is a short, auditable path between
// a signal and a signature. `test-sol-tx.mjs` pins the output against bytes
// produced by @solana/web3.js for the same inputs, so "hand-rolled" does not mean
// "unverified".
//
// Legacy, not v0/address-lookup-tables. A snipe touches ~15 accounts and fits
// comfortably in a legacy message; lookup tables exist to fit more accounts in,
// and they would add a dependency on a table account existing at fire time —
// which is exactly the kind of extra precondition a launch is too fast to check.
//
// WHAT THE ORDERING RULES ARE, because getting them wrong produces a transaction
// that serialises cleanly and is then rejected, or worse, silently marks an
// account read-only that the program needs to write:
//
//   1. the fee payer is account 0, and is always signer + writable
//   2. accounts sort into four groups, in this order:
//        writable signers, readonly signers, writable non-signers, readonly non-signers
//   3. the header counts them: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
//   4. an account appearing twice is merged, taking the STRONGER of each flag —
//      a program listed read-only in one instruction and writable in another must
//      end up writable, or that instruction fails

import { decodeBase58, encodeBase58 } from './base58.mjs';

/** Solana's compact-u16 (aka short vec) length prefix. */
export function encodeCompactU16(n) {
  if (n < 0 || n > 0xffff) throw new Error(`compact-u16 out of range: ${n}`);
  const out = [];
  let v = n;
  for (;;) {
    if (v < 0x80) { out.push(v); break; }
    out.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return Buffer.from(out);
}

/**
 * @typedef {{pubkey: string, isSigner: boolean, isWritable: boolean}} AccountMeta
 * @typedef {{programId: string, keys: AccountMeta[], data: Buffer}} Instruction
 */

/**
 * Turn instructions into the account list and header a message needs.
 * Exported separately because it is the part with all the rules in it, and it is
 * worth being able to test without a blockhash or a key.
 */
export function compileAccounts(feePayer, instructions) {
  /** @type {Map<string, {isSigner:boolean,isWritable:boolean}>} */
  const merged = new Map();
  const note = (pubkey, isSigner, isWritable) => {
    const prev = merged.get(pubkey);
    if (prev) { prev.isSigner ||= isSigner; prev.isWritable ||= isWritable; }
    else merged.set(pubkey, { isSigner, isWritable });
  };

  note(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) note(k.pubkey, k.isSigner, k.isWritable);
    // A program is invoked, never written or signed — but it must be present.
    note(ix.programId, false, false);
  }

  const rank = (m) => (m.isSigner && m.isWritable ? 0 : m.isSigner ? 1 : m.isWritable ? 2 : 3);

  // Ties are broken with @solana/web3.js's exact comparator, quirks included: a
  // LOCALE-aware compare with caseFirst 'lower', which puts 'dbcij…' before
  // 'So11…' where a byte compare would do the opposite.
  //
  // The runtime does not care — it reads the header counts and the positions, and
  // any order within a group executes identically. Matching web3.js anyway buys
  // something worth more than tidiness: the serialised bytes are then IDENTICAL to
  // what every other tool in the ecosystem produces for the same instructions, so
  // `test-sol-tx.mjs` can pin them against that reference rather than against
  // this file's own opinion. An earlier version sorted by raw bytes; it was
  // equally valid and impossible to check against anything.
  const tieBreak = (x, y) => x.localeCompare(y, 'en', {
    localeMatcher: 'best fit', usage: 'sort', sensitivity: 'variant',
    ignorePunctuation: false, numeric: false, caseFirst: 'lower',
  });

  const keys = [...merged.entries()]
    .sort((a, b) => {
      if (a[0] === feePayer) return -1;           // fee payer is always first
      if (b[0] === feePayer) return 1;
      const d = rank(a[1]) - rank(b[1]);
      return d !== 0 ? d : tieBreak(a[0], b[0]);
    })
    .map(([pubkey, m]) => ({ pubkey, ...m }));

  const numRequiredSignatures = keys.filter((k) => k.isSigner).length;
  const numReadonlySigned = keys.filter((k) => k.isSigner && !k.isWritable).length;
  const numReadonlyUnsigned = keys.filter((k) => !k.isSigner && !k.isWritable).length;
  return { keys, header: { numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned } };
}

/**
 * Serialise a legacy message. This is the exact byte string that gets signed.
 *
 * @param {object} p
 * @param {string} p.feePayer
 * @param {string} p.recentBlockhash
 * @param {Instruction[]} p.instructions
 */
export function compileMessage({ feePayer, recentBlockhash, instructions }) {
  const { keys, header } = compileAccounts(feePayer, instructions);
  const index = new Map(keys.map((k, i) => [k.pubkey, i]));

  const parts = [
    Buffer.from([header.numRequiredSignatures, header.numReadonlySigned, header.numReadonlyUnsigned]),
    encodeCompactU16(keys.length),
    ...keys.map((k) => decodeBase58(k.pubkey)),
    decodeBase58(recentBlockhash),
    encodeCompactU16(instructions.length),
  ];

  for (const ix of instructions) {
    const programIdIndex = index.get(ix.programId);
    if (programIdIndex === undefined) throw new Error(`instruction program not in account list: ${ix.programId}`);
    const accountIndices = ix.keys.map((k) => {
      const at = index.get(k.pubkey);
      if (at === undefined) throw new Error(`instruction account not in account list: ${k.pubkey}`);
      return at;
    });
    parts.push(
      Buffer.from([programIdIndex]),
      encodeCompactU16(accountIndices.length),
      Buffer.from(accountIndices),
      encodeCompactU16(ix.data.length),
      Buffer.from(ix.data),
    );
  }

  return { message: Buffer.concat(parts), keys, header, signerCount: header.numRequiredSignatures };
}

/**
 * Sign a compiled message and produce the wire transaction.
 *
 * Only the fee payer signs anything this project sends, so a message needing more
 * than one signature is a construction bug rather than something to paper over
 * with an empty signature slot the RPC will reject later.
 */
export function signTransaction({ message, signerCount }, keypair) {
  if (signerCount !== 1) {
    throw new Error(`expected exactly 1 required signature, got ${signerCount}`);
  }
  const signature = keypair.sign(message);
  return Buffer.concat([encodeCompactU16(1), signature, message]);
}

/** Convenience: compile, sign, and base64-encode for `sendTransaction`. */
export function buildAndSign({ feePayer, recentBlockhash, instructions }, keypair) {
  const compiled = compileMessage({ feePayer, recentBlockhash, instructions });
  const wire = signTransaction(compiled, keypair);
  return { wire, base64: wire.toString('base64'), signature: encodeBase58(wire.subarray(1, 65)), compiled };
}

/**
 * Re-sign a message whose blockhash has been swapped in place.
 *
 * This is the point of the whole module for a sniper. A blockhash is only valid
 * for ~150 slots (~60s), so a transaction cannot be signed far in advance — but
 * everything EXCEPT the blockhash can be. `blockhashOffset` locates those 32 bytes
 * inside the already-serialised message so a new attempt costs one memcpy and one
 * signature instead of a rebuild.
 */
export function blockhashOffset({ keys }) {
  // 3 header bytes + compact-u16 account count + 32 bytes per account.
  return 3 + encodeCompactU16(keys.length).length + keys.length * 32;
}

/** Swap the blockhash inside a compiled message and re-sign. Mutates `message`. */
export function resignWithBlockhash(compiled, blockhash, keypair) {
  const at = blockhashOffset(compiled);
  const bh = decodeBase58(blockhash);
  if (bh.length !== 32) throw new Error('blockhash must be 32 bytes');
  bh.copy(compiled.message, at);
  const wire = signTransaction(compiled, keypair);
  return { wire, base64: wire.toString('base64'), signature: encodeBase58(wire.subarray(1, 65)) };
}
