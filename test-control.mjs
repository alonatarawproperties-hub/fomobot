// Offline tests for the Telegram control plane. No network, no bot token.
//
// The authorisation cases matter most: a Telegram bot can be messaged by anyone
// who knows its username, so this check is the only thing between a stranger and
// the pause switch on a bot holding real funds.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, isAuthorized, decideCommand, isStale } from './src/control.mjs';
import { loadControlState, saveControlState } from './src/control-io.mjs';

let pass = 0;
const ok = (name) => { console.log(`  ok  ${name}`); pass++; };
const snap = (over = {}) => ({
  paused: false, mode: 'paper', handles: ['ruralvalidsnake'], sizeUsd: 430,
  maxOpenPositions: 1, slippageBps: 1000, uptimeMs: 3_600_000,
  rh: { frames: 10, reconnects: 0, gaps: 0 }, solana: { hits: 0, reconnects: 0 },
  openMints: [], considered: 0, skipped: 0, refused: 0, bought: 0, papered: 0, errors: 0, ...over,
});

console.log('\nparsing');

{
  assert.deepEqual(parseCommand('/pause'), { cmd: 'pause', args: [] });
  assert.deepEqual(parseCommand('  /status  '), { cmd: 'status', args: [] });
  assert.deepEqual(parseCommand('/size 100'), { cmd: 'size', args: ['100'] });
  ok('a command and its arguments come out of the message');
}
{
  // Telegram appends @BotName to commands sent in a group. A bot that only
  // understands the bare form looks broken exactly where people use it from.
  assert.equal(parseCommand('/pause@fomobot')?.cmd, 'pause');
  assert.equal(parseCommand('/PAUSE@FomoBot')?.cmd, 'pause');
  assert.equal(parseCommand('/Status')?.cmd, 'status');
  ok('the @botname suffix a group adds is stripped, and case is ignored');
}
{
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('/'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand(42), null);
  ok('ordinary chatter and malformed input are not commands');
}

console.log('\nauthorisation');

{
  assert.equal(isAuthorized({ chat: { id: 8322709778 } }, 8322709778), true);
  assert.equal(isAuthorized({ chat: { id: 8322709778 } }, '8322709778'), true);
  assert.equal(isAuthorized({ chat: { id: '8322709778' } }, 8322709778), true);
  ok('the configured chat is admitted however the id is spelled');
}
{
  assert.equal(isAuthorized({ chat: { id: 1234 } }, 8322709778), false);
  assert.equal(isAuthorized({ chat: { id: -100123 } }, 8322709778), false);
  ok('any other chat is refused');
}
{
  // Fail closed. Every one of these is a misconfiguration, and the wrong answer
  // to each is "let them in".
  assert.equal(isAuthorized({}, 8322709778), false);
  assert.equal(isAuthorized({ chat: {} }, 8322709778), false);
  assert.equal(isAuthorized(null, 8322709778), false);
  assert.equal(isAuthorized({ chat: { id: 1 } }, undefined), false);
  assert.equal(isAuthorized({ chat: { id: 1 } }, null), false);
  assert.equal(isAuthorized({ chat: { id: 1 } }, ''), false);
  ok('a missing sender or a missing allowlist refuses, never admits');
}
{
  // Compared as strings because a chat id is a 64-bit integer: two DIFFERENT ids
  // this far out collapse to the same JavaScript number, and a numeric compare
  // would admit the wrong chat.
  const a = '9007199254740993', b = '9007199254740992';
  assert.equal(Number(a), Number(b), 'precondition: these collide as numbers');
  assert.equal(isAuthorized({ chat: { id: a } }, b), false);
  assert.equal(isAuthorized({ chat: { id: a } }, a), true);
  ok('two ids that collide as numbers are still told apart');
}

console.log('\nstale messages');

const START = 1_700_000_000_000; // ms
const at = (ms) => ({ date: Math.floor(ms / 1000) });

