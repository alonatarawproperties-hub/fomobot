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
import { classifyAddress, parseAddTrader, applyAdd, applyRemove, formatRoster } from './src/roster-edit.mjs';

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

console.log('\nthe watch list');

const SOL = '3owNGvPDRmgdTSBkp8ro2d5zBJCpnGi4nDhSkpgpqXeZ';
const EVM = '0xb054643d9446d778511be5ed8f46d349b8ecc2c0';
const ROSTER = [
  { handle: 'ruralvalidsnake', solana: SOL, address: EVM, enabled: true, sizeUsd: 430, notes: 'hard-won research' },
  { handle: 'someoneelse', address: '0x' + 'aa'.repeat(20), enabled: true },
];

{
  assert.deepEqual(classifyAddress(EVM), { chain: 'evm', address: EVM });
  assert.deepEqual(classifyAddress(SOL), { chain: 'solana', address: SOL });
  // Capitalisation IS the checksum on an EVM address, so a mistyped one is
  // caught here. The correctly checksummed form normalises to lowercase.
  assert.equal(classifyAddress('0xB054643d9446D778511bE5eD8f46D349b8ECc2c0').address, EVM);
  assert.equal(classifyAddress('0xB054643d9446D778511bE5eD8f46D349b8ECc2c1'), null);
  ok('an address is decoded and matched to its chain, and a bad EVM checksum is refused');
}
{
  // A Solana address is 32 bytes exactly. A loose size bound accepted this one
  // with a character deleted, which is the typo the whole check exists for.
  assert.equal(classifyAddress(SOL.slice(0, -1)), null, 'one character short');
  assert.equal(classifyAddress(SOL + 'a'), null, 'one character long');
  assert.equal(classifyAddress('11111111111111111111111111111111')?.chain, 'solana', 'leading zero bytes are 1s');
  assert.equal(classifyAddress('So11111111111111111111111111111111111111112')?.chain, 'solana');
  ok('a Solana address must decode to exactly 32 bytes, leading zeroes included');
}
{
  // Stated rather than hidden: that format has no checksum, so a typo landing on
  // 32 valid bytes cannot be told from a real address here. index.mjs asks the
  // chain whether it has ever been used, which is what catches this.
  assert.equal(classifyAddress(SOL.slice(1))?.chain, 'solana');
  ok('a same-length Solana typo is NOT catchable by shape - a known limit, not a gap');
}
{
  assert.equal(classifyAddress('hello'), null);
  assert.equal(classifyAddress('0x1234'), null);
  assert.equal(classifyAddress(''), null);
  assert.equal(classifyAddress(null), null);
  ok('nonsense is refused rather than written to the watch list');
}
{
  const r = parseAddTrader(['newguy', SOL, EVM]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { handle: 'newguy', enabled: true, solana: SOL, address: EVM });
  assert.equal(parseAddTrader(['solonly', SOL]).entry.address, undefined);
  ok('a trader can be added with one chain or both');
}
{
  for (const [args, why] of [
    [[], 'nothing'],
    [['justahandle'], 'no address'],
    [['bad handle!', SOL], 'unusable handle'],
    [['x', 'notanaddress'], 'bad address'],
    [['x', EVM, EVM], 'two EVM addresses'],
    [['x', SOL, SOL], 'two Solana addresses'],
  ]) {
    const r = parseAddTrader(args);
    assert.equal(r.ok, false, why);
    assert.ok(r.error.length > 10, `${why} should explain itself`);
  }
  ok('every refusal says what was wrong with it');
}
{
  const { roster, added } = applyAdd(ROSTER, { handle: 'thirdguy', address: '0x' + 'bb'.repeat(20), enabled: true });
  assert.equal(added, true);
  assert.equal(roster.length, 3);
  assert.equal(ROSTER.length, 2, 'the original list is not mutated');
  ok('a new trader is appended without disturbing the rest');
}
{
  // Re-adding to fix one address must not silently drop a size or notes that
  // took real work to establish.
  const { roster, added } = applyAdd(ROSTER, { handle: 'RuralValidSnake', solana: SOL, enabled: true });
  assert.equal(added, false, 'matched case-insensitively');
  assert.equal(roster.length, 2);
  assert.equal(roster[0].sizeUsd, 430);
  assert.equal(roster[0].notes, 'hard-won research');
  assert.equal(roster[0].address, EVM, 'the untouched chain survives');
  ok('re-adding a trader merges, keeping size, notes and the other chain');
}
{
  const r = applyRemove(ROSTER, 'someoneelse');
  assert.equal(r.found, true);
  assert.equal(r.roster.length, 2, 'disabled, not deleted');
  assert.equal(r.roster[1].enabled, false);
  assert.equal(r.roster[1].address, '0x' + 'aa'.repeat(20), 'the address is kept for /add to restore');
  assert.equal(applyRemove(ROSTER, 'nobody').found, false);
  assert.equal(applyRemove(r.roster, 'someoneelse').alreadyOff, true);
  ok('removing disables and keeps the details, so it can be undone from a phone');
}
{
  assert.match(formatRoster([]), /Nobody is being watched/);
  const text = formatRoster(ROSTER);
  assert.ok(text.includes('ruralvalidsnake') && text.includes('$430'));
  assert.ok(text.includes('SOL 3owNGv') && text.includes('RH 0xb054'));
  assert.match(formatRoster([{ handle: 'gone', address: EVM, enabled: false }]), /Off \(1\)/);
  ok('the list shows who is on, who is off, and which chains each is watched on');
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

{
  const withRoster = (over = {}) => snap({ roster: ROSTER, ...over });
  assert.match(decideCommand({ cmd: 'traders', args: [] }, withRoster()).reply, /ruralvalidsnake/);

  const add = decideCommand({ cmd: 'add', args: ['newguy', SOL] }, withRoster());
  assert.equal(add.action, 'add-trader');
  assert.equal(add.payload.handle, 'newguy');
  assert.match(add.reply, /\$430/, 'says what it will cost per copy');

  assert.equal(decideCommand({ cmd: 'add', args: ['x', 'rubbish'] }, withRoster()).action, 'none');
  assert.equal(decideCommand({ cmd: 'add', args: [] }, withRoster()).action, 'none');
  ok('traders can be listed and added, and a bad address changes nothing');
}
{
  const r = decideCommand({ cmd: 'remove', args: ['someoneelse'] }, snap({ roster: ROSTER }));
  assert.equal(r.action, 'remove-trader');
  assert.equal(r.payload, 'someoneelse');
  assert.equal(decideCommand({ cmd: 'remove', args: ['nobody'] }, snap({ roster: ROSTER })).action, 'none');
  ok('removing a trader names them, and an unknown handle does nothing');
}
{
  // Removing the last one writes a config the bot REFUSES to load, so the next
  // restart would not come up at all - discovered whenever that happened to be.
  const solo = [{ handle: 'onlyone', address: EVM, enabled: true }];
  const r = decideCommand({ cmd: 'remove', args: ['onlyone'] }, snap({ roster: solo }));
  assert.equal(r.action, 'none');
  assert.match(r.reply, /only trader left/);
  assert.match(r.reply, /\/pause/, 'points at what they actually want');
  ok('the last trader cannot be removed, because the bot would not restart');
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
  // A direct write that dies half way leaves a truncated config.json, and the
  // next restart then cannot parse the only file that says who to watch and how
  // much to spend. Rename is atomic; a plain write is not.
  assert.match(INDEX, /renameSync\(tmp, path\)/, 'the config must be written via a temp file and renamed');
  const write = INDEX.indexOf('writeFileSync(tmp');
  const rename = INDEX.indexOf('renameSync(tmp');
  assert.ok(write > 0 && rename > write, 'written to the temp file, then renamed over the real one');
  ok('the watch list is saved atomically, so a crash cannot truncate it');
}
{
  const saves = [...INDEX.matchAll(/saveControlState\s*\(/g)];
  assert.ok(saves.length >= 1, 'the pause is never persisted');
  assert.match(INDEX, /policyState\.paused\s*=\s*action === 'pause'/);
  ok('a pause command changes the live flag and is written to disk');
}

console.log(`\n${pass} passed\n`);
