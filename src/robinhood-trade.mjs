// What a Robinhood Chain transaction did, read from its receipt.
//
// Deliberately NOT by decoding fomo's router. Verified against the target's
// first real RH transaction (0x853010bc..., 2026-09-14): relayer-sent, routed
// through 0xccc88a9d...c315be, 35 logs, 2.26M gas. That router is a proprietary
// contract fomo can redeploy whenever they like, and a hand-decoded ABI would go
// silently wrong the day they do — producing a confident wrong token rather than
// an error.
//
// A receipt cannot lie about who received what. So this nets ERC-20 Transfer
// events per owner, which is the same principle as the Solana side's pre/post
// balance deltas. Both return the same shape on purpose, so one policy gate can
// take either without caring which chain a signal came from.
//
// The cost is a round trip: a receipt exists only after the block executes, so
// this lands a few hundred ms behind the sequencer feed's first sight of the
// transaction. That is why detection stays two-stage — alert on the feed, decide
// on the receipt — and it is still seconds ahead of anyone reading a fomo
// notification.

export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Confirmed on chain via symbol()/decimals() rather than assumed:
//   WETH 0x0bd7d308... (18)  — read out of SwapRouter02.WETH9()
//   USDG 0x5fc5360d... (6)   — the stablecoin most of this chain settles in
export const QUOTE_TOKENS = new Set([
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
]);

/**
 * Selectors that move a token WITHOUT buying it.
 *
 * THE FALSE POSITIVE THIS EXISTS FOR, observed live on 2026-09-17. Two alerts
 * fired as "BUY on Robinhood Chain" for transactions whose selector was
 * 0xa9059cbb — plain ERC-20 transfer() — sending a token INTO the watched
 * wallet. Nothing was bought. They never appeared as trades on his profile
 * because they are not trades.
 *
 * Deltas alone cannot tell the two apart, and that is not a fixable gap: fomo
 * settles from a pooled account, so a REAL buy also shows the token arriving with
 * no quote leg (see the README's account of tx 0x853010bc, +298,050.7 TWINE and
 * no USDG out). Token in, nothing out, describes both.
 *
 * What separates them is the call. A swap goes through a router; nobody buys a
 * token by calling transfer() on the token itself. So the top-level selector
 * decides, and being wrong here costs a skipped signal rather than a wrong buy.
 */
export const TRANSFER_SELECTORS = new Set([
  '0xa9059cbb', // transfer(address,uint256)
  '0x23b872dd', // transferFrom(address,address,uint256)
]);

const lower = (s) => String(s ?? '').toLowerCase();
/** A 32-byte topic word holds an address in its low 20 bytes. */
const topicAddr = (t) => (typeof t === 'string' && t.length >= 42 ? '0x' + t.slice(-40).toLowerCase() : null);

/**
 * Net ERC-20 movement for one owner across a receipt's logs.
 * @returns {Array<{token:string, delta:bigint}>} only tokens that actually moved
 */
export function erc20Deltas(receipt, owner) {
  const me = lower(owner);
  const net = new Map();
  if (!me) return [];

  for (const log of receipt?.logs ?? []) {
    const topics = log?.topics ?? [];
    // Transfer(address indexed from, address indexed to, uint256 value).
    // A 2-topic log is a different event that happens to share a name, and an
    // ERC-721 Transfer carries the id as a third indexed topic with empty data —
    // both would misread as a fungible amount, so require exactly 3 topics.
    if (topics.length !== 3 || lower(topics[0]) !== TRANSFER_TOPIC) continue;

    const from = topicAddr(topics[1]);
    const to = topicAddr(topics[2]);
    if (from !== me && to !== me) continue;

    let amount;
    try {
      amount = log.data && log.data !== '0x' ? BigInt(log.data) : 0n;
    } catch {
      continue; // unparseable data is not a zero transfer
    }
    if (amount === 0n) continue;

    const token = lower(log.address);
    const prev = net.get(token) ?? 0n;
    // A token moving from and to the same owner nets to zero, which is correct:
    // a self-transfer is not a position change.
    const delta = (to === me ? amount : 0n) - (from === me ? amount : 0n);
    net.set(token, prev + delta);
  }

  return [...net.entries()]
    .filter(([, delta]) => delta !== 0n)
    .map(([token, delta]) => ({ token, delta }));
}

/**
 * Classify a receipt for one owner. Mirrors solana.mjs/classifyTrade exactly:
 *   buy / sell  — a non-quote token's balance changed
 *   funding     — only quote currency moved
 *   null        — nothing of ours moved, or the transaction failed
 */
export function classifyRhTrade(receipt, owner, quoteTokens = QUOTE_TOKENS, call = null) {
  // A reverted transaction moved nothing. `status` is '0x1' on success; treat
  // anything else, including a missing field, as not-a-trade rather than
  // assuming success on an incomplete receipt.
  if (!receipt || receipt.status !== '0x1') {
    return { side: null, token: null, amount: 0n };
  }

  const deltas = erc20Deltas(receipt, owner);
  if (!deltas.length) return { side: null, token: null, amount: 0n };

  const subject = deltas.find((d) => !quoteTokens.has(d.token));
  if (subject) {
    // NOT A PURCHASE, on either of two counts.
    //
    // A direct transfer() is a token moving rather than being bought — that is
    // the case seen live on 2026-09-17.
    //
    // And a transaction whose TARGET is the token that arrived cannot be a
    // purchase whatever method it called: you do not buy a token by calling the
    // token. That catches a claim, a mint, a vesting release and anything else
    // the token contract itself hands out, none of which the selector rule sees.
    //
    // Reported as what it is so the operator still sees the movement, and the
    // recorder keeps the evidence — but isRhTrade is false, so nothing copies it.
    const selector = lower(call?.selector);
    const targetIsTheToken = call?.to && lower(call.to) === subject.token;
    if (call && (TRANSFER_SELECTORS.has(selector) || targetIsTheToken)) {
      return {
        side: 'transfer',
        direction: subject.delta > 0n ? 'in' : 'out',
        token: subject.token,
        amount: subject.delta > 0n ? subject.delta : -subject.delta,
        selector: selector || null,
        why: TRANSFER_SELECTORS.has(selector) ? 'transfer-selector' : 'target-is-the-token-itself',
      };
    }
    return {
      side: subject.delta > 0n ? 'buy' : 'sell',
      token: subject.token,
      amount: subject.delta > 0n ? subject.delta : -subject.delta,
    };
  }

  const biggest = deltas.reduce((a, b) =>
    ((a.delta < 0n ? -a.delta : a.delta) >= (b.delta < 0n ? -b.delta : b.delta) ? a : b));
  return {
    side: 'funding',
    direction: biggest.delta > 0n ? 'in' : 'out',
    token: biggest.token,
    amount: biggest.delta > 0n ? biggest.delta : -biggest.delta,
  };
}

/** True only for a real position change — what the executor may act on. */
export const isRhTrade = (t) => t.side === 'buy' || t.side === 'sell';