{
  // The bug this replaced: the backlog was decided by which POLL a message
  // arrived in, and an idle first poll left the offset unset -- so the next
  // batch, minutes later and carrying a real command, was still discarded. The
  // first command ever sent was always eaten, which is exactly what a user sees
  // as "no response".
  assert.equal(isStale(at(START + 60_000), START), false, 'sent after startup');
  assert.equal(isStale(at(START), START), false, 'sent exactly at startup');
  assert.equal(isStale(at(START - 5_000), START), false, 'sent during a restart, inside the grace');
  assert.equal(isStale(at(START - 86_400_000), START), true, 'sent yesterday');
  ok('staleness is decided by when the message was sent, not which poll saw it');
}
{
  // The grace window must be short enough that it cannot resurrect an old
  // instruction -- a /resume from yesterday acting today is the dangerous
  // direction of replaying a backlog.
  assert.equal(isStale(at(START - 29_000), START), false);
  assert.equal(isStale(at(START - 31_000), START), true);
  assert.equal(isStale(at(START - 31_000), START, 0), true);
  ok('the grace window covers a restart and nothing longer');
}
{
  // A missing timestamp is treated as current: dropping a real command is the
  // more annoying failure, and the update offset already prevents repeats.
  assert.equal(isStale({}, START), false);
  assert.equal(isStale({ date: null }, START), false);
  assert.equal(isStale({ date: 'soon' }, START), false);
  assert.equal(isStale(null, START), false);
  ok('a message with no usable timestamp is processed rather than dropped');
}

console.log('\ndecisions');

{
  const d = decideCommand({ cmd: 'pause', args: [] }, snap());
  assert.equal(d.action, 'pause');
  // The gap between what pause does and what someone reaching for it in a hurry
  // assumes it does is where money is lost.
  assert.match(d.reply, /cannot sell|does not close/i);
  ok('pause stops new entries and says plainly that it closes nothing');
}
{
  assert.equal(decideCommand({ cmd: 'pause', args: [] }, snap({ paused: true })).action, 'none');
  assert.equal(decideCommand({ cmd: 'resume', args: [] }, snap({ paused: false })).action, 'none');
  ok('pausing a paused bot and resuming a running one change nothing');
}
{
  const d = decideCommand({ cmd: 'resume', args: [] }, snap({ paused: true, mode: 'live' }));
  assert.equal(d.action, 'resume');
  assert.match(d.reply, /real money/i);
  assert.match(decideCommand({ cmd: 'resume', args: [] }, snap({ paused: true })).reply, /paper/i);
  ok('resuming says which mode it is resuming into');
}
{
  const r = decideCommand({ cmd: 'status', args: [] }, snap({ considered: 3, refused: 1 })).reply;
  for (const must of ['RUNNING', 'PAPER', 'ruralvalidsnake', '430', '10%', '1h 0m']) {
    assert.ok(r.includes(must), `status should mention ${must}`);
  }
  assert.match(decideCommand({ cmd: 'status', args: [] }, snap({ paused: true })).reply, /PAUSED/);
  ok('status reports mode, target, size, slippage and uptime');
}
{
  assert.match(decideCommand({ cmd: 'positions', args: [] }, snap()).reply, /No open positions/);
  const held = decideCommand({ cmd: 'positions', args: [] }, snap({ openMints: ['0xabc'] })).reply;
  assert.ok(held.includes('0xabc'));
  assert.match(held, /cannot sell/i);
  ok('positions lists what is held and that nothing here exits it');
}
{
  for (const cmd of ['help', 'start']) assert.match(decideCommand({ cmd, args: [] }, snap()).reply, /\/pause/);
  const unknown = decideCommand({ cmd: 'destroy', args: [] }, snap());
  assert.equal(unknown.action, 'none');
  assert.match(unknown.reply, /Unknown command/);
  ok('help lists the commands, and an unknown one does nothing but say so');
}
{
  // No command may act except the two that are meant to.
  for (const cmd of ['status', 'positions', 'help', 'start', 'sell', 'buy', 'withdraw', 'size']) {
    assert.equal(decideCommand({ cmd, args: ['1'] }, snap()).action, 'none', cmd);
  }
  ok('only pause and resume change anything; nothing here can move money');
}

