// Generate a fresh trading wallet. Run it yourself; never paste the output.
//
// Deliberately does NOT write anything to disk. A key on disk is a key in a
// backup, in a `git add -A`, and in whatever synced your home directory — and
// this repo is on GitHub, so the cost of that mistake is a drained wallet within
// seconds of the push. It prints once, to your terminal, and forgets.
//
//   node scripts/new-wallet.mjs
//
// Use a FRESH wallet for this bot, not one you already hold funds in. The key
// has to live on the server, so treat whatever is in this wallet as the most you
// are willing to lose if that server is ever compromised.

import { Wallet } from 'ethers';

const w = Wallet.createRandom();

console.log(`
  ┌───────────────────────────────────────────────────────────────────────┐
  │  NEW TRADING WALLET                                                   │
  └───────────────────────────────────────────────────────────────────────┘

  Address      ${w.address}
      ↑ safe to share. Bridge USDG and ETH to THIS.

  Private key  ${w.privateKey}
      ↑ NEVER share this. Not in chat, not in the repo, not in config.json.
        Anyone holding it owns everything in the wallet.

  Recovery phrase
      ${w.mnemonic?.phrase ?? '(none)'}

  ─────────────────────────────────────────────────────────────────────────
  NEXT, on the server and nowhere else:

    1. Put the address in config.json:

         "executor": { "wallet": "${w.address}" }

    2. Put the KEY in a root-only env file — never in config.json, which is
       copied around and which the bot refuses to read a key from anyway:

         sudo install -m 600 /dev/null /etc/firstfill.env
         sudo tee /etc/firstfill.env >/dev/null <<'ENV'
         FIRSTFILL_PRIVATE_KEY=<paste the key here>
         ENV

    3. Point systemd at it, so the key is never on a command line where
       \`ps\` would show it to every user on the box:

         [Service]
         EnvironmentFile=/etc/firstfill.env

  Then bridge funds to the address above and run \`npm run paper\` first.
`);
