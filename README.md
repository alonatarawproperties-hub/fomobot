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
npm test                             # 183 offline assertions, no network
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
  why `via` is recorded.
- **No Telegram control plane yet.** The bot talks; it does not listen. `/pause`,
  `/positions` and a force-exit are not built, so stopping it means stopping the
  process.

---

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

`npm test` runs a syntax check across every file first — two syntax errors have
already shipped in test files that nothing was executing.

The executor suite's last four cases read `index.mjs` **as source**, because no
unit call can prove a caller wired a gate in. All four were verified by deleting
the guard and watching them go red.

---

## Sniping a Solana launch on a Meteora curve

A different job from everything above, and deliberately separate from it. The
copy-trading path reacts to a *trader*; this reacts to a *launch* whose token
address is known in advance. None of it is wired into the roster, the policy gate
or the executor — `src/meteora-dbc.mjs` and `scripts/dbc-probe.mjs` stand alone.

Everything below was read off mainnet on 2026-09-16 and is re-checked by
`node test-dbc.mjs`, which derives five addresses and one instruction payload and
compares them against values observed in real transactions.

### The venue

`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` is Meteora's Dynamic Bonding Curve.
Buys and sells are one instruction, `Swap2`, discriminator `414b3f4ceb5b5b88` —
which is also `sha256("global:swap2")[0..8]`, so the name and the bytes confirm
each other. It takes 15 accounts and `(amountIn, minimumAmountOut, mode)`.

**A launch is one atomic transaction.** `InitializeVirtualPoolWithToken2022`
creates the mint, the vaults, the metadata, mints the entire supply, revokes mint
and freeze authority, and creates the pool. Two consequences:

- The token **does not exist** before the launch. Being given the address in
  advance means somebody pre-generated the mint keypair.
- There is **no gap between existing and being tradeable**. The configs sampled
  carry no activation slot or timestamp — scanning every 8-byte window in one
  turned up no value resembling either — so the curve is live on creation. There
  is no scheduled moment to aim at, and nothing to wait for.

### What a reactive bot actually gets, measured

One launch, caught live on the same `logsSubscribe` mechanism `src/solana.mjs`
already uses (mint `9SgwHTxL4pNwfKoTWuG7yMNV3z4ptJCkAgt3HwnXw8qT`, created slot
447445706):

```
+0 slots    three separate buys, inside the creation slot itself
+1 slot     a fourth
+42 slots   (~17s) the next wave, and everything after it
```

Those first three **cannot have reacted to the creation.** A `logsSubscribe`
notification is emitted only after the slot is processed, so the earliest a
listener can even know the pool exists is already too late. They were sending to
the pool address before the pool existed.

That is the whole finding: **detection is not the bottleneck, and making detection
faster does not help.** A bot that waits to be told lands in the +42 wave, about
17 seconds in, alongside everyone reading a feed. Getting into the creation slot
requires knowing the pool's address ahead of time and sending blind.

### Which means the config is the only thing that matters

The pool is a PDA, derivable before it exists:

```
pool       = PDA(["pool", config, max(baseMint,quoteMint), min(baseMint,quoteMint)])
baseVault  = PDA(["token_vault", baseMint,  pool])
quoteVault = PDA(["token_vault", quoteMint, pool])
poolAuthority  = PDA(["pool_authority"])     FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM
eventAuthority = PDA(["__event_authority"])  8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF
```

**The two mints are sorted, not passed in role order.** Established, not assumed:
across 54,371 pools whose base mint sorts below wSOL — the only pools where the
orderings differ — 47,749 matched sorted and **zero** matched `(base, quote)`. The
other 6,622 are quoted in something other than wSOL and correctly match neither.
wSOL's first byte is `0x06`, so ~98% of mints sort above it and the bug is
invisible for all of them.

So the mint is not enough. **The config is the one input that cannot be derived or
guessed**, and 504,063 of them exist. They are long-lived and shared — the one
sampled was created ~1.3 days before the pool that used it, and 27 pools share it
— so a config *can* be known before a launch, but only by being told it, or by
recognising the launchpad from pools it created earlier.

- **With the config:** the pool address is computable now, a transaction can be
  built now, and a same-slot entry is possible.
- **Without it:** the pool can only be *found* after it exists —
  `getProgramAccounts` with a memcmp on `base_mint` at offset 136 returns it in
  ~80–260ms — and the entry lands in the +42 wave.

### The exit is a second venue, and it appears without warning

A DBC pool has a finite life. When the curve completes, `MigrationDammV2` moves
both reserves into a Meteora DAMM v2 (cp-amm) pool and locks the position; the DBC
pool keeps its account and its history but holds dust. Confirmed on the reference
launch: DBC reserves fell from 15.81 SOL to 0.0559 SOL, and the migration
transaction created DAMM v2 pool `C4shWUr7m7Z4eAsknbeNZVrJRQg6Q8H6ymoo3uQ7u9Et`.

**A position held through migration must be sold on a different program.** An exit
that only knows `Swap2` stops working at the exact moment the token succeeds. The
probe detects this by asking DAMM v2 directly rather than inferring it from
drained reserves, because drained reserves also look like a dead launch.

### Probing the address before the launch

```sh
node scripts/dbc-probe.mjs <mint> [--config <config>] [--rpc <url>]
```

