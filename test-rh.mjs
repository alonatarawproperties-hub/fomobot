// Offline tests for the Robinhood Chain trade classifier. No chain, no RPC.

import assert from 'node:assert/strict';
import { erc20Deltas, classifyRhTrade, isRhTrade, TRANSFER_TOPIC } from './src/robinhood-trade.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ok  ${n}`); pass++; };

const TARGET = '0xb054643d9446d778511be5ed8f46d349b8ecc2c0';
const RELAYER = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const TWINE = '0xe27501d787d647cc82a5b4a7eafd5750386f1b77';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const STRANGER = '0x1111111111111111111111111111111111111111';

const word = (addr) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
const hex = (n) => '0x' + n.toString(16);
const xfer = (token, from, to, amount) =>
  ({ address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: hex(amount) });
const rcpt = (logs, status = '0x1') => ({ status, logs });

console.log('\nrobinhood classifier');

{
  // The anchor: his real transaction, replayed. Measured on chain 2026-09-14,
  // not invented — a regression fails against reality rather than my idea of it.
  const real = rcpt([xfer(TWINE, RELAYER, TARGET, 298050709030015309892142n)]);
  const t = classifyRhTrade(real, TARGET);
  assert.equal(t.side, 'buy');
  assert.equal(t.token, TWINE);
  assert.equal(t.amount, 298050709030015309892142n);
  assert.equal(isRhTrade(t), true);
  ok('his real TWINE buy reads as a buy, to the token');
}
{
  const t = classifyRhTrade(rcpt([
    xfer(USDG, TARGET, RELAYER, 500_000000n),
    xfer(TWINE, RELAYER, TARGET, 42n * 10n ** 18n),
  ]), TARGET);
  assert.equal(t.side, 'buy');
  assert.equal(t.token, TWINE); // the non-quote leg decides, not the stablecoin
  ok('paying in USDG still reads as a buy of the token');
}
{
  const t = classifyRhTrade(rcpt([
    xfer(TWINE, TARGET, RELAYER, 42n * 10n ** 18n),
    xfer(WETH, RELAYER, TARGET, 3n * 10n ** 17n),
  ]), TARGET);
  assert.equal(t.side, 'sell');
  assert.equal(t.amount, 42n * 10n ** 18n);
  ok('a sell reports the amount sold');
}
{
  // Quote-only movement is funding, never a trade — same rule as Solana, where
  // most of his signatures turned out to be exactly this.
  const t = classifyRhTrade(rcpt([xfer(USDG, TARGET, RELAYER, 1280_422000n)]), TARGET);
  assert.equal(t.side, 'funding');
  assert.equal(t.direction, 'out');
  assert.equal(isRhTrade(t), false); // the executor must never act on this
  ok('quote-only movement is funding, not a trade');
}
{
  // 35 logs in the real transaction, only one of them ours. Reading another
  // party's leg as the target's would invent a trade that never happened.
  const t = classifyRhTrade(rcpt([
    xfer(TWINE, RELAYER, STRANGER, 999n * 10n ** 18n),
    xfer(WETH, STRANGER, RELAYER, 5n * 10n ** 17n),
  ]), TARGET);
  assert.equal(t.side, null);
  ok('other parties moving in the same transaction are not our trade');
}
{
  // A 2-topic log sharing the Transfer name, and an ERC-721 whose third indexed
  // topic is a token id — both would misread as a fungible amount.
  const twoTopic = { address: TWINE, topics: [TRANSFER_TOPIC, word(TARGET)], data: hex(5n) };
  const erc721 = { address: TWINE, topics: [TRANSFER_TOPIC, word(RELAYER), word(TARGET), word(TARGET)], data: '0x' };
  assert.deepEqual(erc20Deltas(rcpt([twoTopic, erc721]), TARGET), []);
  ok('a 2-topic event and an ERC-721 transfer are both ignored');
}
{
  const self = rcpt([xfer(TWINE, TARGET, TARGET, 10n ** 18n)]);
  assert.deepEqual(erc20Deltas(self, TARGET), []); // nets to zero: not a position change
  ok('a self-transfer nets to zero');
}
{
  // A reverted transaction still carries logs in some traces; acting on them
  // would be acting on something that did not happen.
  const reverted = rcpt([xfer(TWINE, RELAYER, TARGET, 10n ** 18n)], '0x0');
  assert.equal(classifyRhTrade(reverted, TARGET).side, null);
  // A receipt with no status at all must not be assumed successful.
  assert.equal(classifyRhTrade({ logs: [xfer(TWINE, RELAYER, TARGET, 1n)] }, TARGET).side, null);
  ok('a reverted or status-less receipt yields nothing');
}
{
  assert.deepEqual(erc20Deltas(rcpt([]), TARGET), []);
  assert.deepEqual(erc20Deltas({}, TARGET), []);
  assert.deepEqual(erc20Deltas(rcpt([xfer(TWINE, RELAYER, TARGET, 1n)]), ''), []);
  assert.equal(classifyRhTrade(null, TARGET).side, null);
  ok('empty, malformed and ownerless inputs yield nothing rather than throwing');
}


// ---------------------------------------------------------------------------
console.log('\na transfer into the wallet is not a buy');

