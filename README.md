# First Fill

Watches a roster of fomo traders on-chain, reports every trade within
milliseconds of it becoming public, and — on Robinhood Chain — copies their buys
into a wallet of your own, at a size you configure.

The race this wins is **against their followers, not against them.** Both chains
make front-running the trader himself structurally impossible: Robinhood Chain's
sequencer is first-come-first-served with no public mempool and no fee bidding,
and Solana has no mempool at all. What is winnable is the gap between his fill
becoming public and his ~4,157 followers acting on a phone notification, which is
3–60 seconds. This closes that gap to about a second.

---

## What we established about the target

`ruralvalidsnake` → `userId ea701496-1d0b-51bf-9842-8edf50262af1`, resolved via
fomoapi and verified against the chains directly:

| | |
|---|---|
| Solana | `3owNGvPDRmgdTSBkp8ro2d5zBJCpnGi4nDhSkpgpqXeZ` |
| EVM | `0xb054643d9446d778511be5ed8f46d349b8ecc2c0` |
| Account age | 17 days at first contact (created 2026-08-26) |
| 75 trades · 211 swaps · $58,022 volume · 4,157 followers | avg hold ~11h |

**His EVM account is an EIP-7702 delegated ERC-4337 smart account.** `eth_getCode`
returns `0xef0100e6cae83bde06e4c305530e199d7217f42808555b` — the `0xef0100` prefix
is the 7702 delegation designator, pointing at `0xe6cae83b…08555b`, whose bytecode
carries `validateUserOp` (`0x19822f7c`) and `executeBatch` (`0x34fcd5be`).

Consequences, and they are not small:

- **nonce 1, balance 0.** He has sent exactly one transaction ever — the 7702
  authorization. He does not send his own trades and holds no gas.
- His EVM trades arrive as `handleOps` calls from a **bundler**, with his address
  inside the calldata as `userOp.sender`. **Matching on `from` would never fire.**
  The matcher's calldata path is the one that carries this, and it records `via`
  so the assumption stays checkable. Confirmed live: his first Robinhood Chain
  trade alerted with `matched calldata`.

### We cannot see what he spends, only what he receives

His first real Robinhood Chain buy, read off the chain on 2026-09-14:

```
tx 0x853010bcb9c73fbc5ad70fd2ee203799e8153495548b1e3384de5c101df38e71
block 62,359,305   status OK   35 logs   router 0xccc88a9d…c315be
his net ERC-20 movement: +298,050.70903 TWINE      (one token, inbound)
                          no USDG out              (no quote leg at all)
worth ~$848 at the time
```

Only the token he received moves through his address. fomo settles **one USD
balance across six chains** and pays from a pooled account — the same shape as
his Solana history, where 19 of 25 recent signatures were USDC transfers into an
omnibus account holding ~481,000 USDC.

So a bot cannot mirror his position size by reading it; the dollars never touch
his wallet. It can only be *derived*, by pricing what he received. **This is why
the trade size is yours and not his**, and it is a design consequence rather than
a simplification.

---

## The executor

On a Robinhood Chain buy: take the contract address he bought, and buy the same
token with a fixed dollar size from `config.json`.

```
sequencer feed  →  roster match  →  alert (immediately, ~400ms)
                                 ↓
                     receipt → classifyRhTrade → is it a buy?
                                 ↓
                     policy gate → quote → build → verify → SIMULATE → send
```

### Routing goes through an aggregator, and that was measured, not assumed

Every assumption checked before writing a line of executor, and **every one was
wrong**:

| assumed | reality, measured 2026-09-14 |
|---|---|
| Uniswap v3 | a pool exists, `liquidity() == 0`, a real quote **reverts `SPL`** |
| fee tier 3000 | only 10000 exists |
| paired with WETH | paired with **USDG** |
| Uniswap | his own fill hit v4 ×4; Kyber's best route is **`ramses-v3`** |

A hand-rolled v3 executor would have reverted on every trade. Robinhood Chain
volume is roughly half Uniswap v4, a third v3, then Pons and PancakeSwap, so a
single-venue executor covers a fraction of where he can trade and needs rebuilding
the first time he trades somewhere else. KyberSwap's aggregator is the only
approach that does not need redoing per token.

### What stops the aggregator being a hole

It hands back both a contract to call and the bytes to call it with, so a wrong
or hostile response is a wrong or hostile transaction. Four bounds:

1. **The router is pinned** to a constant; any other address is refused outright.
2. **Approvals are exact** — one trade's input, never infinite — so the worst case
   of anything going wrong is that one trade.
3. **A build materially worse than its quote is refused.**
4. **The swap is simulated and our own balance must rise**, or nothing is signed.

The fourth is the one that matters, because the first three do not stop the real
router sending the output somewhere else. `eth_simulateV1` is available on this
chain and returns per-call `status`, `gasUsed`, `logs` and `returnData`, so the
executor reads `balanceOf` immediately before and after the swap *inside one
simulated block* and compares. Balances, not logs: a Transfer log is the token's
own claim that it moved something; `balanceOf` is the storage the next
transaction will read.

Proven end-to-end, read-only, against live state:

```
$25 → quote 8,929.905 TWINE · floor 8,662.008 · simulated 8,929.905 · spend exactly 25.000000 USDG
build redirected to another recipient → refused: short-receipt (received 0, floor 8,661.998)
```

### Two floors, and they are not the same one

- The **on-chain** floor is inside Kyber's calldata, derived by them from the
  `slippageTolerance` we send. Measured on real builds: word 211 of the swap
  arguments held `3567555826670237273239` at 1bps and `1783956308966015238143`
  at 5000bps — each `amountOut × (1 − slip)` less one unit of rounding. It is
  what protects us when state moves between simulation and inclusion.
- **Our** floor is computed locally from the **quote**, never the build, and
  checked against the simulated balance delta. A degraded or hostile build
  cannot lower the bar it has to clear.

