// The sniper's Telegram vocabulary.
//
// Pure and synchronous, exactly like the copy-trader's control.mjs: it reads a
// snapshot and returns an intent, so every rule here is testable without a
// network, a token, or a running bot. The caller owns all mutation.
//
// Authorisation is NOT decided here — it is decided by the shared poll loop in
// control-io.mjs, which admits exactly one chat id and answers an unauthorised
// message with silence. That matters more for this bot than for the copy-trader:
// this one can be told to spend ten SOL by anyone holding the bot token.

import { PublicKey } from '@solana/web3.js';

const SOL = (lamports) => {
  const s = (Number(lamports) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return `${s || '0'} SOL`;
};

/**
 * @param {{cmd:string,args:string[]}} parsed
 * @param {object} snap
 * @returns {{action:string, payload?:any, reply:string}}
 */
export function decideSnipeCommand(parsed, snap) {
  switch (parsed.cmd) {
    case 'start':
    case 'help':
      return { action: 'none', reply: helpText() };

    case 'status':
      return { action: 'none', reply: statusText(snap) };

    case 'wallets':
      return { action: 'none', reply: walletsText(snap) };

    case 'plan':
      return { action: 'none', reply: planText(snap) };

    case 'target': {
      const ca = parsed.args?.[0];
      if (!ca) return { action: 'none', reply: 'Usage: <code>/target &lt;contract address&gt;</code>' };
      try {
        new PublicKey(ca);
      } catch {
        return { action: 'none', reply: `⚠️ <code>${escapeHtml(ca)}</code> is not a valid contract address.` };
      }
      // Changing target while armed would leave the old curve subscribed against
      // the same five budgets. The caller re-subscribes; the operator is told so
      // the disarm is never a surprise.
      if (snap.armed) {
        return {
          action: 'set-target',
          payload: ca,
          reply: `\u{1F3AF} Target set to <code>${escapeHtml(ca)}</code>\n\n`
            + '⚠️ This <b>disarmed</b> you — the old target is no longer watched. Send /arm when ready.',
        };
      }
      return {
        action: 'set-target',
        payload: ca,
        // A Solana address has no checksum, so a typo cannot be caught. Said
        // every time, because the consequence is silent: it waits forever.
        reply: `\u{1F3AF} Target set to <code>${escapeHtml(ca)}</code>\n\n`
          + 'Check it character by character — a Solana address carries no checksum, so a typo '
          + 'is a valid address that nothing will ever launch at. It would simply never fire.\n\n'
          + 'Send /arm when you are ready.',
      };
    }

    case 'arm': {
      if (!snap.target) return { action: 'none', reply: '⚠️ No target. Send <code>/target &lt;contract address&gt;</code> first.' };
      if (snap.armed) return { action: 'none', reply: `Already armed on <code>${escapeHtml(snap.target)}</code> in ${snap.mode.toUpperCase()}.` };
      return { action: 'arm', reply: '' }; // the caller replies once balances are re-read
    }

    case 'disarm':
      if (!snap.armed) return { action: 'none', reply: 'Not armed.' };
      return {
        action: 'disarm',
        reply: '\u{1F6D1} <b>DISARMED</b>\nNo longer watching. Nothing was sold — this only stops it buying.',
      };

    case 'live':
      if (snap.armed) {
        return {
          action: 'none',
          reply: '⚠️ Disarm first. Switching mode while armed would change the rules mid-launch.',
        };
      }
      if (snap.mode === 'live') return { action: 'none', reply: '\u{1F4B8} Already LIVE.' };
      return {
        action: 'live',
        reply: '\u{1F4B8} <b>LIVE</b>\nThe next launch on your target will spend real SOL — '
          + `up to ${SOL(snap.buyTotalLamports ?? 0n)} across ${snap.wallets?.length ?? 0} wallets.\n\n`
          + 'Send /arm to start watching. /paper to go back.',
      };

    case 'paper':
      if (snap.armed) return { action: 'none', reply: '⚠️ Disarm first.' };
      if (snap.mode === 'paper') return { action: 'none', reply: '\u{1F4C4} Already PAPER.' };
      return { action: 'paper', reply: '\u{1F4C4} <b>PAPER</b>\nNothing will be signed or sent.' };

    case 'abort':
      // One command that always lands somewhere safe, whatever the current
      // state. Someone reaching for this is not in a position to work out which
      // of /disarm and /paper they needed.
      return {
        action: 'abort',
        reply: '\u{1F6D1} <b>ABORTED</b>\nDisarmed and switched to paper. Nothing further will be sent.\n\n'
          + 'This does not sell anything already bought — the bot cannot sell.',
      };

    default:
      return { action: 'none', reply: `Unknown command <code>/${escapeHtml(parsed.cmd)}</code>\n\n${helpText()}` };
  }
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function helpText() {
  return [
    '<b>Sniper</b>',
    '',
    '/status   — mode, target, armed, funding',
    '/target   — /target &lt;contract address&gt;',
    '/arm      — re-check balances and start watching',
    '/disarm   — stop watching',
    '',
    '/plan     — what the five buys will do to the curve',
    '/wallets  — addresses, budgets and live balances',
    '',
    '/live     — spend real SOL',
    '/paper    — rehearse, sign nothing',
    '/abort    — disarm AND switch to paper, whatever the state',
    '/help     — this',
  ].join('\n');
}

function statusText(s) {
  const up = Math.floor((s.uptimeMs ?? 0) / 1000);
  const hrs = Math.floor(up / 3600), mins = Math.floor((up % 3600) / 60);
  const lines = [
    `${s.armed ? '\u{1F3AF} <b>ARMED</b>' : '⏸ <b>IDLE</b>'}  ·  ${s.mode === 'live' ? '\u{1F4B8} LIVE' : '\u{1F4C4} PAPER (nothing is spent)'}`,
    '',
    `target     ${s.target ? `<code>${escapeHtml(s.target)}</code>` : '(none yet)'}`,
    `wallets    ${s.wallets?.length ?? 0}`,
    `size       ${SOL(s.buyTotalLamports ?? 0n)} across the split`,
    `slippage   ${Number(s.slippageBps ?? 0) / 100}%`,
    `fee        ${s.feeBasisPoints ?? '?'} bps (read from chain)`,
    '',
    `uptime     ${hrs}h ${mins}m`,
  ];
  if (s.funded === false) {
    lines.push('', `⚠️ ${s.underfunded} wallet(s) underfunded — one short leg voids the whole bundle.`);
  }
  if (s.lastResult) lines.push('', `last       ${escapeHtml(s.lastResult)}`);
  if (!s.target) lines.push('', 'Send <code>/target &lt;contract address&gt;</code> to point it at a launch.');
  return lines.join('\n');
}

function walletsText(s) {
  const ws = s.wallets ?? [];
  if (!ws.length) return 'No wallets configured.';
  const rows = ws.map((w, i) => {
    const bal = w.balance === undefined || w.balance === null ? '?' : SOL(w.balance);
    const flag = w.sufficient === false ? '  ⚠️ short' : '';
    return `${i + 1}. <code>${escapeHtml(w.address)}</code>\n   budget ${SOL(w.budgetLamports)} · balance ${bal}${flag}`;
  });
  return [`<b>${ws.length} wallets</b>`, '', ...rows, '', `total budget ${SOL(s.buyTotalLamports ?? 0n)}`].join('\n');
}

function planText(s) {
  const legs = s.plan ?? [];
  if (!legs.length) return 'No plan yet — the sniper has not primed from the chain.';
  const rows = legs.map((l) =>
    `${l.label}  ${SOL(l.budgetLamports).padStart(11)}  → ${Number(l.expectedTokens).toExponential(4)} tokens`);
  return [
    '<b>Against a fresh curve</b>',
    '<pre>' + rows.join('\n') + '</pre>',
    // The single most important number, and the least intuitive: the bundle
    // moves the curve against itself, so the last wallet pays the most.
    s.selfImpactPct !== undefined
      ? `The last wallet pays <b>${s.selfImpactPct}% more per token</b> than the first.\n`
        + 'That is these five buys moving the curve against each other. It is unavoidable '
        + 'when they land back to back, and it scales with how much of the curve you take.'
      : null,
  ].filter(Boolean).join('\n');
}