{
  // THE LIVE FALSE POSITIVE, 2026-09-17. Two alerts fired as "BUY on Robinhood
  // Chain" for transactions whose selector was plain ERC-20 transfer(), sending a
  // token INTO the watched wallet. Nothing was bought, and they never showed as
  // trades on his profile because they are not trades.
  const TOKEN = '0x08ae92d3afa1a3e20a4ab738a8d8ecf0e644c5f1';
  const HIM = '0xb054643d9446d778511be5ed8f46d349b8ecc2c0';
  const SOMEONE = '0x1111111111111111111111111111111111111111';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);

  const receipt = {
    status: '0x1',
    logs: [{
      address: TOKEN,
      topics: [TRANSFER_TOPIC, pad(SOMEONE), pad(HIM)],
      data: '0x' + (12345n).toString(16).padStart(64, '0'),
    }],
  };

  // Without the call, deltas alone read it as a buy — which is exactly what
  // happened live, and is NOT a bug in the deltas: a real buy looks identical,
  // because fomo pays from a pooled account and never moves quote through his
  // wallet. The selector is the only thing that separates them.
  const blind = classifyRhTrade(receipt, HIM);
  assert.equal(blind.side, 'buy');

  const seen = classifyRhTrade(receipt, HIM, undefined, { to: TOKEN, selector: '0xa9059cbb' });
  assert.equal(seen.side, 'transfer');
  assert.equal(seen.direction, 'in');
  assert.equal(seen.token, TOKEN);
  assert.equal(seen.amount, 12345n);
  assert.equal(isRhTrade(seen), false, 'a transfer must never be copied');
  ok('a direct transfer() into the wallet reads as a transfer, not a buy');
}
{
  const TOKEN = '0x08ae92d3afa1a3e20a4ab738a8d8ecf0e644c5f1';
  const HIM = '0xb054643d9446d778511be5ed8f46d349b8ecc2c0';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const receipt = {
    status: '0x1',
    logs: [{
      address: TOKEN,
      topics: [TRANSFER_TOPIC, pad(HIM), pad('0x2222222222222222222222222222222222222222')],
      data: '0x' + (999n).toString(16).padStart(64, '0'),
    }],
  };
  const out = classifyRhTrade(receipt, HIM, undefined, { to: TOKEN, selector: '0x23b872dd' });
  assert.equal(out.side, 'transfer');
  assert.equal(out.direction, 'out');
  assert.equal(isRhTrade(out), false);
  ok('transferFrom out of the wallet is a transfer, not a sell');
}
{
  // AND THE REAL BUY MUST STILL READ AS A BUY. His first confirmed Robinhood
  // Chain buy had no quote leg at all -- one token inbound, nothing out -- so a
  // fix that demanded a quote leg would have silently stopped copying him.
  const TWINE = '0x3333333333333333333333333333333333333333';
  const HIM = '0xb054643d9446d778511be5ed8f46d349b8ecc2c0';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const receipt = {
    status: '0x1',
    logs: [{
      address: TWINE,
      topics: [TRANSFER_TOPIC, pad('0x4444444444444444444444444444444444444444'), pad(HIM)],
      data: '0x' + (298050709030000000000000n).toString(16).padStart(64, '0'),
    }],
  };
  const buy = classifyRhTrade(receipt, HIM, undefined, { to: '0xccc88a9d00000000000000000000000000c315be', selector: '0x3593564c' });
  assert.equal(buy.side, 'buy', 'a router call with a token inbound is still a buy');
  assert.equal(isRhTrade(buy), true);
  ok('a real router buy with no quote leg still reads as a buy');
}

{
  // A token contract handing tokens out by some OTHER method -- a claim, a mint,
  // a vesting release. The selector rule cannot see these, but the target can:
  // you do not buy a token by calling the token.
  const TOKEN = '0x08ae92d3afa1a3e20a4ab738a8d8ecf0e644c5f1';
  const HIM = '0xb054643d9446d778511be5ed8f46d349b8ecc2c0';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const receipt = {
    status: '0x1',
    logs: [{
      address: TOKEN,
      topics: [TRANSFER_TOPIC, pad('0x0000000000000000000000000000000000000000'), pad(HIM)],
      data: '0x' + (777n).toString(16).padStart(64, '0'),
    }],
  };
  // Some arbitrary claim selector, not a transfer one.
  const t = classifyRhTrade(receipt, HIM, undefined, { to: TOKEN, selector: '0x4e71d92d' });
  assert.equal(t.side, 'transfer');
  assert.equal(t.why, 'target-is-the-token-itself');
  assert.equal(isRhTrade(t), false);
  ok('a claim on the token contract is not a buy, whatever the selector');
}
{
  // The real buy goes through a ROUTER, so its target is not the token -- it must
  // still read as a buy. This is the case the target rule must not break.
  const TWINE = '0xe27501d787d647cc82a5b4a7eafd5750386f1b77';
  const HIM = '0xb054643d9446d778511be5ed8f46d349b8ecc2c0';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const receipt = {
    status: '0x1',
    logs: [{
      address: TWINE,
      topics: [TRANSFER_TOPIC, pad('0x4444444444444444444444444444444444444444'), pad(HIM)],
      data: '0x' + (298050709030000000000000n).toString(16).padStart(64, '0'),
    }],
  };
  const t = classifyRhTrade(receipt, HIM, undefined, { to: '0xccc88a9d00000000000000000000000000c315be', selector: '0x3593564c' });
  assert.equal(t.side, 'buy');
  assert.equal(isRhTrade(t), true);
  ok('a router buy is untouched by the target rule');
}

console.log(`\n${pass} passed\n`);