Both are needed, and the first belongs to a third party, which is reason enough
not to rely on it alone.

### One big buy

`sizeUsd 450`, `maxOpenPositions 1`, `useFullBalance true` makes the bot take a
single position for the whole wallet. Two things measured before choosing that
shape, because both are counter-intuitive:

**Gas is not a factor and congestion does not change it.** The block gas limit is
1,125,899,906,842,624 and the busiest block sampled used 14,713,338 — six orders
of magnitude of headroom. The base fee over 1001 blocks ranged 0.0707–0.0758 gwei,
a 1.07× spread. And the sequencer is first-come-first-served with **no fee
bidding**, so paying more cannot buy a better place in the queue. Budget nothing
for a gas war; there is no auction to win. What competes on a launch is latency.

**Price impact is the real constraint, and it is the quote that carries it.** Same
token (TRUTH, the thinnest fresh pool sampled 2026-09-14), by size:

```
  $ 25   -0.56%        $100   -3.62%        $300  -10.88%
  $ 50   -1.62%        $150   -5.56%        $450  -15.63%   ($70 gone on entry)
```

Kyber's quoted `amountOut` already includes this, so `slippageBps` is NOT what
protects against it — slippage only covers movement between the quote and the
fill, a window of about a second. On a launch with many buyers that window can
exceed 3%, and the trade then reverts rather than filling badly. A refusal, not a
loss, but a miss.

### Keeping connections warm — and what is NOT established about it

`warmupMs` (default 15s) probes the aggregator and the RPC on a timer. Its proven
job is **reachability**: a failing probe says the aggregator is down before a
signal needs it rather than during one.

It was built for latency, and that part is **not established**. The cold penalty
is real and measured — 413ms warm against 1631ms after 60s idle — but an
alternating A/B of the whole buy path came out ambiguous:

```
off  1506 / 1417 / 1425 / 8252 ms   median 1506
on   1157 / 1925 / 1566 / 2861 ms   median 1925
```

Medians favour off; worst cases favour on, and the 8252ms outlier is on the off
side — exactly the blowup warming is meant to prevent. Four pairs cannot separate
those. There is also a confound: the box those numbers came from routes HTTPS through a proxy,
which owns the connection to the aggregator, so a client-side keep-alive cannot
reach the hop that costs. **A production box with a direct connection has not been
measured.** Do not repeat the latency claim until it has.

### What a launch actually does, measured

2,150 pools were created on this chain in 19 hours. **253 had any trading at all
in their first minute** — most launches are dead on arrival. Of the ones that
traded, price movement was sampled from the `sqrtPriceX96` carried by every v4
`Swap` event, so these are exact per-swap prices rather than candles.

**Slippage.** Across 19,143 separate 1.2-second windows (the real quote→fill gap)
in 205 launches, the median move inside one window is 1.29% — but the tail is
long, p90 22.63% and p99 70.23%. The share of trades that would simply not fill:

```
   3% floor -> 41.4% miss        10% floor -> 24.1% miss
   5% floor -> 34.7% miss        15% floor -> 17.1% miss
   8% floor -> 27.5% miss        20% floor -> 11.9% miss
```

A miss costs nothing but the opportunity — the floor refuses, the money stays.

Note the metric: an earlier version of this measured the WORST window in each
launch and reported a 3% floor breaching 60% of launches. That overstates it,
because a trade occupies one window rather than the worst one. Measure per
window, not per launch.

**And what happens to the position.** From an early entry, 30 seconds later the
median launch is **-2.8%**, and only 40% are up at all; at 60 seconds 180 of 253
are down. That is every launch on the chain, NOT specifically launches by an
account with a following — which is the entire premise of this bot and is exactly
what the recorded signals exist to test. It is not evidence the strategy fails.
It is evidence that nothing here should be sized on hope.

### Catching a launch

A launch is tradeable the instant its pool is created, but the aggregator has to
index it first — so asking once means asking at exactly the wrong moment. Measured
2026-09-14 by watching pools from the block they were created in and polling until
a USDG route appeared:

```
BLAST 1s · SYNAPSE 1s · Starlink 1s · SUSUTA 1s · NFS 2s · PNL 3s · TRUTH 4s · SKNT 7s
```

Seconds, not minutes — so `quoteRetryMs` (default 15s) re-asks until it routes.
That is what makes a launch catchable at all: his followers act in 3–60 seconds,
so arriving at 7 is still ahead of them, and arriving never is not.

Two costs, neither hidden. Entries are serialised, so a token that never routes
holds the queue for the whole window — the uncommon case, and the common one
returns on the first attempt having slept not at all. And a fill 7 seconds into a
launch is worse than one at 1 second; the window is configurable because that
trade — price against getting in at all — is an operator's call. Set it to `0` for
the old ask-once behaviour.

Not every no-route is lag. **T1**, sampled the same day, never routed: a pool
paired against native ETH with **3 transfers in its entire existence**. Nothing
can buy it, us included, and refusing is correct rather than a miss.

### Latency

Warm path, measured from a proxied box outside the target region:

```
getTokenBalance   91ms
quote            440ms   ← Kyber
build            539ms   ← Kyber
getAllowance      50ms
simulate          70ms   ← the entire safety check
getGasPrice      101ms
getNativeBalance  52ms
TOTAL          1,344ms
```

73% is the aggregator's API. **The simulation costs 70ms** — the safety is
effectively free. Running the three cheap reads in parallel would save ~190ms and
give up the cheapest-refusal-first ordering; not worth it at these proportions,
and it should be re-measured on the Ohio VM before anyone decides otherwise.

---

## Configure it

