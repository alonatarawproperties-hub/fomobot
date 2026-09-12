// Append-only JSONL recorder.
//
// Postgres arrives with the roster analytics in milestone 03. Until then this is
// the same data in the same shape, on disk, so no history is lost while the
// database question is still open — the analytics pass reads JSONL or SQL equally.
//
// Every write is best-effort and asynchronous. A recorder failure must never stop
// a trade, so errors are counted and surfaced through stats rather than thrown.

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class Recorder {
  constructor({ dir = './data', file = 'signals.jsonl' } = {}) {
    this.path = join(dir, file);
    mkdirSync(dirname(this.path), { recursive: true });
    this.stream = createWriteStream(this.path, { flags: 'a' });
    this.written = 0;
    this.errors = 0;
    this.stream.on('error', () => { this.errors++; });
  }

  write(row) {
    try {
      this.stream.write(JSON.stringify({ ...row, recordedAt: Date.now() }) + '\n');
      this.written++;
    } catch {
      this.errors++;
    }
  }

  async close() {
    await new Promise((resolve) => this.stream.end(resolve));
  }
}
