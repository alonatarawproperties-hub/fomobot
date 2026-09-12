// Nitro sequencer-feed decoding.
//
// Frame shape, confirmed against wss://feed.mainnet.chain.robinhood.com on 2026-09-12:
//
//   { version: 1, messages: [ { sequenceNumber, message: { message: {
//       header: { kind, sender, blockNumber, timestamp, requestId, baseFeeL1 },
//       l2Msg: "<base64>" } } } ] }
//
// l2Msg decodes to:
//   byte[0] = 3 (Batch)    -> repeated { uint64be length, submessage }
//   byte[0] = 4 (SignedTx) -> the rest is one signed tx envelope
// Each batch submessage is itself kind-prefixed; kind 4 carries the signed tx.
//
// Everything else (deposits, L1 messages, internal ArbOS kinds) is skipped: this
// module only cares about user transactions.

import { Transaction } from 'ethers';

export const L2_KIND_BATCH = 3;
export const L2_KIND_SIGNED_TX = 4;

/** Pull raw signed-tx envelopes out of one base64 l2Msg. Never throws. */
export function extractSignedTxs(l2MsgB64) {
  let buf;
  try {
    buf = Buffer.from(l2MsgB64, 'base64');
  } catch {
    return [];
  }
  if (buf.length < 2) return [];

  if (buf[0] === L2_KIND_SIGNED_TX) return [buf.subarray(1)];
  if (buf[0] !== L2_KIND_BATCH) return [];

  const out = [];
  let off = 1;
  // A malformed length must abort the batch, not spin: every branch advances or breaks.
  while (off + 8 <= buf.length) {
    const len = Number(buf.readBigUInt64BE(off));
    off += 8;
    if (!Number.isSafeInteger(len) || len <= 0 || off + len > buf.length) break;
    const sub = buf.subarray(off, off + len);
    off += len;
    if (sub.length > 1 && sub[0] === L2_KIND_SIGNED_TX) out.push(sub.subarray(1));
  }
  return out;
}

/**
 * Decode one frame into normalised transactions.
 * `from` is recovered from the signature by ethers — the feed does not carry it.
 */
export function decodeFrame(frame, seenAt = Date.now()) {
  const txs = [];
  const seqs = [];

  for (const m of frame?.messages ?? []) {
    const inner = m?.message?.message;
    const l2 = inner?.l2Msg;
    if (typeof m?.sequenceNumber === 'number') seqs.push(m.sequenceNumber);
    if (!l2) continue;

    for (const raw of extractSignedTxs(l2)) {
      let tx;
      try {
        tx = Transaction.from('0x' + raw.toString('hex'));
      } catch {
        continue; // unparseable envelope — count it upstream, never crash the loop
      }
      let from = null;
      try { from = tx.from?.toLowerCase() ?? null; } catch { /* recovery failed */ }

      txs.push({
        hash: tx.hash,
        from,
        to: tx.to ? tx.to.toLowerCase() : null, // null => contract deployment
        value: tx.value,
        nonce: tx.nonce,
        selector: tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10).toLowerCase() : null,
        data: tx.data,
        sequenceNumber: m.sequenceNumber,
        l1BlockNumber: inner?.header?.blockNumber ?? null,
        sequencerTs: inner?.header?.timestamp ?? null,
        seenAt,
      });
    }
  }

  return { txs, seqs };
}