```jsonc
"executor": {
  "enabled": false,          // true to arm the pipeline at all
  "paper": true,             // signs nothing; every other gate still runs
  "rpcUrl": "https://rpc.mainnet.chain.robinhood.com",
  "wallet": "0x…",           // the address we trade from
  "quoteToken": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",  // USDG
  "sizeUsd": 25,             // what WE spend per copy — nothing to do with his size
  "useFullBalance": false,   // treat sizeUsd as a CEILING: spend up to it, or the whole
                             // balance if that is lower. Off by default, because for a bot
                             // meant to take several positions "spend it all" is wrong.
  "warmupMs": 15000,         // keep the aggregator connection hot; 0 disables
  "slippageBps": 300,
  "quoteRetryMs": 15000,     // keep re-asking this long when a pool is too new to route; 0 = ask once
  "maxOpenPositions": 3,
  "cooldownMs": 60000,
  "denylistTokens": []
}
```

`sizeUsd` can also be set per roster entry, which overrides the default — so one
trader can be $50 and another $10.

**The signing key is never in the config file.** It is read from
`FIRSTFILL_PRIVATE_KEY` and nowhere else, and a key found in the config is a
startup failure rather than a warning. If a key is set, its address must equal
`executor.wallet` or the process refuses to start — otherwise a mistyped address
means every simulation reads one wallet while every signature comes from another,
which does not throw, it just trades where nobody is looking.

`--paper` on the command line forces paper regardless of the file. There is
deliberately no flag in the other direction.

### Making the wallet

```sh
npm run new-wallet      # prints an address and a key, writes nothing to disk
node scripts/configure-executor.mjs 0xTheAddressItPrinted
```

The second command writes only the executor block and leaves the rest of
`config.json` alone. It refuses a 64-character private key pasted where the
40-character address belongs — both start `0x`, the only visible difference is
length, and without that guard the key lands in the one file this whole design
exists to keep it out of.

Use a **fresh** wallet, not one you already hold funds in. The key has to live on
the server, so whatever is in that wallet is the most you can lose if the server
is ever compromised — and the position limits mean it only ever needs
`sizeUsd × maxOpenPositions` plus gas.

The key goes in a root-only env file and is pointed at from the unit, so it never
appears on a command line where `ps` would show it to every user on the box:

```sh
sudo install -m 600 /dev/null /etc/firstfill.env
sudo tee /etc/firstfill.env >/dev/null <<'ENV'
FIRSTFILL_PRIVATE_KEY=0x…
ENV
```

```ini
[Service]
EnvironmentFile=/etc/firstfill.env
```

Never paste a key into a chat, an issue, a commit, or `config.json`. The bot
refuses to start if it finds one in the config, and `config.json` is gitignored —
but neither of those helps once a key has been pasted somewhere that keeps logs.

**Paper mode still needs the wallet funded.** The simulation reads real balances,
so a dry run from an empty wallet refuses at `insufficient-input-balance` and
proves nothing. A paper run against a funded wallet is a full rehearsal: quote,
build, router pin, simulation, balance check, gas — everything except the
signature.

---

## Controlling it from Telegram

```
/status      is it alive, what is it watching, what does it hold
/pause       stop opening new positions
/resume      start again
/positions   what it currently holds

/traders     who is being copied
/add         /add <handle> <address> [<address>]
/remove      /remove <handle>
/help
```

**Editing the watch list from a phone.** `/add` takes a handle and one or two
addresses; the chain is worked out by decoding each one, not by pattern-matching
its length. Both chains take effect immediately — the EVM roster hot-reloads, and
Solana subscriptions are added to and dropped from the LIVE socket, so an added
trader is watched on both chains without a restart.

`/remove` **disables rather than deletes**: the entry holds addresses that were
researched and notes explaining things like a 4337 account matching on calldata,
and throwing that away because somebody typed `/remove` on a phone is not
recoverable from the phone. `/add` of the same handle switches them back on, and
re-adding MERGES, so correcting one address does not wipe a size or notes.

**The last trader cannot be removed.** `loadConfig` requires at least one watched
address, so removing the only one would write a config the bot refuses to load —
and the failure would surface at whatever unrelated moment it next restarted.
The reply points at `/pause`, which is what that person wants.

**What validation can and cannot catch.** An EVM address carries a checksum in
its capitalisation, so a mistyped one is refused. A Solana address carries none:
any 32 bytes is syntactically valid, so a typo that still decodes to 32 bytes is
indistinguishable from a real address — deleting the FIRST character of a
44-character address does exactly that, measured. Shape is a floor, not a
guarantee, so on `/add` the bot asks the chain whether the address has ever been
used and says so. It reports rather than refuses: a real trader may have a fresh
wallet, and on Robinhood Chain a fomo trader's own nonce is often 0 because a
bundler sends their trades.

**Exactly one chat may command it.** A Telegram bot can be messaged by anyone who
knows its username, so `telegram.chatId` is the only thing between a stranger and
the pause switch on a bot holding real funds. Ids are compared as STRINGS: a chat
id is a 64-bit integer, and two different ids past 2^53 collapse to the same
JavaScript number — a numeric compare would admit the wrong chat. An unauthorised
message gets no reply at all, because answering confirms the bot is live to
anyone probing usernames.

**A pause survives a restart.** It is written to `data/control.json` and restored
before the feed is wired, so there is no window in which a paused bot takes a
position because it had not read the file yet. Without that, a pause given from a
phone would be silently undone by the next reboot — at exactly the moment nobody
is watching.

**Pause stops new entries. It does not close anything already open**, and every
reply says so, because the gap between what pause does and what someone reaching
for it in a hurry assumes it does is where money is lost.

**Stale commands are discarded by their own timestamp**, not by which poll saw
them. Telegram holds undelivered updates for 24 hours, so a bot that has been down
replays everything it missed — and a `/resume` sent yesterday acting today is the
dangerous direction of that. The 30-second grace covers clock skew and means a
command sent *during* a restart is still honoured.

