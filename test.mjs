// Offline tests. No network, no keys that matter, no chain.
//
// Builds the Nitro batch framing by hand, round-trips it through the decoder, and
// drives the roster matcher through both the sender path and the relayer path.
// Random throwaway keys, signed locally — nothing is broadcast.

import assert from 'node:assert/strict';
import { Wallet, Transaction, AbiCoder } from 'ethers';
import { extractSignedTxs, decodeFrame } from './src/decode.mjs';
import { Roster, toSignal } from './src/matcher.mjs';
import { classifyTrade, tokenDeltas, isTrade } from './src/solana.mjs';

const CHAIN_ID = 4663;
let pass = 0;
const ok = (name) => { console.log(`  ok  ${name}`); pass++; };

/** Wrap raw signed-tx envelopes in the Nitro batch format the feed uses. */
function buildBatch(rawTxHexes) {
  const parts = [Buffer.from([3])]; // L2MessageKind_Batch
  for (const hex of rawTxHexes) {
    const tx = Buffer.from(hex.slice(2), 'hex');
    const sub = Buffer.concat([Buffer.from([4]), tx]); // L2MessageKind_SignedTx
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(sub.length));
    parts.push(len, sub);
  }
  return Buffer.concat(parts).toString('base64');
}

const frameOf = (l2Msg) => ({
  version: 1,
  messages: [{
    sequenceNumber: 60882705,
    message: { message: {
      header: { kind: 3, sender: '0xa4b0...', blockNumber: 25959447, timestamp: 1789193454 },
      l2Msg,
    } },
  }],
});

async function sign(wallet, { to, data = '0x', value = 0n, nonce = 7 }) {
  const tx = Transaction.from({
    type: 2, chainId: CHAIN_ID, to, data, value, nonce,
    gasLimit: 300000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 0n,
  });
  return (await wallet.signTransaction(tx)).toLowerCase();
}

console.log('\ndecode');

const trader = Wallet.createRandom();
const relayer = Wallet.createRandom();
const ROUTER = '0x1111111111111111111111111111111111111111';

// A direct trade: the trader signs and sends it themselves. Their address is NOT
// in the bytes anywhere — it is recovered from the signature.
const directRaw = await sign(trader, {
  to: ROUTER, data: '0xdeadbeef' + '00'.repeat(32), value: 12345n, nonce: 3,
});

// A relayed trade: the relayer signs, the trader's address rides in the calldata.
const relayedRaw = await sign(relayer, {
  to: ROUTER,
  data: '0xabcdef01' + AbiCoder.defaultAbiCoder()
    .encode(['address', 'uint256'], [trader.address, 999n]).slice(2),
  nonce: 91,
});

{
  const single = Buffer.concat([Buffer.from([4]), Buffer.from(directRaw.slice(2), 'hex')]).toString('base64');
  assert.equal(extractSignedTxs(single).length, 1);
  ok('bare SignedTx message (kind 4) yields one tx');
}
{
  assert.equal(extractSignedTxs(buildBatch([directRaw, relayedRaw])).length, 2);
  ok('batch message (kind 3) yields every tx it carries');
}
{
  assert.deepEqual(extractSignedTxs('!!!not base64!!!'), []);
  assert.deepEqual(extractSignedTxs(''), []);
  // A truncated length prefix must abort the batch, not loop or throw.
  const truncated = Buffer.concat([Buffer.from([3]), Buffer.from([0, 0, 0, 0, 0, 0, 255, 255])]).toString('base64');
  assert.deepEqual(extractSignedTxs(truncated), []);
  ok('malformed input returns empty instead of throwing');
}
{
  const { txs, seqs } = decodeFrame(frameOf(buildBatch([directRaw, relayedRaw])));
  assert.equal(txs.length, 2);
  assert.deepEqual(seqs, [60882705]);
  assert.equal(txs[0].from, trader.address.toLowerCase());
  assert.equal(txs[0].to, ROUTER);
  assert.equal(txs[0].selector, '0xdeadbeef');
  assert.equal(txs[0].value, 12345n);
  assert.equal(txs[0].nonce, 3);
  assert.equal(txs[0].sequenceNumber, 60882705);
  assert.equal(txs[1].from, relayer.address.toLowerCase());
  ok('sender is recovered from the signature, with to/selector/value/nonce intact');
}

