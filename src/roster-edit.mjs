// Editing the watch list from a phone.
//
// Pure: every function here takes a roster and returns a new one. The file
// writing, the live re-subscription and the Telegram plumbing are elsewhere, so
// the rules about what a valid trader is can be tested without any of it.
//
// VALIDATION IS THE POINT. A mistyped address does not fail loudly — it produces
// a bot that watches an address nobody uses and reports nothing, which looks
// exactly like a trader who has not traded. The operator would find out days
// later, having believed they were covered. So an address is either decoded and
// proven to be the right shape for its chain, or it is refused with a reason.
//
// AND WHAT THAT STILL CANNOT CATCH, measured rather than assumed. An EVM address
// carries a checksum in its capitalisation, so a mistyped one is rejected here.
// A SOLANA ADDRESS CARRIES NONE: any 32 bytes is syntactically valid, so a typo
// that happens to still decode to 32 bytes is indistinguishable from a real
// address. Deleting the FIRST character of a 44-character address does exactly
// that and passes every check in this file.
//
// Shape is therefore a floor, not a guarantee, and the caller does not stop
// here: index.mjs asks the chain whether the address has ever been used and says
// so, which is what actually catches a typo somebody made on a phone.

import { decodeBase58, getAddress, isAddress } from 'ethers';

/**
 * Which chain does this address belong to?
 *
 * Decided by DECODING, not by pattern-matching a length. A Solana address is 32
 * bytes of base58 and an EVM one is 20 bytes of hex; anything that does not
 * decode to exactly that is not an address at all, whatever it looks like.
 */
export function classifyAddress(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;

  if (s.startsWith('0x') || s.startsWith('0X')) {
    if (!isAddress(s)) return null;
    // Through getAddress so a mistyped checksum is caught rather than lowercased
    // away. A single wrong character is exactly the failure this exists for.
    try { return { chain: 'evm', address: getAddress(s).toLowerCase() }; } catch { return null; }
  }

  try {
    // A Solana address is base58 of EXACTLY 32 bytes, and it has to be checked
    // as exactly that. A loose bound on the decoded size accepted this address
    // with a single character deleted — measured, not hypothetical — which is
    // the whole failure this function exists to stop: a typo that watches an
    // address nobody uses looks identical to a trader who has not traded.
    //
    // decodeBase58 returns a BigInt, so leading ZERO bytes are lost. base58
    // writes each of those as a leading '1', so they are counted back from the
    // string instead.
    const leadingZeroBytes = (s.match(/^1*/) ?? [''])[0].length;
    const n = decodeBase58(s);
    const bodyBytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
    if (leadingZeroBytes + bodyBytes !== 32) return null;
    return { chain: 'solana', address: s };
  } catch {
    return null;
  }
}

const HANDLE_RE = /^[A-Za-z0-9_.-]{1,32}$/;

/**
 * Turn `/add <handle> <address> [<address>]` into a roster entry.
 *
 * Both chains are optional individually but at least one is required: a trader
 * with no address is an entry that can never match anything, and accepting one
 * would put a name on the list that quietly watches nothing.
 */
export function parseAddTrader(args) {
  const [handle, ...rest] = args ?? [];
  if (!handle) return { ok: false, error: 'Usage: /add <handle> <address> [<address>]' };
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, error: `"${handle}" is not a usable handle — letters, digits, dot, dash and underscore only.` };
  }
  if (!rest.length) return { ok: false, error: `No address given. Usage: /add ${handle} <address> [<address>]` };

  const entry = { handle, enabled: true };
  for (const raw of rest) {
    const found = classifyAddress(raw);
    if (!found) return { ok: false, error: `"${raw}" is not a valid Solana or Robinhood Chain address.` };
    if (found.chain === 'evm') {
      if (entry.address) return { ok: false, error: 'Two Robinhood Chain addresses given; one per trader.' };
      entry.address = found.address;
    } else {
      if (entry.solana) return { ok: false, error: 'Two Solana addresses given; one per trader.' };
      entry.solana = found.address;
    }
  }
  return { ok: true, entry };
}

/** Case-insensitive, because a handle typed on a phone is not typed carefully. */
const sameHandle = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/**
 * Add a trader, or update one already there.
 *
 * An existing entry is MERGED rather than replaced: it may carry a sizeUsd, a
 * cooldown, or research notes that took real work to establish, and re-adding a
 * trader to correct one address should not silently discard the rest.
 */
export function applyAdd(roster, entry) {
  const list = Array.isArray(roster) ? roster : [];
  const at = list.findIndex((e) => sameHandle(e.handle, entry.handle));
  if (at < 0) return { roster: [...list, entry], added: true, previous: null };

  const previous = list[at];
  const merged = { ...previous, ...entry, enabled: true };
  const next = [...list];
  next[at] = merged;
  return { roster: next, added: false, previous };
}

/**
 * Stop watching a trader.
 *
 * Disables rather than deletes. The entry holds addresses that were researched
 * and notes explaining things like a 4337 account matching on calldata; throwing
 * that away because somebody typed /remove on a phone is not recoverable from
 * the phone. `/add` of the same handle switches it back on.
 */
export function applyRemove(roster, handle) {
  const list = Array.isArray(roster) ? roster : [];
  const at = list.findIndex((e) => sameHandle(e.handle, handle));
  if (at < 0) return { roster: list, found: false, entry: null };
  if (list[at].enabled === false) return { roster: list, found: true, alreadyOff: true, entry: list[at] };

  const next = [...list];
  next[at] = { ...list[at], enabled: false };
  return { roster: next, found: true, alreadyOff: false, entry: next[at] };
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : null);

/** The watch list as a Telegram message. */
export function formatRoster(roster) {
  const list = Array.isArray(roster) ? roster : [];
  if (!list.length) return 'Nobody is being watched. Add one with /add <handle> <address>';

  const on = list.filter((e) => e.enabled !== false);
  const off = list.filter((e) => e.enabled === false);
  const line = (e) => {
    const chains = [
      e.solana ? `SOL ${short(e.solana)}` : null,
      e.address ? `RH ${short(e.address)}` : null,
    ].filter(Boolean).join('  ');
    const size = typeof e.sizeUsd === 'number' ? `  $${e.sizeUsd}` : '';
    return `• <b>${e.handle}</b>${size}\n   ${chains || 'no address'}`;
  };

  const out = [`<b>Watching ${on.length}</b>`, '', ...on.map(line)];
  if (off.length) out.push('', `<i>Off (${off.length}): ${off.map((e) => e.handle).join(', ')}</i>`);
  return out.join('\n');
}