The first version decided this by poll instead, and it was wrong in a way that
made the feature look broken rather than unsafe: the empty-result check ran before
the update offset was set, so an idle first poll left the offset unset and the
next batch — arriving minutes later with a real command in it — was still treated
as the backlog. **The first command ever sent was always eaten.** Found by sending
`/help` to a freshly started bot and getting silence.

## Run it

Needs Node 22+ (for the built-in WebSocket).

```sh
npm install
cp config.example.json config.json   # fill in Helius, Telegram, and the executor block
npm test                             # 333 offline assertions, no network
npm run paper                        # detect + decide + simulate, sign nothing
npm start
```

Robinhood Chain needs no key. A free Helius key covers the Solana side.

---

## What it tells you, and what it doesn't

One JSON object per line into `data/signals.jsonl`. `signal` lines are roster
hits; `entry`, `entry-paper`, `entry-refused` and `entry-skipped` are the
executor's decisions with the full plan attached; `heartbeat` proves liveness
while the roster is quiet, so "nothing happened" never looks like "nothing is
running". A stalled RH feed, a sequence gap and a dead Solana socket all alert.

What this **cannot** yet tell you is whether the follower effect is real for this
trader — how much the crowd moves price after a fill, and for how long. That is
what the recorded entries are for, and it is what should decide sizing.

### Known limits — read these before arming it

- **There is no exit.** `positions.mjs` holds the exit ladder and is tested, but
  nothing is wired to it. The bot buys and holds; selling is manual today.
- **`maxOpenPositions` is therefore a one-way budget.** `openCount` only ever
  goes up, so after N copies every further signal is skipped until the process is
  restarted. That is a deliberate bound rather than an oversight, but know that
  it is the real stop.
- **`dailyLossLimitUsd` is inert** for the same reason: realised P&L is only
  known on an exit, and there are none. Do not treat it as a working limit yet.
- **Only buys are copied.** A sell by him is classified, recorded and alerted, and
  acts on nothing.
- **The sellability gate is not in the entry path.** `sellability.mjs` exists and
  is tested; the simulation catches a token that cannot be bought, not one that
  cannot be sold. Wiring it is the next piece of safety work, and the strongest
  version reuses this same simulation to buy and sell back in one block.
- **The launch rule cannot fire on Robinhood Chain.** The policy refuses to copy a
  trader into a token they created, but nothing here resolves a token's creator on
  this chain, so that rule is currently dormant.
- **Native currency in or out is refused**, not handled. Our input is always a
  configured ERC-20 stablecoin, so that path would be untested code guarding real
  funds.
- **RH feed events are provisional**: a compliance filter inside the sequencer
  voids roughly 150 transactions a day with no published criteria. The executor
  works from the receipt rather than the feed sighting, which is why.
- The calldata match is a substring test. It cannot produce a false negative, but
  an address appearing in unrelated calldata would be a false positive — which is
  why `via` is recorded. **This happened live on 2026-09-17**: two transactions
  alerted as `BUY on Robinhood Chain` were plain `transfer()` calls moving a token
  INTO the watched wallet. Nothing was bought, and they never appeared as trades
  on his profile because they are not trades. See below.
- **A token arriving is not a purchase, and deltas cannot tell the difference.**
  A real buy has no quote leg — fomo pays from a pooled account — so "token in,
  nothing out" describes both a buy and a gift. The only thing that separates them
  is the call: a swap goes through a router, and nobody buys a token by calling
  `transfer()` on the token itself. The classifier now takes the top-level
  selector and refuses to call `transfer` / `transferFrom` a trade. Being wrong
  there costs a skipped signal rather than a purchase nobody asked for.
- **Solana is fixed the same way, by a different signal.** There is no selector to
  read, so `classifyTrade` asks whether any program outside Token / Token-2022 /
  ATA / System / ComputeBudget / Memo was invoked at the TOP level. A swap always
  reaches a venue; a transfer or an airdrop does not. Inner instructions are
  ignored on purpose — a swap is *made of* token transfers, so reading those
  would demote every real trade.
- **The venue whitelist closes that, and is OFF by default.** `executor.venues`
  lists contracts that count as trading venues. With it set, a purchase must go
  through one; a token arriving any other way is `received` and never copied.
  Matched against the transaction target AND every log emitter, because his
  trades arrive via a bundler whose target is an entry point rather than a
  router. **The addresses are deliberately not in the source**: fomo's router is
  proprietary and redeployable, and a hardcoded one would stop copying real buys
  the day it changed. Read them off a known-good buy with
  `npm run find-venues -- <txHash>`.
- **An unmatched arrival is loud, not silent.** "He was airdropped something" and
  "fomo redeployed their router" look identical to the classifier, and only a
  human can tell them apart — so the bot says so and names the transaction to run
  `find-venues` on. Missing a buy while being told is survivable; missing one in
  silence is not, which is the whole reason the whitelist is opt-in.
- **WHAT IS STILL NOT CAUGHT WITHOUT IT, on either chain.** Two rules now refuse a "buy": a
  `transfer`/`transferFrom` selector, and a transaction whose target is the token
  that arrived. Neither sees a token arriving from a **third-party contract** —
  an airdrop distributor, a vesting escrow, a rewards claim, a bridge. Those
  invoke a contract that is not the token, so they still read as a buy.
  Distinguishing them needs a whitelist of venues that count as trading, which is
  not built: fomo's router is proprietary and can be redeployed, and a stale
  whitelist would stop copying real buys silently. **So the classifier is better
  than it was and is not airtight**, and with the executor live that gap is the
  operator's to weigh.
- **No Telegram control plane yet.** The bot talks; it does not listen. `/pause`,
  `/positions` and a force-exit are not built, so stopping it means stopping the
  process.

---

## Sniping a Meteora launch

A separate tool from the copy-trader above, for a different problem: a token whose
**mint address is known before it launches**, on a Meteora Dynamic Bonding Curve.
Nothing is being copied here. We are racing to be in the first block.