console.log('\nprefilter');

const traderNeedle = Buffer.from(trader.address.slice(2), 'hex');

{
  // The whole point: traffic belonging to nobody we watch is dropped before the
  // ECDSA recovery that dominates parsing cost.
  const stranger = Wallet.createRandom();
  const noise = await sign(stranger, { to: ROUTER, data: '0x12345678', nonce: 1 });
  const r = decodeFrame(frameOf(buildBatch([noise])), Date.now(), [traderNeedle]);
  assert.equal(r.txs.length, 0);
  assert.equal(r.skipped, 1);
  ok('unrelated traffic is skipped without being parsed');
}
{
  const r = decodeFrame(frameOf(buildBatch([relayedRaw])), Date.now(), [traderNeedle]);
  assert.equal(r.txs.length, 1);
  assert.equal(r.skipped, 0);
  assert.equal(r.txs[0].from, relayer.address.toLowerCase());
  ok('an address embedded in calldata still survives the prefilter');
}
{
  // The documented cost, asserted so it stays a decision rather than a surprise:
  // a wallet that only ever SENDS is invisible to a byte scan, because the sender
  // is derived from the signature and appears nowhere in the bytes.
  const r = decodeFrame(frameOf(buildBatch([directRaw])), Date.now(), [traderNeedle]);
  assert.equal(r.txs.length, 0);
  assert.equal(r.skipped, 1);
  // ...and it IS found once the filter is off.
  const unfiltered = decodeFrame(frameOf(buildBatch([directRaw])));
  assert.equal(unfiltered.txs[0].from, trader.address.toLowerCase());
  ok('a sender-only wallet is NOT found under the prefilter, but is without it');
}

console.log('\nmatcher');

const roster = new Roster([{ handle: 'target', address: trader.address }]);
const { txs } = decodeFrame(frameOf(buildBatch([directRaw, relayedRaw])));

{
  const hit = roster.match(txs[0]);
  assert.equal(hit?.via, 'sender');
  assert.equal(hit.entry.handle, 'target');
  ok('direct trade matches via sender');
}
{
  // The case that decides whether this works at all, since the target's EVM account
  // is an EIP-7702 delegated 4337 account: he never appears as the sender, only
  // inside the calldata of a bundler's handleOps call.
  const hit = roster.match(txs[1]);
  assert.equal(hit?.via, 'calldata');
  assert.equal(hit.entry.handle, 'target');
  ok('relayed trade matches via calldata');
}
{
  const stranger = Wallet.createRandom();
  const noise = await sign(stranger, { to: ROUTER, data: '0x12345678', nonce: 1 });
  const other = decodeFrame(frameOf(buildBatch([noise]))).txs[0];
  assert.equal(roster.match(other), null);
  ok('unrelated traffic does not match');
}
{
  assert.throws(() => new Roster([{ handle: 'bad', address: '0xnope' }]), /not a 20-byte hex address/);
  assert.equal(new Roster([{ handle: 'off', address: trader.address, enabled: false }]).size, 0);
  ok('bad addresses are rejected and disabled entries are not watched');
}
{
  const needles = roster.needles();
  assert.equal(needles.length, 1);
  assert.equal(needles[0].length, 20);
  assert.ok(needles[0].equals(traderNeedle));
  assert.equal(roster.anySelfSends, false);
  // One self-sending entry must turn the filter off for the whole feed, since a
  // byte scan cannot see it.
  assert.equal(new Roster([{ handle: 'x', address: trader.address, selfSends: true }]).anySelfSends, true);
  ok('needles are raw 20-byte addresses and selfSends disables the prefilter');
}
{
  const sig = toSignal(txs[0], roster.match(txs[0]));
  assert.equal(sig.handle, 'target');
  assert.equal(sig.via, 'sender');
  assert.equal(sig.valueWei, '12345'); // must be a string: JSON cannot carry BigInt
  assert.equal(JSON.parse(JSON.stringify(sig)).valueWei, '12345');
  ok('signal serialises to JSON without losing the value');
}

console.log('\nsolana');

