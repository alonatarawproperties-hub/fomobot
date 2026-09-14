// The Telegram control plane: deciding what an incoming message is allowed to do.
//
// Pure and synchronous. Parsing, authorisation and the decision are all here;
// the polling loop and the state it mutates live elsewhere, so every rule below
// is testable without a network, a bot token, or a running bot.
//
// AUTHORISATION IS THE WHOLE POINT OF THIS FILE. A Telegram bot can be messaged
// by anyone who knows its username, and usernames are discoverable — so "who
// sent this" is not a detail, it is the only thing standing between a stranger
// and the pause switch on a bot holding real funds. Exactly one chat may command
// it, compared as a string because Telegram chat ids are numbers that exceed
// what JSON parses back identically in every client.
//
// An unauthorised message gets NO REPLY. Answering "not authorised" confirms the
// bot exists and is live to anyone probing usernames; silence tells them nothing
// and costs us nothing, since the operator is never in that branch.

export const REPLY = {
  UNKNOWN: 'unknown-command',
  NOT_A_COMMAND: 'not-a-command',
  UNAUTHORISED: 'unauthorised',
};

/**
 * A command out of a message body.
 *
 * Telegram appends `@BotName` to commands sent in a group, so `/pause` and
 * `/pause@fomobot` are the same instruction and a bot that only understands the
 * first one looks broken in exactly the place people use it from.
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const [head, ...args] = trimmed.slice(1).split(/\s+/);
  const cmd = head.split('@')[0].toLowerCase();
  if (!cmd) return null;
  return { cmd, args };
}

/**
 * May this message command the bot?
 *
 * String comparison on purpose: a Telegram chat id is a 64-bit integer, and both
 * the config file and the API can hand it over as a number or a string. Comparing
 * loosely would be one coercion rule away from admitting the wrong chat, and
 * comparing as numbers loses precision on large ids in some clients.
 */
export function isAuthorized(message, allowedChatId) {
  const from = message?.chat?.id;
  if (from === undefined || from === null) return false;
  if (allowedChatId === undefined || allowedChatId === null || allowedChatId === '') return false;
  return String(from) === String(allowedChatId);
}

const pad = (n, w = 0) => String(n).padStart(w);

/**
 * What a command should do, and what to say back. Pure: it reads a snapshot and
 * returns an intent, so the caller owns every mutation.
 *
 * @param {{cmd:string,args:string[]}} parsed
 * @param {object} snap  a read-only view of the bot's state
 * @returns {{action:string, reply:string}}
 */
export function decideCommand(parsed, snap) {
  switch (parsed.cmd) {
    case 'start':
    case 'help':
      return { action: 'none', reply: helpText() };

    case 'pause':
      if (snap.paused) return { action: 'none', reply: '⏸ Already paused. No new positions are being opened.' };
      return {
        action: 'pause',
        // Said plainly every time, because the gap between what pause does and
        // what someone reaching for it in a hurry assumes it does is where money
        // is lost: it stops NEW entries, it cannot undo one already open.
        reply: '⏸ <b>PAUSED</b>\nNo new positions will be opened.\n\nThis does not close anything already held — the bot cannot sell yet.',
      };

    case 'resume':
      if (!snap.paused) return { action: 'none', reply: '▶️ Already running.' };
      return { action: 'resume', reply: `▶️ <b>RESUMED</b>\nWatching again, ${snap.mode === 'live' ? 'and it will spend real money' : 'in paper mode — nothing is spent'}.` };

    case 'status':
      return { action: 'none', reply: statusText(snap) };

    case 'positions':
      return { action: 'none', reply: positionsText(snap) };

    default:
      return { action: 'none', reply: `Unknown command <code>/${parsed.cmd}</code>\n\n${helpText()}` };
  }
}

function helpText() {
  return [
    '<b>Commands</b>',
    '',
    '/status    — is it alive, what is it watching, what does it hold',
    '/pause     — stop opening new positions',
    '/resume    — start again',
    '/positions — what it currently holds',
    '/help      — this',
  ].join('\n');
}

function statusText(s) {
  const up = Math.floor((s.uptimeMs ?? 0) / 1000);
  const hrs = Math.floor(up / 3600), mins = Math.floor((up % 3600) / 60);
  return [
    `${s.paused ? '⏸ <b>PAUSED</b>' : '🟢 <b>RUNNING</b>'}  ·  ${s.mode === 'live' ? '💸 LIVE' : '📄 PAPER (nothing is spent)'}`,
    '',
    `watching   ${s.handles?.join(', ') || '(nobody)'}`,
    `size       $${s.sizeUsd} per copy, max ${s.maxOpenPositions} position(s)`,
    `slippage   ${(s.slippageBps ?? 0) / 100}%`,
    '',
    `uptime     ${hrs}h ${mins}m`,
    `RH feed    ${s.rh?.frames ?? 0} frames, ${s.rh?.reconnects ?? 0} reconnects, ${s.rh?.gaps ?? 0} gaps`,
    `Solana     ${s.solana === 'disabled' ? 'disabled' : `${s.solana?.hits ?? 0} hits, ${s.solana?.reconnects ?? 0} reconnects`}`,
    '',
    `seen       ${pad(s.considered ?? 0)} buys considered`,
    `skipped    ${pad(s.skipped ?? 0)} by the policy gate`,
    `refused    ${pad(s.refused ?? 0)} by the safety checks`,
    `${s.mode === 'live' ? 'bought' : 'papered'}     ${pad(s.mode === 'live' ? (s.bought ?? 0) : (s.papered ?? 0))}`,
    s.errors ? `errors     ${s.errors}` : null,
  ].filter(Boolean).join('\n');
}

function positionsText(s) {
  const open = s.openMints ?? [];
  if (!open.length) return `No open positions. ${s.maxOpenPositions} slot(s) free.`;
  return [
    `<b>${open.length} open</b> of ${s.maxOpenPositions}`,
    '',
    ...open.map((m) => `<code>${m}</code>`),
    '',
    // Not a detail to discover later: nothing here closes a position.
    'The bot cannot sell. These are exited by hand.',
  ].join('\n');
}