```
npm run snipe -- plan          print every address this will touch; touch nothing
npm run snipe -- prepare       create and fund the account the buy spends from
npm run snipe -- arm --dry     watch a real launch, build the buy, send nothing
npm run snipe -- arm           watch, and buy the instant the pool exists
```

### Why it can be fast

A DBC pool is tradeable the moment its `VirtualPool` account is written, and that
account's address is a PDA of `(config, base mint, quote mint)`. So it is known
while the pool is still nothing — and so is everything hanging off it:

```
pool           PDA["pool", config, bigger mint, smaller mint]
base vault     PDA["token_vault", base mint, pool]
quote vault    PDA["token_vault", quote mint, pool]
our accounts   the usual associated-token-account derivation
```

Which means the entire transaction can be compiled and **signed before the token
exists**. It is re-signed in the background whenever the blockhash rolls, so what
remains at the moment of the launch is a socket write. The buy is 688 bytes — one
packet, no lookup tables.

Routing through Jupiter instead would repeat a mistake this repo already measured
on the other chain: an aggregator cannot quote a pool it has not indexed, and
indexing a new pool took **1 to 7 seconds** in the sample under "Catching a
launch" above. The whole point is to be inside that window, so the swap goes
straight at Meteora's program.

### When the config cannot be known at all

Some launchpads generate a **fresh config keypair per launch**, in the same bundle
that creates the pool. Measured on bagr, 2026-09-16: `Keypair.generate()` per
launch, with a UNIQUE index on `config_address` in their database asserting no two
launches share one. Where that is true the pre-signed path is simply unavailable —
not slower, unavailable — and `snipe.config` must be left `null`.

Do not paste in a config read off some earlier token. The pool derived from it is
a real address belonging to a different pool, and the snipe would be aimed at it.
The bot detects this (the mint matches, the pool address does not), throws the
plan away and rebuilds from the live pool rather than refusing — because refusing
there means refusing to buy the right token at the only moment it can be bought.
But it is wasted work mid-race, and the fix is to not arm with a stale config.

What IS knowable in advance on such a launchpad, and worth setting, is everything
that is constant across its launches: the quote mint and `baseTokenProgram`.
`find-config` reads both off any earlier launch. With them set, the discovery path
fetches **nothing** at fire time — the pool account arrives inside the trigger
notification carrying its own config and both vaults.

### Two triggers, because they fail differently

| trigger | needs | carries | fails when |
|---|---|---|---|
| `accountSubscribe` on the derived pool | the config | nothing but "it exists" | the config is unknown |
| `programSubscribe` + memcmp on `base_mint` | nothing | the pool's whole account | the provider disables it |

Whichever speaks first wins and the other is ignored for that launch — a repeat is
dropped, so both firing does not buy twice. The `programSubscribe` filter matches
`base_mint` at byte 136 of a 424-byte account, which means the notification itself
delivers the config and both vaults: on that path nothing has to be fetched after
the trigger. **A wrong offset there would not throw.** It would watch nothing,
forever, looking exactly like a launch that had not happened yet, which is why the
test recomputes it from Meteora's IDL rather than trusting the number.

### Several wallets, one launch

A snipe can be split across wallets, each with its own size:

```json
"wallets": [
  { "label": "w1", "keyEnv": "FIRSTFILL_SOLANA_KEY",   "amountIn": "150000000" },
  { "label": "w2", "keyEnv": "FIRSTFILL_SOLANA_KEY_2", "amountIn": "80000000"  },
  { "label": "w3", "keyEnv": "FIRSTFILL_SOLANA_KEY_3", "amountIn": "45000000"  }
]
```

Keys are named, never stored: each entry gives the ENVIRONMENT VARIABLE holding
that wallet's key. A key in the config file is a startup failure, as before.

They share one subscription — the trigger is a property of the mint, not of who
is buying — and they share the pool facts derived from it, so five wallets cost
four PDA derivations rather than twenty. What is per-wallet is small: two token
accounts, an amount, a signature.

**Each wallet succeeds or fails on its own.** Three filling and two missing is a
normal outcome, and `settled` reports every wallet by name with its state,
signature and slot. Reporting one total would hide which wallets hold the token.

A wallet short of wrapped quote or native SOL is **dropped at arm time with a
warning**, not treated as fatal — four of five is still a snipe, and firing a
fifth that cannot pay its own fee is not. Arming refuses only when no wallet is
usable. `plan` reports the shortfall per wallet before you commit anything.

Every wallet needs its own native SOL, not just its own wrapped balance: the
token-account rent and the fee come out of plain lamports, about 0.0021 SOL plus
the priority fee, per wallet.

**Bidding, and why order is not random.** Wallets racing one launch all write the
same pool account, so Solana cannot execute them in parallel — the block takes
them in fee order. `computeUnitPriceMicroLamports` on a wallet overrides the
global bid, which is how you decide which of your own wallets fills first when
not all of them fit in the first block. Each wallet's native-SOL requirement
follows its own bid, and `plan` prices every wallet separately rather than
quoting one figure.

The aggregate is barely affected by the internal order — the curve gets walked
the same distance either way — so this matters when the block is contested and
some of your wallets may not make it, not when all of them land.

**What splitting does not do.** If the aim is to not read as one buyer, the bot
cannot deliver that by itself. Five wallets buying one token in one block is
itself a pattern, and funding them from one source links them in a single hop on
any clustering tool. Different sizes help; common funding or synchronised timing
does not. Independent funding paths are the part that matters, and they happen
outside this repo.

### Everything is checked against Meteora's own SDK

`src/meteora/dbc.mjs` hand-rolls the swap rather than calling
`@meteora-ag/dynamic-bonding-curve-sdk`, because the SDK's `buildSwap` fetches the
pool and the config over RPC on every call — round trips inside the window we are
trying to win. The SDK is still installed, as the **test oracle**: every constant
is recomputed from its IDL, the PDAs are compared against its own derivation
helpers over 40 mint pairs, and the finished instruction is compared byte for byte
against one Anchor builds from the same IDL, all 15 accounts with their signer and
writable flags.

