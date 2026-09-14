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
  "slippageBps": 300,
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

## Run it

Needs Node 22+ (for the built-in WebSocket).

```sh
npm install
cp config.example.json config.json   # fill in Helius, Telegram, and the executor block
npm test                             # 126 offline assertions, no network
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

`npm test` runs a syntax check across every file first — two syntax errors have
already shipped in test files that nothing was executing.

The executor suite's last four cases read `index.mjs` **as source**, because no
unit call can prove a caller wired a gate in. All four were verified by deleting
the guard and watching them go red.
