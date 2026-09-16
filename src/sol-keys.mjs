// Holding a Solana signing key, and nothing else.
//
// Node's ed25519 is used directly rather than a library. It is correct: seeding it
// with RFC 8032's test vector reproduces both that vector's public key and its
// signature byte-for-byte, which `test-sol-tx.mjs` asserts.
//
// THE KEY IS READ FROM THE ENVIRONMENT ONLY, exactly as on the EVM side, and for
// the same reason — see the README. A key in config.json is a startup failure, not
// a warning, and `config.json` is gitignored.

import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { decodeBase58, encodeBase58 } from './base58.mjs';

// DER wrappers that turn a raw 32-byte seed into something node's crypto accepts.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * @param {string} secret  either base58 of the 64-byte Solana secret key (what a
 *   wallet exports) or the 64-number JSON array `solana-keygen` writes. A bare
 *   32-byte seed is also accepted.
 */
export function keypairFromSecret(secret) {
  let bytes;
  const trimmed = String(secret).trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error('key: JSON is not an array');
    bytes = Buffer.from(arr);
  } else {
    bytes = decodeBase58(trimmed);
  }

  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(`key: expected 32 or 64 bytes, got ${bytes.length}`);
  }
  const seed = bytes.subarray(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);

  // A 64-byte Solana key carries its own public half. If the two disagree the key
  // is corrupt or truncated, and signing anyway would produce valid signatures for
  // an address nobody is watching — the same failure the EVM side guards against
  // by comparing the derived address to executor.wallet.
  if (bytes.length === 64 && Buffer.compare(bytes.subarray(32), publicKey) !== 0) {
    throw new Error('key: the public half does not match the seed — key is corrupt or truncated');
  }

  return {
    address: encodeBase58(publicKey),
    publicKey,
    /** @param {Buffer} message @returns {Buffer} 64-byte signature */
    sign: (message) => edSign(null, message, privateKey),
  };
}

/**
 * Load the sniper's key from the environment.
 *
 * Separate variable from the EVM key on purpose: one compromised box should not
 * mean one variable that unlocks both chains, and a single name would make it far
 * too easy to paste a Solana key where an EVM key is read and get a confusing
 * failure instead of an obvious one.
 */
export function keypairFromEnv(env = process.env, varName = 'FIRSTFILL_SOLANA_KEY') {
  const raw = env[varName];
  if (!raw) throw new Error(`${varName} is not set`);
  return keypairFromSecret(raw);
}