That caught a real bug on the first run: `payer` was marked writable and the IDL
does not declare it `mut`. It would never have shown up in testing, because the
payer is also the fee payer and ends up writable in the compiled message anyway.

### What it refuses to do

- **Arm without the money already in place.** The buy spends from an SPL token
  account, so `prepare` wraps the SOL beforehand. Wrapping inside the snipe would
  put three instructions and a rent payment in the hot path.
- **Arm when the config quotes a different currency** than the one funded — the
  derived pool would be a real address belonging to some other pool entirely.
- **Fire at a pool that is not the one armed for.** The pool states its own mint,
  config and vaults; all of them are compared before anything is sent, and a
  mismatch refuses rather than retargeting.
- **Pick a slippage floor.** `minimumAmountOut` has no default and will not get
  one. `"0"` means "fill me at any price", which on a launch is a defensible
  choice — but it has to be made out loud.

### Known limits — read these before arming it

- **None of this has been run against a live launch.** Every check above is
  offline. The container this was built in cannot reach Solana RPC, `meteora.ag`
  or `jup.ag` at all, so nothing here has touched mainnet. `plan` and `arm --dry`
  exist to be run on the real box, against the real mint, before any money is on
  the line.
- **The latency is unmeasured.** The design removes work from the hot path; it
  does not prove a number. There is no figure here comparable to the 1,344ms
  measured for the EVM path, and there will not be until it runs on the VM.
- **The compute budget defaults are guesses.** 250,000 CU and 1,000,000
  micro-lamports per CU are placeholders. Read what the first fill actually used
  and tighten both — the priority fee is paid on a failed transaction too.
- **There is no exit.** Same as the rest of this repo: it buys and holds. Selling
  is manual.
- **Sniping the first block does not mean a good fill.** Being first on a bonding
  curve means the highest price on it. That is a strategy decision this tool does
  not make and cannot improve.
- **The fee schedule is aimed at you, and it is not small.** A DBC config can set
  a base fee that starts at `cliff_fee_numerator` — its highest value — and steps
  down over time. Period 0 is the launch instant, so a first-block buyer pays the
  maximum by construction. `find-config` prints the real schedule off any earlier
  launch by the same launchpad, including what waiting would have saved. **Read it
  before deciding the race is worth running**, because on some configs the
  anti-sniper fee costs more than the latency wins.
- **`programSubscribe` is not universally available.** Some providers disable it,
  and some refuse `processed` on it. If it is refused, the run says so and the
  launch rests entirely on `accountSubscribe` — which needs the config. Without a
  config and without `programSubscribe`, there is no trigger at all.
- **One mint per process.** Arming is per-token by design; two launches means two
  processes.

---

## The pump.fun sniper

> Not the same bot as the Meteora DBC sniper above. pump.fun's bonding curve
> (`6EF8rrec…wF6P`) and Meteora's DBC (`dbcij3LW…SMaqN`) are unrelated programs
> with different account layouts and different instructions, so **neither sniper
> can trade the other's launches**. They share this repo, the wallet rules and
> the Telegram poll loop, and nothing else.

A second, separate bot: `npm run snipe`. Five wallets buy one pump.fun launch in
a single Jito bundle, at contract addresses known in advance. It shares nothing
with the copy-trader but the repo — different entrypoint, different config block,
different keys — because a config that can arm five funded wallets should not be
the same file that turns on a watcher.

```
config CAs  ->  derive bonding curve PDA  ->  accountSubscribe (processed)
                                                      |
                                       the curve account is created
                                                      |
                              decode -> re-plan -> build -> sign -> one bundle
```

### Knowing the address in advance removes the entire discovery step

The usual shape is: watch the program's logs, see a create, fetch the transaction
back to learn which mint it was, then quote it. That is two network round trips
spent learning something we were already told. None of them are here. A bonding
curve's address is `findProgramAddress(["bonding-curve", mint])` — a pure
function of the mint that does not need the account to exist — so we subscribe to
the exact address before the launch and are handed the account data in the
notification that announces it. **Nothing is fetched between the launch and the
bundle.** Measured: 45.7ms to build and sign all five transactions.

### Everything here was read off the chain, not off a blog

Every constant was verified against mainnet on 2026-09-18 before a line was
written, and two widely-copied values were wrong:

| | claimed | actual |
|---|---|---|
| fee | 100 bps | **95 bps**, read from Global at byte 105 |
| rounding | floor the output | **ceil the new reserve** — differs by one raw unit |

The fee is read from the chain at boot rather than hardcoded at all. The
initial reserves (`30 SOL` / `1.073e15` tokens) likewise come from the Global
account, which is what makes the pre-launch plan possible.

### `buy` does not take a minimum out, and this is where snipers die

pump.fun's buy is `(amount, max_sol_cost)` where **`amount` is the exact number
of tokens you receive** and `max_sol_cost` caps the SOL. It is not a minOut, and
the orientation is the reverse of every EVM router. Verified by decoding real
buys: tokens received `=== amount`, exactly, every time.

So `minTokens = 1` — which is what a sniper reaching for "accept any fill"
naturally writes — does not mean "accept any fill". It means **buy one raw token
unit**, 0.000001 of a token, and spend nothing. A bot written that way does not
fill badly; it does not fill at all.

Our protection runs the other way round: `max_sol_cost` is the wallet's budget,
full stop, and `slippageBps` shaves the *token amount requested* to leave
headroom. If someone lands ahead of us the price rises, our fixed request costs
more SOL, and the cap absorbs it up to the shave. Past that the bundle reverts
and nothing is spent — a miss, not a loss. **No wallet can spend more than its
configured budget, whatever the RPC says**, which is what bounds the damage if
the curve data we are handed is wrong or hostile.

