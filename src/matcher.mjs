// Roster matching.
//
// A fomo trade does NOT reach the chain as a tx sent from the trader's own EOA.
// Measured on the target 2026-09-12: nonce 1, balance 0, and eth_getCode returns
// 0xef0100e6cae83bde06e4c305530e199d7217f42808555b — an EIP-7702 delegation to an
// ERC-4337 account implementation. So EVM trades arrive as handleOps calls from a
// bundler, with the trader's address inside the calldata as userOp.sender.
//
// Matching on `from` alone would therefore never fire. Both paths are checked and
// `via` records which one did, so the assumption stays checkable against live data
// instead of being baked in.

export class Roster {
  constructor(entries = []) {
    this.byAddress = new Map();
    this.replace(entries);
  }

  /** @param {Array<{handle:string, address:string, enabled?:boolean, notes?:string}>} entries */
  replace(entries) {
    const next = new Map();
    for (const e of entries) {
      if (!e?.address) continue;
      const addr = e.address.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) {
        throw new Error(`roster: "${e.handle ?? addr}" is not a 20-byte hex address`);
      }
      if (e.enabled === false) continue;
      next.set(addr, {
        handle: e.handle ?? addr.slice(0, 10),
        address: addr,
        bare: addr.slice(2), // no 0x, for calldata scanning
        notes: e.notes ?? null,
      });
    }
    this.byAddress = next;
    return this;
  }

  get size() { return this.byAddress.size; }
  list() { return [...this.byAddress.values()]; }

  /**
   * @returns {null | {entry: object, via: 'sender'|'calldata'}}
   */
  match(tx) {
    if (tx.from) {
      const direct = this.byAddress.get(tx.from);
      if (direct) return { entry: direct, via: 'sender' };
    }

    // The 4337 case. The address must be 32-byte-word aligned in an ABI-encoded
    // argument, but a plain substring test also catches packed encodings, so it
    // stays loose. Cannot produce a false negative; a false positive is possible
    // if the address appears in unrelated calldata, which is why `via` is recorded.
    if (tx.data && tx.data.length > 10 && this.byAddress.size) {
      const hay = tx.data.toLowerCase();
      for (const entry of this.byAddress.values()) {
        if (hay.includes(entry.bare)) return { entry, via: 'calldata' };
      }
    }

    return null;
  }
}

/** Normalise a signal for the recorder, the notifier and (later) the executor. */
export function toSignal(tx, hit) {
  return {
    kind: 'signal',
    handle: hit.entry.handle,
    trader: hit.entry.address,
    via: hit.via,
    txHash: tx.hash,
    to: tx.to,
    selector: tx.selector,
    valueWei: tx.value?.toString() ?? '0',
    nonce: tx.nonce,
    sequenceNumber: tx.sequenceNumber,
    sequencerTs: tx.sequencerTs,
    seenAt: tx.seenAt,
    // Detection latency cannot be measured against the sequencer's own clock:
    // the header timestamp is whole seconds, so it rounds away everything we care
    // about. Real latency comes from comparing seenAt against the confirmed block
    // time later, in analysis — not here.
    data: tx.data,
  };
}
