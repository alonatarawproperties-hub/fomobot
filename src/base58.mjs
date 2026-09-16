// Base58 (Bitcoin alphabet), because every Solana address and signature is one
// and the rest of this project deliberately has no Solana dependency.
//
// `src/solana.mjs` gets away with treating addresses as opaque strings — it only
// ever passes them back to the RPC. Anything that reads an account's BYTES has to
// turn 32 raw bytes into an address and back, so that lives here rather than being
// re-implemented at each call site.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** @param {Uint8Array|Buffer} bytes */
export function encodeBase58(bytes) {
  const b = Uint8Array.from(bytes);
  // Leading zero bytes carry no value through the big-number conversion below, so
  // they are counted here and re-emitted as '1's afterwards.
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;

  // Starts EMPTY, not [0]: a placeholder zero digit would survive an all-zero
  // input and emit one character too many. `11111111111111111111111111111111`
  // (the system program) is exactly that case, and it decoded to 33 bytes.
  const digits = [];
  for (let i = zeros; i < b.length; i++) {
    let carry = b[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}

/**
 * @param {string} str
 * @returns {Buffer}
 * @throws on any character outside the alphabet — a silent 0 for a mistyped
 *   character would decode a wrong address that still looks like an address.
 */
export function decodeBase58(str) {
  if (typeof str !== 'string' || str.length === 0) throw new Error('base58: empty');
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  const bytes = []; // empty for the same reason as in encodeBase58
  for (let i = zeros; i < str.length; i++) {
    const v = INDEX.get(str[i]);
    if (v === undefined) throw new Error(`base58: bad character ${JSON.stringify(str[i])} at ${i}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes.reverse())]);
}

/** A 32-byte address, or null. Shape only — see the README on what that cannot catch. */
export function isAddress(str) {
  try { return decodeBase58(str).length === 32; } catch { return false; }
}