### Most pump.fun mints are Token-2022, and assuming otherwise fails the buy

Sampling 18 mints the pump program had just touched, on 2026-09-18:

```
  Token-2022        16
  classic Token      2
```

The two programs derive **different** associated token addresses for the same
owner and mint. So a sniper that assumes the classic program — which is the
common shape, and what this code did in its first version — builds a buy against
a token account that does not exist and passes the wrong program account. The
transaction fails outright: the tip is spent and the bundle lands nothing.

The token program is therefore read from the mint account's owner, never
guessed, and a mint owned by neither is refused rather than defaulted. To keep
that off the fire path, the mint account is subscribed alongside the bonding
curve — at a launch both are created in the same transaction, so the answer is
normally cached before the trigger arrives. When it is not, one read resolves it,
which is worth the round trip because the alternative is a guaranteed failure.

### The bundle goes through Helius Sender, not Jito's public endpoint

Five wallets, five transactions, one atomic bundle — all five fill or none do.
That is what every trading terminal does, and it is right: Solana caps a
transaction's instruction trace at **64 invocations**, and a pump.fun buy costs 8
while its token-account create costs 5. Measured from a real landed transaction:

```
invocations per instruction:  1, 1, 5, 8, 5, 8, 5, 8, ...
                              ^  ^  ^  ^
                     compute budget  |  +-- pump buy      = 8
                                     +----- ATA create    = 5
```

Five wallets in ONE transaction is `2 + 5x13 = 67`, and it fails with
`MaxInstructionTraceLengthExceeded`. Split across five transactions, each gets
its own 64-invocation budget and spends 13.

**But the bundle has to reach a block.** Three bundles posted to Jito's public
block engine were accepted by five relays, given a bundle id, and silently
discarded: status `Invalid`, never `Pending`, nothing on chain. A probe reduced
that to a 217-byte transaction containing nothing but a tip, sent to one relay,
and it was dropped the same way — so nothing about what we send was ever the
cause. Unauthenticated submission is not honoured.

What that probing did establish: Jito's ingress rejects a malformed bundle with
HTTP **400 and a named reason** — "transaction is invalid", "must write lock at
least one tip account", "exceeded maximum number of transactions". So a 200 with
an id proves signatures, tip presence, tip write-lock, count and wire format are
all correct. An expired blockhash and an unfunded payer *also* return 200 and an
id before going `Invalid`, which is why that response carries no information.

**Helius Sender** takes the identical bundle format, forwards it across every
fast pathway including Jito, runs on **any Helius plan** and consumes **no API
credits** — the cost is the tip. It also validates synchronously, so a bad
bundle comes back with a reason instead of vanishing. And it answers with a real
transaction **signature**, which can be confirmed against the chain, rather than
a bundle id that could only be asked about through an API that said `Invalid` for
everything.

The tip must be at least **0.001 SOL** and goes to a **Helius** tip account —
a different list from Jito's, and a tip to the wrong one is money thrown away.
Below the minimum the bundle skips the priority buffer and takes fewer pathways,
which defeats the point on a launch, so startup refuses it.

### Five buys in one bundle move the curve against each other

The five buys execute in order inside one transaction, and a transaction is
all-or-nothing, so one reverting buy reverts the other four.

Which means each leg has to be priced against the curve **the leg before it
leaves behind**, not against the pre-launch state. Quoting all five against the
fresh curve makes the last wallet ask for more tokens than the curve can then
give at its cap; it reverts, and takes everyone with it. The ladder in
`planLadder` walks the constant product forward across the five buys.

The cost of this is real and it is not a bug. Against a fresh curve with 9.55 SOL
split across five wallets:

```
  w1   2.6  SOL  ->  84,835,031,144,871 tokens   @ 3.0359e-5
  w2   1.35 SOL  ->  38,966,633,769,213          @ 3.4319e-5
  w3   2.15 SOL  ->  56,088,399,617,717          @ 3.7972e-5
  w4   1.05 SOL  ->  25,050,499,042,606          @ 4.1521e-5
  w5   2.4  SOL  ->  52,299,300,791,530          @ 4.5458e-5
```

**The last wallet pays 49.73% more per token than the first.** You are buying
from yourself, four times. That is the price of the split and it is printed at
startup so it is never a surprise. It scales with how much of the curve you take:
9.55 SOL against a 30 SOL virtual reserve is about a third of it.

Also worth being clear-eyed about: one bundle is the most *obvious* way to do
this. Five buys in consecutive positions of one bundle in one slot is a pattern
anyone reading the block can see. What the uneven split buys you is that the
wallets do not look like one script with one number in it — not concealment of
the bundle itself.

### Keys, and the one mistake that does not announce itself

Wallet N reads `FIRSTFILL_SNIPER_KEY_N` and nothing else. A key in `config.json`
is a startup failure. Every key is checked against the address written in the
config, because a mistyped address does not throw on its own — it would plan
against one wallet and sign with another, silently, forever. A duplicate wallet
is refused, and so is a 32-byte seed pasted where the 64-byte secret key belongs
(both are plausible pastes and they produce different addresses, so guessing
which was meant is exactly the class of error this is here to stop).

```sh
sudo install -m 600 /dev/null /etc/firstfill-sniper.env
sudo tee /etc/firstfill-sniper.env >/dev/null <<'ENV'
FIRSTFILL_SNIPER_KEY_1=...
FIRSTFILL_SNIPER_KEY_5=...
ENV
```

### Arming it

`npm run snipe` is paper: it primes from the chain, prints the full ladder,
checks every balance, subscribes, and signs nothing. **There is no config flag
for live mode** — `npm run snipe:live` is the only way, deliberately, every time.