Read-only; it signs nothing and needs no key. It reports whether the mint exists,
whether a pool exists and what its curve looks like, which config it is on, and
whether it has already migrated. With `--config` it prints the pool and vault
addresses the launch **will** use, derived before it happens.

It also reports what decides whether the position can be exited at all: a live
freeze authority, a Token-2022 **transfer hook** (arbitrary code on every
transfer, including yours), a transfer fee, a permanent delegate, or a default
frozen account state. DBC launches are commonly Token-2022, so these are live
risks rather than theory. An address that exists but is not a mint is called out
as such — an earlier version reported one as a clean token with zero supply.

### What is NOT established

- **No transaction has been signed or sent.** Everything above is read-only. The
  signing, fee and submission path does not exist yet, and the numbers that decide
  whether a same-slot entry is actually winnable from a given box — priority fee
  levels, whether Jito bundles are needed, how many blind attempts it costs — have
  not been measured.
- **Whether sniping this launch is a good idea at all is a separate question from
  whether it is possible.** The Robinhood Chain measurements above found the median
  launch down 2.8% thirty seconds in, with only 40% up at all. Nothing here
  suggests Solana is kinder.

### Arming the snipe

```sh
# dry run: derives everything, builds the real transaction, signs nothing
node scripts/snipe.mjs --config <config> --mint <mint> --sol 0.25 \
     --accept-any-price --priority-fee 500000 --payer <address>

# live
FIRSTFILL_SOLANA_KEY=… node scripts/snipe.mjs --config <config> --mint <mint> \
     --sol 0.25 --min-tokens 900000000 --priority-fee 500000 --duration 300 --rate 2 --arm
```

**Without `--arm` it signs nothing**, needs no key, and prints what it would send
plus what the attempts would cost. It refuses before spending anything if the
config is not a real `PoolConfig`, if the launch is not quoted in wSOL, if the
wallet cannot cover a fill plus all fees — and if the pool **already exists**,
because then the race is over and a blind snipe is just an expensive market buy.

There is no default floor. `--min-tokens` or an explicit `--accept-any-price` is
required, because on a launch with no price history a silent floor of zero means
any fill is acceptable, dust included.

The signing key is read from `FIRSTFILL_SOLANA_KEY` and nowhere else — a separate
variable from the EVM key, so one pasted key cannot arm both chains. A 64-byte
Solana key carries its own public half, and the loader **refuses** a key whose
halves disagree: signing anyway would produce perfectly valid signatures for an
address nobody is funding.

### One fill, not hundreds

Sending a buy hundreds of times raises the obvious way to lose everything: the
pool appears and they *all* succeed. Solana has no per-sender nonce to prevent
that — it dedupes by **signature**, and nothing else.

Which is the lever. A signature covers the blockhash, so while the blockhash is
unchanged every attempt is the *same* transaction with the *same* signature, and
at most one can execute however many are sent. So this signs **once per
blockhash** — not per attempt — and re-sends identical bytes.

A blockhash lasts ~150 slots, so a refresh is needed about once a minute, and each
refresh opens a new signature that could also fill. That is the one remaining
window, and it is closed deliberately: the balance is re-read before every new
generation, and `shouldRefresh` refuses to sign again while a fill is unconfirmed.
`test-sol-tx.mjs` asserts both halves — same blockhash means an identical
signature, a different one does not.

### The transaction is built by hand, and pinned to prove it

No Solana dependency, for the same reason as base58 and the PDA derivation: the
alternative is megabytes of dependency for a few hundred bytes of serialisation, in
a project whose point is a short auditable path from signal to signature.

"Hand-rolled" is only acceptable if it is checked against something. A complete
8-instruction snipe — compute budget, wSOL wrap, two idempotent ATAs, the `Swap2`
buy, the close — serialises to a **693-byte message and a 758-byte wire
transaction that are byte-identical to `@solana/web3.js` and `@solana/spl-token`,
signature included.** Those hashes are pinned in `test-sol-tx.mjs`. Node's ed25519
is checked against RFC 8032's test vector, public key and signature both.

Two things that cost real time to find, recorded so they are not re-found:

- **The PDA bump is a seed** — it goes *before* the program id, not after. The
  wrong order yields a stable, plausible address for every input that simply is
  not the account.
- **web3.js breaks ties with a locale-aware compare**, not a byte compare, so
  `dbcij…` sorts before `So11…`. Account order within a group does not affect
  validity, but matching it exactly is what makes byte-level pinning possible.

### What the snipe still does not do

- **There is no exit.** Nothing here sells. A fill leaves a position this project
  cannot close, and if the curve completes it migrates to DAMM v2 and the sell
  needs a different program entirely. The CLI says so after a fill rather than
  leaving it to be discovered.
- **No transaction has been sent by this code.** The build path is verified against
  the reference implementations byte-for-byte, and the guards are tested, but
  nothing above has been proven by landing a real buy.
- **The priority fee that actually wins is unknown.** `--priority-fee` is an input,
  not a recommendation; no measurement here establishes what it takes to be
  included in a contested creation slot.
- **Token-2022 is assumed to be the likely case, not the certain one**, which is
  why both variants are sent. The wrong one costs one transaction's fees.
