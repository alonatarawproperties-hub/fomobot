#!/usr/bin/env node
// Print the chat id(s) that have messaged the sniper bot.
//
// Telegram never tells a bot who its owner is — a bot only learns a chat id when
// someone messages it. That id is the ONLY thing standing between a stranger and
// a bot that can spend the whole budget, so it has to be discovered once and
// then pinned in the environment.
//
// Reads FIRSTFILL_SNIPER_TELEGRAM_TOKEN, or takes the token as an argument.
//
// Note this consumes nothing: getUpdates without an offset leaves the backlog in
// place, so running this does not eat a command the bot has not read yet.

const token = process.argv[2] || process.env.FIRSTFILL_SNIPER_TELEGRAM_TOKEN;
if (!token) {
  console.error('usage: node scripts/telegram-chat-id.mjs [<bot token>]');
  console.error('   or: set FIRSTFILL_SNIPER_TELEGRAM_TOKEN');
  process.exit(1);
}

const api = (m) => fetch(`https://api.telegram.org/bot${token}/${m}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());

const me = await api('getMe');
if (!me.ok) {
  console.error(`the token was refused: ${me.description}`);
  process.exit(1);
}
console.log(`bot: ${me.result.first_name} @${me.result.username} (id ${me.result.id})`);

const updates = await api('getUpdates');
if (!updates.ok) {
  console.error(`getUpdates failed: ${updates.description}`);
  process.exit(1);
}

const chats = new Map();
for (const u of updates.result ?? []) {
  const m = u.message ?? u.edited_message ?? u.channel_post;
  if (m?.chat) chats.set(String(m.chat.id), m.chat);
}

if (chats.size === 0) {
  console.log('\nNo messages yet. Send any message to the bot, then run this again.');
  process.exit(0);
}

console.log('');
for (const [id, c] of chats) {
  const who = c.first_name ?? c.title ?? '';
  console.log(`  chat id ${id}   ${c.type}${who ? `  ${who}` : ''}${c.username ? `  @${c.username}` : ''}`);
}
console.log('\nPut the one you command it from in the env file:');
console.log(`  FIRSTFILL_SNIPER_TELEGRAM_CHAT_ID=${[...chats.keys()][0]}`);
if (chats.size > 1) {
  console.log('\nMore than one chat has messaged this bot. Exactly ONE may command it —');
  console.log('every other chat is ignored in silence. Pick deliberately.');
}