const OWNER = '3owNGvPDRmgdTSBkp8ro2d5zBJCpnGi4nDhSkpgpqXeZ';
const STRANGER = 'StrangerWa11etAddressThatIsNotOurs00000000';
const WSOL = 'So11111111111111111111111111111111111111112';
const MEME = 'MemeM1nt1111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const bal = (mint, owner, amount, decimals = 6) =>
  ({ mint, owner, uiTokenAmount: { amount: String(amount), decimals } });

const txOf = (pre, post) => ({ meta: { preTokenBalances: pre, postTokenBalances: post } });

{
  // Bought MEME with wSOL: the meme balance goes up, the wSOL balance goes down.
  const tx = txOf(
    [bal(WSOL, OWNER, 2_000_000_000, 9), bal(MEME, OWNER, 0)],
    [bal(WSOL, OWNER, 1_000_000_000, 9), bal(MEME, OWNER, 5_000_000)],
  );
  const t = classifyTrade(tx, OWNER);
  assert.equal(t.side, 'buy');
  assert.equal(t.mint, MEME);
  assert.equal(t.amount, 5_000_000n);
  ok('a buy is read off the balance delta, not the instructions');
}
{
  const tx = txOf(
    [bal(WSOL, OWNER, 1_000_000_000, 9), bal(MEME, OWNER, 5_000_000)],
    [bal(WSOL, OWNER, 2_000_000_000, 9), bal(MEME, OWNER, 1_000_000)],
  );
  const t = classifyTrade(tx, OWNER);
  assert.equal(t.side, 'sell');
  assert.equal(t.amount, 4_000_000n); // reported positive: size, with side carrying direction
  ok('a partial sell reports the amount sold, not the remainder');
}
{
  // The case that matters most: one transaction carrying several wallets' balances.
  // Reading the stranger's movement as the target's would invent a trade.
  const tx = txOf(
    [bal(MEME, STRANGER, 0), bal(MEME, OWNER, 0)],
    [bal(MEME, STRANGER, 9_000_000), bal(MEME, OWNER, 0)],
  );
  assert.equal(classifyTrade(tx, OWNER).side, null);
  assert.equal(tokenDeltas(tx, STRANGER).length, 1);
  ok('another wallet moving in the same transaction is not our trade');
}
{
  // Quote-only movement is funding, never a trade. This is the shape 19 of the
  // target's 25 most recent signatures actually have — USDC out to fomo's omnibus.
  const tx = txOf([bal(USDC, OWNER, 332_423_995)], [bal(USDC, OWNER, 249_317_997)]);
  const t = classifyTrade(tx, OWNER);
  assert.equal(t.side, 'funding');
  assert.equal(t.direction, 'out');
  assert.equal(t.amount, 83_105_998n);
  assert.equal(isTrade(t), false); // the executor must never act on this
  ok('quote-only movement is funding, not a trade');
}
{
  const tx = txOf([bal(WSOL, OWNER, 1_000_000_000, 9)], [bal(WSOL, OWNER, 3_000_000_000, 9)]);
  const t = classifyTrade(tx, OWNER);
  assert.equal(t.side, 'funding');
  assert.equal(t.direction, 'in');
  assert.equal(isTrade(t), false);
  ok('an inbound quote movement is funding in, still not a trade');
}
{
  // A trade paid for in quote currency must still read as a trade, not funding.
  const tx = txOf(
    [bal(USDC, OWNER, 500_000_000), bal(MEME, OWNER, 0)],
    [bal(USDC, OWNER, 100_000_000), bal(MEME, OWNER, 7_000_000)],
  );
  const t = classifyTrade(tx, OWNER);
  assert.equal(t.side, 'buy');
  assert.equal(t.mint, MEME);
  assert.equal(isTrade(t), true);
  ok('the non-quote leg still decides a trade when quote moves alongside it');
}
{
  assert.deepEqual(tokenDeltas({}, OWNER), []);
  assert.deepEqual(tokenDeltas({ meta: {} }, OWNER), []);
  assert.equal(classifyTrade({ meta: { preTokenBalances: [], postTokenBalances: [] } }, OWNER).side, null);
  ok('a transaction with no balance data yields nothing rather than throwing');
}

console.log(`\n${pass} passed\n`);
