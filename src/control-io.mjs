// Listening to Telegram, and remembering that we were told to stop.
//
// Long-polls getUpdates and hands each message to control.mjs, which owns every
// decision. Nothing here decides anything except how to talk to the API.
//
// PAUSE IS PERSISTED, and that is a safety property rather than a convenience.
// An operator pauses from their phone; the VM reboots an hour later; a bot that
// re-read its config and started trading again would have silently undone the
// one instruction that was given in a hurry. The file is the source of truth at
// boot and the runtime flag follows it.
//
// THE STARTUP BACKLOG IS DISCARDED. Telegram holds undelivered updates for 24
// hours, so a bot that has been down replays everything it missed the moment it
// comes up — and a `/resume` sent yesterday acting today is the dangerous
// direction of that. Commands are momentary instructions, not durable state; the
// durable part is the persisted pause. Every accepted command replies, so a
// command dropped during a restart is visible as silence and can be sent again.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCommand, isAuthorized, decideCommand, isStale } from './control.mjs';

const API = 'https://api.telegram.org';

/** Load the persisted control state. A missing or corrupt file is "not paused". */
export function loadControlState(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { paused: raw?.paused === true, at: raw?.at ?? null };
  } catch {
    return { paused: false, at: null };
  }
}

export function saveControlState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...state, at: Date.now() }, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll Telegram for commands.
 *
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string|number} opts.chatId   the ONLY chat allowed to command this bot
 * @param {() => object} opts.snapshot  read-only view of the bot's state
 * @param {(action:string, payload?:any) => void} opts.onAction
 * @param {(msg:string, extra?:object) => void} opts.log
 */
/**
 * @param {object}   o
 * @param {Function} [o.decide]  which command vocabulary this loop speaks.
 *   Defaults to the copy-trader's. The sniper passes its own, because the two
 *   bots answer to different commands but share every hard-won fix in the poll
 *   loop below — the stale-message rule, the offset ordering, the 409 conflict
 *   detection and the refusal backoff. A second copy of this loop would be a
 *   second place for all four of those bugs to come back.
 */
export function startControl({ botToken, chatId, snapshot, onAction, log = () => {}, startedAt = Date.now(), decide = decideCommand }) {
  const stats = { polls: 0, commands: 0, rejected: 0, errors: 0, conflicts: 0, apiRefusals: 0, stale: 0 };
  let offset = null;
  let stopped = false;

  const send = async (text) => {
    try {
      await fetch(`${API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
    } catch { stats.errors += 1; }
  };

  const poll = async () => {
    while (!stopped) {
      try {
        const url = `${API}/bot${botToken}/getUpdates?timeout=30`
          + (offset === null ? '' : `&offset=${offset}`);
        // Longer than the long-poll itself, or every poll aborts on its own timeout.
        const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });

        if (res.status === 409) {
          // Telegram allows one getUpdates consumer per bot. A conflict means a
          // SECOND copy of this bot is running somewhere — worth saying loudly,
          // because in live mode two copies means two trades.
          stats.conflicts += 1;
          log('another instance is polling this bot token — commands will be unreliable and trades could double', { conflicts: stats.conflicts });
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }

        const body = await res.json();
        stats.polls += 1;

        // A refusal from the API returns IMMEDIATELY, unlike a long poll that
        // blocks for 30s — so without a backoff here the loop spins. Measured
        // with a deliberately invalid token: 141 polls in 18 seconds, which is a
        // token typo turning into a sustained hammering of Telegram, and an
        // `errors` count of zero while it happened because nothing threw.
        if (body?.ok !== true) {
          stats.apiRefusals += 1;
          const wait = Number(body?.parameters?.retry_after ?? 0) * 1000 || 15_000;
          if (stats.apiRefusals === 1 || stats.apiRefusals % 20 === 0) {
            log(`telegram refused getUpdates: ${body?.description ?? `HTTP ${res.status}`}`, { refusals: stats.apiRefusals });
          }
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        const updates = body.result ?? [];
        if (!updates.length) continue;

        // Advance the offset for EVERY batch. Doing it after an early return was
        // the bug that made the first command ever sent disappear.
        offset = Math.max(...updates.map((u) => u.update_id)) + 1;

        for (const update of updates) {
          const message = update?.message ?? update?.edited_message;
          if (!message) continue;

          if (isStale(message, startedAt)) {
            stats.stale += 1;
            log('ignored a message from before startup', { sentAt: message.date });
            continue;
          }

          if (!isAuthorized(message, chatId)) {
            // Deliberately silent. A reply would confirm to anyone probing bot
            // usernames that this one is live.
            stats.rejected += 1;
            log('ignored a command from an unauthorised chat', { chat: message?.chat?.id ?? null });
            continue;
          }

          const parsed = parseCommand(message.text);
          if (!parsed) continue;

          stats.commands += 1;
          const { action, reply, payload } = decide(parsed, snapshot());
          // The reply is sent AFTER the action is applied, so a status line in
          // it reflects what just happened rather than the state before it.
          if (action !== 'none') await onAction(action, payload);
          if (reply) await send(reply);
        }
      } catch (err) {
        stats.errors += 1;
        // A dead poll loop is a bot that looks fine and answers nothing, so it
        // backs off and keeps going rather than exiting.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  poll();
  return { stats, stop: () => { stopped = true; }, send };
}
