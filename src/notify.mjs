// Telegram out. Alerts only — the control plane comes with milestone 02.
//
// This sits OFF the hot path on purpose. Sending is fire-and-forget and queued,
// because a slow Telegram API call must never delay detection, and in milestone 02
// must never delay an order. If Telegram is down, trading continues and alerts drop.

const API = 'https://api.telegram.org';

export class Notifier {
  constructor({ botToken, chatId, enabled = true, minIntervalMs = 40 }) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = Boolean(enabled && botToken && chatId);
    this.minIntervalMs = minIntervalMs;
    this.queue = [];
    this.draining = false;
    this.dropped = 0;
  }

  send(text) {
    if (!this.enabled) return;
    // Telegram allows ~30 messages/sec; a burst of signals must not get us limited.
    if (this.queue.length > 200) { this.dropped++; return; }
    this.queue.push(text);
    if (!this.draining) this.#drain();
  }

  async #drain() {
    this.draining = true;
    while (this.queue.length) {
      const text = this.queue.shift();
      try {
        const res = await fetch(`${API}/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          const wait = (body?.parameters?.retry_after ?? 2) * 1000;
          this.queue.unshift(text);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
      } catch {
        // Network or timeout. The alert is lost; that is strictly better than
        // blocking the process on a third party.
        this.dropped++;
      }
      if (this.queue.length) await new Promise((r) => setTimeout(r, this.minIntervalMs));
    }
    this.draining = false;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatSignal(sig, explorerBase) {
  const lines = [
    `⚡ <b>${esc(sig.handle)}</b> moved`,
    `<code>${esc(sig.trader)}</code>`,
    ``,
    `to       <code>${esc(sig.to ?? '(deploy)')}</code>`,
    `selector <code>${esc(sig.selector ?? '(plain transfer)')}</code>`,
    `value    <code>${esc(sig.valueWei)}</code> wei`,
    `matched  <b>${esc(sig.via)}</b>`,
  ];
  if (explorerBase && sig.txHash) {
    lines.push(``, `${explorerBase.replace(/\/$/, '')}/tx/${sig.txHash}`);
  }
  return lines.join('\n');
}