console.log('\npersistence');

const dir = mkdtempSync(join(tmpdir(), 'ff-control-'));
const path = join(dir, 'control.json');

{
  // A pause given from a phone must outlive a reboot. Without this the VM
  // restarts an hour later and silently starts trading again.
  assert.equal(saveControlState(path, { paused: true }), true);
  assert.equal(loadControlState(path).paused, true);
  saveControlState(path, { paused: false });
  assert.equal(loadControlState(path).paused, false);
  ok('a pause is written to disk and read back');
}
{
  assert.equal(loadControlState(join(dir, 'nope.json')).paused, false);
  writeFileSync(path, 'not json at all');
  assert.equal(loadControlState(path).paused, false);
  writeFileSync(path, '{"paused":"yes"}');
  assert.equal(loadControlState(path).paused, false, 'only a real boolean counts as paused');
  ok('a missing or corrupt file reads as not-paused rather than throwing');
}
{
  // A path whose parent is an existing FILE, so mkdirSync fails immediately with
  // ENOTDIR. (/proc/... was tried first and hangs rather than erroring, which is
  // its own small lesson about picking an unwritable path.)
  writeFileSync(path, '{}');
  assert.equal(saveControlState(join(path, 'nested.json'), { paused: true }), false);
  ok('a write that cannot happen reports false instead of pretending');
}
rmSync(dir, { recursive: true, force: true });

console.log('\nwiring (read as source)');

const stripComments = (src) => src
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const INDEX = stripComments(readFileSync(new URL('./index.mjs', import.meta.url), 'utf8'));
assert.ok(INDEX.length > 2000, 'index.mjs stripped to nothing');

{
  // Restoring the pause after the feed is wired leaves a window where a paused
  // bot takes a position because it had not read the file yet.
  const restore = INDEX.indexOf('policyState.paused = controlState.paused');
  const feedStart = INDEX.indexOf('feed.start()');
  assert.ok(restore > 0, 'the persisted pause is never restored');
  assert.ok(feedStart > 0, 'the feed is never started');
  assert.ok(restore < feedStart, 'the pause must be restored before the feed starts');
  ok('a persisted pause is restored before anything can trade');
}
{
  // The allowlist must be the configured chat and nothing looser.
  assert.match(INDEX, /chatId:\s*config\.telegram\.chatId/);
  assert.ok(!/isAuthorized\s*\([^)]*true/.test(INDEX), 'authorisation is never short-circuited');
  ok('only the configured chat is allowed to command the bot');
}
{
  // The offset must advance for every batch. Setting it after an early return is
  // what made the first command vanish.
  const CIO = stripComments(readFileSync(new URL('./src/control-io.mjs', import.meta.url), 'utf8'));
  const setOffset = CIO.indexOf('offset = Math.max(');
  const loopStart = CIO.indexOf('for (const update of updates)');
  assert.ok(setOffset > 0 && loopStart > 0);
  assert.ok(setOffset < loopStart, 'the offset is advanced before any message is handled');
  assert.ok(!/const firstPoll/.test(CIO), 'the poll-count heuristic must not come back');
  assert.match(CIO, /isStale\(message, startedAt\)/);
  ok('the backlog is judged by timestamp, and the offset always advances');
}
{
  const saves = [...INDEX.matchAll(/saveControlState\s*\(/g)];
  assert.ok(saves.length >= 1, 'the pause is never persisted');
  assert.match(INDEX, /policyState\.paused\s*=\s*action === 'pause'/);
  ok('a pause command changes the live flag and is written to disk');
}

console.log(`\n${pass} passed\n`);
