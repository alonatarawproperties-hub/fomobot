#!/usr/bin/env node
// The Meteora DBC sniper, driven from the command line.
//
//   npm run snipe -- plan        print every address this will touch, do nothing
//   npm run snipe -- prepare     create and fund the quote token account
//   npm run snipe -- arm --dry   arm and watch for real; build but never send
//   npm run snipe -- arm         arm, watch, and buy the moment the pool exists
//
// `plan` and `--dry` exist because every address here is derived, and a derived
// address that is wrong does not throw — it points somewhere real and useless.
// Reading them out loud before arming is the only way to catch that.

import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';

import { planSnipe, decodePoolConfig, deriveAta, tokenProgramFor, DBC_PROGRAM_ID, WSOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../src/meteora/dbc.mjs';
import { DbcSniper, parseAddress, STATE } from '../src/meteora/sniper.mjs';
import { wrapSolInstructions, topUpWrappedSolInstructions, isWrappedSol } from '../src/meteora/prepare.mjs';
import { getAccount, getTokenBalance, getLatestBlockhash, rpc, sendRawTransaction } from '../src/meteora/rpc.mjs';

const KEY_ENV = 'FIRSTFILL_SOLANA_KEY';
const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-')) ?? 'plan';
const DRY = argv.includes('--dry');
const CONFIG_PATH = process.env.FIRSTFILL_CONFIG ?? './config.json';

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

const die = (message) => { log('error', message); process.exit(1); };

/**
 * The signing key, from the environment only.
 *
 * Accepts both shapes a Solana key is handed around in: base58, which is what a
 * wallet exports, and the JSON byte array that solana-keygen writes. Refusing one
 * of them would just mean the operator converts it by hand at the worst moment.
 */
function loadKeypair(env = process.env) {
  const raw = env[KEY_ENV];
  if (!raw) die(`${KEY_ENV} is not set — the signing key is read from the environment, never the config file`);
  const value = raw.trim();
  try {
    if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
    return Keypair.fromSecretKey(bs58.decode(value));
  } catch (e) {
    die(`${KEY_ENV} is not a valid Solana secret key (base58 or JSON byte array): ${e.message}`);
  }
}

/** A raw token amount, as a string. Named, because "Cannot convert x to a BigInt" is not a diagnosis. */
function amountField(name, value) {
  try { return BigInt(value); }
  catch { throw new Error(`snipe.${name} must be a whole number of raw token units, as a string — got ${JSON.stringify(value)}`); }
}

function loadSnipeConfig() {
  let raw;
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { die(`could not read ${CONFIG_PATH}: ${e.message}`); }

  const s = raw.snipe;
  if (!s) die(`${CONFIG_PATH} has no "snipe" section — copy the one in config.example.json`);

  for (const key of ['privateKey', 'secretKey', 'keypair']) {
    if (s[key]) die(`snipe: remove "${key}" from the config file — the signing key is read from ${KEY_ENV} only`);
  }

  const httpUrl = s.httpUrl ?? raw.solana?.httpUrl;
  const wsUrl = s.wsUrl ?? raw.solana?.wsUrl;
  if (!httpUrl || !wsUrl) die('snipe: httpUrl and wsUrl are required (or inherit them from the solana section)');

  const mint = parseAddress('snipe.mint', s.mint);
  const quoteMint = s.quoteMint ? parseAddress('snipe.quoteMint', s.quoteMint) : WSOL_MINT;
  const config = s.config ? parseAddress('snipe.config', s.config) : null;
  // Optional, and worth setting: it is the difference between zero round trips
  // at fire time and one. Read it off an earlier launch with find-config.
  const baseTokenProgram = s.baseTokenProgram ? parseAddress('snipe.baseTokenProgram', s.baseTokenProgram) : null;
  if (baseTokenProgram && ![TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58()].includes(baseTokenProgram.toBase58())) {
    die(`snipe.baseTokenProgram must be ${TOKEN_PROGRAM.toBase58()} (SPL Token) or ${TOKEN_2022_PROGRAM.toBase58()} (Token-2022)`);
  }

  if (s.amountIn === undefined) die('snipe: amountIn is required — the raw quote amount to spend, as a string');
  const amountIn = amountField('amountIn', s.amountIn);
  if (amountIn <= 0n) die('snipe: amountIn must be positive');

  // No default. A floor of zero means "fill me at any price", which on a launch
  // is a real and sometimes correct choice — but it is the operator's to make
  // out loud, not one this script makes quietly on their behalf.
  if (s.minimumAmountOut === undefined) {
    die('snipe: minimumAmountOut is required. Set the raw base-token floor you will accept, or "0" to accept any fill — but set it deliberately.');
  }
  const minimumAmountOut = amountField('minimumAmountOut', s.minimumAmountOut);
  if (minimumAmountOut < 0n) die('snipe: minimumAmountOut cannot be negative');

  return {
    httpUrl, wsUrl,
    sendUrls: s.sendUrls?.length ? s.sendUrls : [httpUrl],
    mint, quoteMint, config, baseTokenProgram, amountIn, minimumAmountOut,
    computeUnitLimit: s.computeUnitLimit ?? 250_000,
    computeUnitPriceMicroLamports: s.computeUnitPriceMicroLamports ?? 1_000_000,
    resendMs: s.resendMs ?? 400,
    fireWindowMs: s.fireWindowMs ?? 30_000,
  };
}

/** Send one ordinary (non-race) transaction and wait for it. */
async function sendAndConfirm(httpUrl, instructions, keypair) {
  const { blockhash } = await getLatestBlockhash(httpUrl);
  const message = new TransactionMessage({
    payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);
  const signature = bs58.encode(tx.signatures[0]);

  const { error } = await sendRawTransaction(httpUrl, Buffer.from(tx.serialize()).toString('base64'));
  if (error) throw new Error(`send failed: ${error}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const { result } = await rpc(httpUrl, 'getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
    const status = result?.value?.[0];
    if (!status) continue;
    if (status.err) throw new Error(`transaction failed on chain: ${JSON.stringify(status.err)}`);
    return signature;
  }
  throw new Error(`transaction ${signature} was not confirmed in 20s`);
}

// ---------------------------------------------------------------------------

async function commandPlan(cfg, keypair) {
  const buyer = keypair.publicKey;
  log('info', 'buyer', { address: buyer.toBase58() });
  log('info', 'target', {
    mint: cfg.mint.toBase58(),
    quoteMint: cfg.quoteMint.toBase58(),
    config: cfg.config?.toBase58() ?? '(none — discovered from the trigger notification)',
    amountIn: cfg.amountIn.toString(),
    minimumAmountOut: cfg.minimumAmountOut.toString(),
  });

  const quoteMintAccount = await getAccount(cfg.httpUrl, cfg.quoteMint.toBase58(), { commitment: 'confirmed' });
  if (!quoteMintAccount) die(`quote mint ${cfg.quoteMint.toBase58()} does not exist`);
  const quoteTokenProgram = new PublicKey(quoteMintAccount.owner);
  const quoteAta = deriveAta(buyer, cfg.quoteMint, quoteTokenProgram);
  const balance = await getTokenBalance(cfg.httpUrl, quoteAta.toBase58(), { commitment: 'confirmed' });

  log('info', 'quote account', {
    address: quoteAta.toBase58(),
    tokenProgram: quoteTokenProgram.toBase58(),
    balance: balance === null ? '(does not exist)' : balance.toString(),
    enough: balance !== null && balance >= cfg.amountIn,
  });

  const mintAccount = await getAccount(cfg.httpUrl, cfg.mint.toBase58(), { commitment: 'confirmed' });
  log('info', 'target mint', {
    exists: Boolean(mintAccount),
    note: mintAccount ? 'THE MINT ALREADY EXISTS — check this is really pre-launch' : 'does not exist yet, as expected before a launch',
  });

  if (!cfg.config) {
    // The pool address needs the config, so it cannot be shown. But the account
    // the tokens land in does NOT — it derives from the mint and the token
    // program, both known now. Worth printing: it is the address to watch after a
    // fill, and the one thing an operator can check independently.
    if (cfg.baseTokenProgram) {
      log('info', 'where the tokens will land', {
        outputTokenAccount: deriveAta(buyer, cfg.mint, cfg.baseTokenProgram).toBase58(),
        baseTokenProgram: cfg.baseTokenProgram.toBase58(),
        roundTripsAtFire: 0,
        note: 'created inside the snipe transaction itself — the mint does not exist yet',
      });
    } else {
      log('warn', 'snipe.baseTokenProgram is not set', {
        cost: 'one RPC round trip in the middle of the race, to learn which token program owns the mint',
        fix: 'read it off an earlier launch with find-config and put it in config.json',
      });
    }
    log('info', 'no config, which is correct when the launchpad mints one per launch', {
      meaning: 'the pool address cannot be derived in advance, so nothing is pre-signed',
      trigger: 'programSubscribe on the mint — the notification carries the pool, its config and both vaults',
    });
    return;
  }

  const cfgAccount = await getAccount(cfg.httpUrl, cfg.config.toBase58(), { commitment: 'confirmed' });
  if (!cfgAccount) die(`config ${cfg.config.toBase58()} does not exist`);
  if (cfgAccount.owner !== DBC_PROGRAM_ID.toBase58()) die(`config is owned by ${cfgAccount.owner}, not the DBC program`);
  const poolConfig = decodePoolConfig(cfgAccount.data);

  log('info', 'pool config', {
    quoteMint: poolConfig.quoteMint.toBase58(),
    matchesOurs: poolConfig.quoteMint.toBase58() === cfg.quoteMint.toBase58(),
    baseTokenProgram: tokenProgramFor(poolConfig.tokenType).toBase58(),
    baseDecimals: poolConfig.tokenDecimal,
  });
  if (poolConfig.quoteMint.toBase58() !== cfg.quoteMint.toBase58()) {
    die(`config quotes ${poolConfig.quoteMint.toBase58()} but snipe.quoteMint is ${cfg.quoteMint.toBase58()} — the derived pool would be the wrong account`);
  }

  const plan = planSnipe({
    config: cfg.config, baseMint: cfg.mint, quoteMint: cfg.quoteMint, buyer,
    baseTokenType: poolConfig.tokenType, quoteTokenType: poolConfig.quoteTokenFlag,
  });
  const poolExists = await getAccount(cfg.httpUrl, plan.pool.toBase58(), { commitment: 'confirmed' });

  log('info', 'derived addresses', {
    pool: plan.pool.toBase58(),
    poolExistsAlready: Boolean(poolExists),
    baseVault: plan.baseVault.toBase58(),
    quoteVault: plan.quoteVault.toBase58(),
    weReceiveInto: plan.outputTokenAccount.toBase58(),
    weSpendFrom: plan.inputTokenAccount.toBase58(),
  });
  log('info', 'ready', { mode: 'pre-signed', note: 'run `arm` to watch and fire' });
}

async function commandPrepare(cfg, keypair) {
  const buyer = keypair.publicKey;
  if (!isWrappedSol(cfg.quoteMint)) {
    // Only SOL can be created out of the balance already in the wallet. Any other
    // quote currency has to be acquired, and doing that silently with the
    // operator's money is not this script's business.
    const quoteMintAccount = await getAccount(cfg.httpUrl, cfg.quoteMint.toBase58(), { commitment: 'confirmed' });
    if (!quoteMintAccount) die(`quote mint ${cfg.quoteMint.toBase58()} does not exist`);
    const tokenProgram = new PublicKey(quoteMintAccount.owner);
    const ata = deriveAta(buyer, cfg.quoteMint, tokenProgram);
    const balance = await getTokenBalance(cfg.httpUrl, ata.toBase58(), { commitment: 'confirmed' });
    if (balance === null) die(`${ata.toBase58()} does not exist. Send ${cfg.quoteMint.toBase58()} to ${buyer.toBase58()} and it will be created for you.`);
    if (balance < cfg.amountIn) die(`${ata.toBase58()} holds ${balance}, need ${cfg.amountIn}`);
    log('info', 'quote account already funded', { address: ata.toBase58(), balance: balance.toString() });
    return;
  }

  const ata = deriveAta(buyer, WSOL_MINT, TOKEN_PROGRAM);
  const existing = await getTokenBalance(cfg.httpUrl, ata.toBase58(), { commitment: 'confirmed' });

  if (existing !== null && existing >= cfg.amountIn) {
    log('info', 'wrapped SOL already sufficient', { address: ata.toBase58(), balance: existing.toString(), need: cfg.amountIn.toString() });
    return;
  }

  let instructions;
  if (existing === null) {
    // Rent is read from the cluster, never assumed: an underfunded account exists
    // and fails at fire time, which is the worst possible moment to find out.
    const { result: rent, error } = await rpc(cfg.httpUrl, 'getMinimumBalanceForRentExemption', [165]);
    if (error) die(`could not read rent exemption: ${error.message}`);
    ({ instructions } = wrapSolInstructions({ owner: buyer, lamports: cfg.amountIn, rentExemptLamports: BigInt(rent) }));
    log('info', 'creating and funding wrapped SOL account', { address: ata.toBase58(), lamports: cfg.amountIn.toString(), rent });
  } else {
    const shortfall = cfg.amountIn - existing;
    ({ instructions } = topUpWrappedSolInstructions({ owner: buyer, lamports: shortfall }));
    log('info', 'topping up wrapped SOL account', { address: ata.toBase58(), have: existing.toString(), adding: shortfall.toString() });
  }

  if (DRY) { log('info', 'dry run — nothing sent', { instructions: instructions.length }); return; }

  const signature = await sendAndConfirm(cfg.httpUrl, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ...instructions,
  ], keypair);
  const after = await getTokenBalance(cfg.httpUrl, ata.toBase58(), { commitment: 'confirmed' });
  log('info', 'funded', { signature, address: ata.toBase58(), balance: after?.toString() ?? '0' });
}

async function commandArm(cfg, keypair) {
  const sniper = new DbcSniper({
    wsUrl: cfg.wsUrl, httpUrl: cfg.httpUrl, sendUrls: cfg.sendUrls,
    mint: cfg.mint, quoteMint: cfg.quoteMint, config: cfg.config,
    baseTokenProgram: cfg.baseTokenProgram, keypair,
    amountIn: cfg.amountIn, minimumAmountOut: cfg.minimumAmountOut,
    computeUnitLimit: cfg.computeUnitLimit,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
    resendMs: cfg.resendMs, fireWindowMs: cfg.fireWindowMs,
    dryRun: DRY,
  });

  for (const event of ['info', 'armed', 'open', 'subscribed', 'trigger', 'firing', 'sent', 'dry-run', 'replanned']) {
    sniper.on(event, (d) => log('info', event, d));
  }
  for (const event of ['warn', 'closed', 'send-error', 'refused', 'abandoned']) {
    sniper.on(event, (d) => log('warn', event, d));
  }
  sniper.on('error', (d) => log('error', 'error', d));

  sniper.on('filled', (d) => {
    log('signal', 'FILLED', d);
    sniper.stop();
    process.exit(0);
  });
  sniper.on('failed', (d) => {
    log('error', 'transaction landed but failed on chain', d);
    sniper.stop();
    process.exit(1);
  });

  try {
    await sniper.arm();
  } catch (e) {
    die(`arm refused: ${e.message}`);
  }
  sniper.start();
  log('info', 'watching', { mint: cfg.mint.toBase58(), dryRun: DRY, note: 'ctrl-c to stop' });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('info', 'shutting down', { signal, state: sniper.state, stats: sniper.stats });
      sniper.stop();
      process.exit(sniper.state === STATE.FILLED ? 0 : 130);
    });
  }
}

// ---------------------------------------------------------------------------

// parseAddress and BigInt both throw, and a config mistake is the most likely
// error anyone hits here. A stack trace for "you left the placeholder in" helps
// nobody, so everything config-shaped is reported as one line.
let cfg, keypair;
try {
  cfg = loadSnipeConfig();
  keypair = loadKeypair();
} catch (e) {
  die(e.message);
}

const commands = { plan: commandPlan, prepare: commandPrepare, arm: commandArm };
if (!commands[command]) die(`unknown command "${command}" — expected one of: ${Object.keys(commands).join(', ')}`);

commands[command](cfg, keypair).catch((e) => die(e.stack ?? e.message));
