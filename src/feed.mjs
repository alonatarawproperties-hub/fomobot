// Sequencer feed client: connect, decode, and never lie about being healthy.
//
// The failure this is built around is a stream that dies quietly. A disconnected
// watcher looks exactly like a quiet market, so silence is treated as a fault:
// no frame for `silenceMs` trips onStall, and a jump in sequence numbers trips
// onGap. Both are surfaced, not logged and forgotten.

import { EventEmitter } from 'node:events';
import { decodeFrame } from './decode.mjs';

export class SequencerFeed extends EventEmitter {
  /**
   * @param {object}    opts
   * @param {string}    opts.url         wss:// feed endpoint
   * @param {Buffer[]} [opts.prefilter]  20-byte addresses; transactions whose raw
   *                                     bytes contain none are never parsed
   * @param {number}   [opts.silenceMs]  no frame for this long => 'stall'
   * @param {number}   [opts.maxBackoffMs]
   */
  constructor({ url, prefilter = null, silenceMs = 15_000, maxBackoffMs = 10_000 }) {
    super();
    this.url = url;
    this.prefilter = prefilter;
    this.silenceMs = silenceMs;
    this.maxBackoffMs = maxBackoffMs;

    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.lastSeq = null;
    this.lastFrameAt = 0;
    this.stallTimer = null;
    this.stalled = false;

    this.stats = { frames: 0, txs: 0, skipped: 0, reconnects: 0, gaps: 0, decodeErrors: 0 };
  }

  /** Swap the prefilter when the roster changes, without dropping the socket. */
  setPrefilter(prefilter) { this.prefilter = prefilter; }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.stallTimer);
    this.stallTimer = null;
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }

  #connect() {
    if (this.stopped) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;
    const openedAt = Date.now();

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.lastFrameAt = Date.now();
      // `stalled` is deliberately NOT cleared here. A stall closes the socket, so
      // the reconnect's `open` fired before any frame arrived and reset the flag
      // that #onMessage checks — which made emit('recovered') unreachable after a
      // stall, so the alert fired and never said all-clear. An alarm that only
      // ever goes off is one nobody reads.
      //
      // It is also the more honest invariant: an open socket is not a receiving
      // one, and the thing being watched is whether frames are arriving.
      this.emit('open', { connectMs: Date.now() - openedAt });
      this.#armStallCheck();
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev));

    ws.addEventListener('error', (err) => {
      this.emit('warn', { at: 'socket', message: err?.message ?? String(err) });
    });

    ws.addEventListener('close', (ev) => {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
      if (this.stopped) return;
      this.stats.reconnects++;
      this.emit('closed', { code: ev.code, reason: ev.reason || null });
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    // Full jitter: a fleet of watchers must not retry in lockstep after an outage.
    const ceiling = Math.min(this.maxBackoffMs, 250 * 2 ** this.attempt++);
    setTimeout(() => this.#connect(), Math.random() * ceiling);
  }

  #armStallCheck() {
    clearInterval(this.stallTimer);
    this.stallTimer = setInterval(() => {
      const quiet = Date.now() - this.lastFrameAt;
      if (quiet > this.silenceMs && !this.stalled) {
        this.stalled = true;
        this.emit('stall', { quietMs: quiet });
        try { this.ws?.close(); } catch { /* will reconnect anyway */ }
      }
    }, Math.max(1000, Math.floor(this.silenceMs / 3)));
  }

  #onMessage(ev) {
    const seenAt = Date.now();
    this.lastFrameAt = seenAt;
    if (this.stalled) {
      this.stalled = false;
      this.emit('recovered', {});
    }

    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      this.stats.decodeErrors++;
      return;
    }

    this.stats.frames++;

    let decoded;
    try {
      decoded = decodeFrame(frame, seenAt, this.prefilter);
    } catch (err) {
      this.stats.decodeErrors++;
      this.emit('warn', { at: 'decode', message: err?.message ?? String(err) });
      return;
    }

    for (const seq of decoded.seqs) {
      if (this.lastSeq !== null && seq > this.lastSeq + 1) {
        this.stats.gaps++;
        this.emit('gap', { from: this.lastSeq, to: seq, missed: seq - this.lastSeq - 1 });
      }
      // Only advance: the relay replays a backlog on connect and dedupes reorgs,
      // so out-of-order and repeated sequence numbers are both expected.
      if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
    }

    this.stats.skipped += decoded.skipped;

    if (decoded.txs.length) {
      this.stats.txs += decoded.txs.length;
      this.emit('txs', decoded.txs);
    }
  }
}