Startup refuses if the per-wallet amounts plus tip, rent and signature fees
exceed `totalSol`. The buys are not the whole cost: each wallet pays
0.00203928 SOL of token-account rent and a 5,000-lamport signature, and one pays
the Jito tip. A split summing to exactly 10 SOL leaves nothing for any of it, and
the shortfall would not surface as a warning — the underfunded leg fails and the
bundle is atomic, so it takes the other four fills with it.

### Driving it from Telegram

The contract address is rarely known when the process starts, so the sniper
boots without one. It primes from the chain, loads the keys, checks the balances
and warms a blockhash, then sits idle — so arming later is a single message and
nothing is set up in the hot path.

```
/status   is it armed, on what, in which mode, is it funded
/target   /target <contract address>
/arm      re-check balances, subscribe, start watching
/disarm   stop watching

/plan     what the five buys will do to the curve
/wallets  addresses, budgets and live balances

/live     spend real SOL
/paper    rehearse, sign nothing
/abort    disarm AND switch to paper, from any state
```

It shares the copy-trader's poll loop rather than running a second one, so it
inherits every fix that loop already carries: the stale-message rule that stops a
`/resume` sent yesterday acting today, the update-offset ordering that used to
eat the first command ever sent, the 409 detection that catches a second copy
running on the same token, and the backoff that stops a bad token hammering
Telegram. Only the command vocabulary differs, injected as `decide`.

**`/arm` re-reads every balance** rather than trusting the check from startup. A
wallet drained since boot would fail its leg, and one failed leg voids the bundle
for all five — so in live mode a short wallet refuses to arm and names the
shortfall.

**Mode cannot change while armed.** Flipping paper→live under a live subscription
means the next write to that curve is handled under rules set for a different
one — which is a real bundle sent by someone who thought they were rehearsing.
Disarm, switch, re-arm. `/abort` does both at once and always lands safe, because
someone reaching for it is not in a position to work out which command they
needed.

**A typo in the address cannot be caught.** A Solana address carries no checksum,
so any 32 bytes is valid and a mistyped CA is indistinguishable from a real one.
What saves you is that a wrong address derives a bonding curve nothing will ever
write, so the bot waits forever rather than buying the wrong token — a miss, not
a loss. The bot says so every time you set a target.

**Credentials live with the keys, not in the config.** The sniper reads
`FIRSTFILL_SNIPER_TELEGRAM_TOKEN` and `FIRSTFILL_SNIPER_TELEGRAM_CHAT_ID` from
the environment in preference to `telegram.botToken` / `telegram.chatId`, because
this token can arm live spending and so belongs in the same root-only file as the
signing keys. The config fields still work, so the copy-trader's convention is
unchanged. A placeholder left unfilled counts as NOT configured rather than
starting a poll loop against a nonsense token — Telegram refuses one of those
immediately instead of long-polling, so the loop would spin.

**Use a second bot, not the copy-trader's.** Telegram allows one `getUpdates`
consumer per token, so pointing both bots at one token makes them fight over the
poll; the loop detects the 409 and says so, but commands become unreliable.

A bot only learns a chat id when someone messages it:

```sh
npm run chat-id      # message the bot first, then run this
```

**The bot token is the key to the wallets.** `/live` and `/arm` are both
reachable from the phone, by deliberate choice, which means anyone who obtains
the bot token or access to that chat can spend the whole budget. `telegram.chatId`
is the only thing in the way. Telegram tokens leak through screenshots, chat
exports and phone backups; treat that token as being exactly as sensitive as the
five private keys, and keep the budget to what you are willing to lose to it.

### Known limits — read these before arming it

- **There is no exit.** Same as the copy-trader: it buys and holds. Selling is
  manual. `max_sol_cost` bounds what you can spend, not what the position is
  worth afterwards.
- **A launch that never happens leaves it armed indefinitely.** There is no
  timeout; the process waits until you stop it.
- **`maxPreBuySol` refuses a curve somebody already moved**, but it cannot tell
  a friendly first buy from a hostile one.
- **Jito bundles cap at five transactions**, which is why five wallets is the
  ceiling and not a preference. A sixth wallet is refused at startup.
- **The tip is not adaptive.** It is a fixed number from the config, not bid
  against the current tip floor, so a contested launch can out-tip it.
- **Only the bonding curve is handled.** A mint that has already graduated to
  PumpSwap is refused rather than routed.
- **One target at a time.** All five budgets go to whichever launch fires first,
  so a second target would be armed against money already spent. Startup refuses
  a config with more than one, and `/target` replaces rather than adds.

## Files that need their test run before you change them

Each has a dedicated offline regression suite. Run it before and after.

| file | suite |
|---|---|
| `src/decode.mjs`, `src/matcher.mjs`, `src/solana.mjs` | `node test.mjs` |
| `src/policy.mjs`, `src/sellability.mjs` | `node test-m02.mjs` |
| `src/positions.mjs` | `node test-positions.mjs` |
| `src/robinhood-trade.mjs` | `node test-rh.mjs` |
| `src/aggregator.mjs` | `node test-aggregator.mjs` |
| `src/executor.mjs`, `src/executor-io.mjs`, the wiring in `index.mjs` | `node test-executor.mjs` |
| `src/control.mjs`, `src/control-io.mjs`, `src/roster-edit.mjs` | `node test-control.mjs` |
| `src/meteora/dbc.mjs` | `node test-meteora.mjs` |
| `src/meteora/snipe.mjs`, `src/meteora/sniper.mjs`, `src/meteora/prepare.mjs` | `node test-sniper.mjs` |
| `src/pump/pump.mjs`, `src/pump/wallets.mjs`, `src/pump/jito.mjs`, `src/pump/sniper.mjs`, `src/pump/snipe-control.mjs` | `node test-pump.mjs` |

`npm test` runs a syntax check across every file first — two syntax errors have
already shipped in test files that nothing was executing.

The executor suite's last four cases read `index.mjs` **as source**, because no
unit call can prove a caller wired a gate in. All four were verified by deleting
the guard and watching them go red.
