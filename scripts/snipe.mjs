#!/usr/bin/env node
// The Meteora DBC sniper, driven from the command line.
//
//   npm run snipe -- plan        print every address this will touch, do nothing
//   npm run snipe -- prepare     create and fund each wallet's quote account
//   npm run snipe -- arm --dry   arm and watch for real; build but never send
//   npm run snipe -- arm         arm, watch, and buy the moment the pool exists
//
// `plan` and `--dry` exist because every address here is derived, and a derived
// address that is wrong does not throw — it points somewhere real and useless.
// Reading them out loud before arming is the only way to catch that.
//
// SEVERAL WALLETS. config.snipe.wallets is a list; each entry names the ENV VAR
// holding that wallet's key and the amount it spends. Keys are never in the file.
// With no list, the single key in FIRSTFILL_SOLANA_KEY spends snipe.amountIn.

import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';

import { planSnipe, decodePoolConfig, deriveAta, tokenProgramFor, DBC_PROGRAM_ID, WSOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../src/meteora/dbc.mjs';
import { DbcSniper, parseAddress, STATE } from '../src/meteora/sniper.mjs';
import { wrapSolInstructions, topUpWrappedSolInstructions, isWrappedSol } from '../src/meteora/prepare.mjs';
import { getAccount, getTokenBalance, getBalance, getLatestBlockhash, rpc, sendRawTransaction } from '../src/meteora/rpc.mjs';

const DEFAULT_KEY_ENV = 'FIRSTFILL_SOLANA_KEY';
const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-')) ?? 'plan';
const DRY = argv.includes('--dry');
const CONFIG_PATH = process.env.FIRSTFILL_CONFIG ?? './config.json';

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

const die = (message) => { log('error', message); process.exit(1); };

/**
 * One wallet's key, from the environment only.
 *
 * Accepts both shapes a Solana key is handed around in: base58, which is what a
 * wallet exports, and the JSON byte array that solana-keygen writes. Refusing one
 * of them would just mean the operator converts it by hand at the worst moment.
 */
function loadKeypair(envName, env = process.env) {
  const raw = env[envName];
  if (!raw) throw new Error(`${envName} is not set — every wallet's key is read from the environment, never the config file`);
  const value = raw.trim();
  try {
    if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
    return Keypair.fromSecretKey(bs58.decode(value));
  } catch (e) {
    throw new Error(`${envName} is not a valid Solana secret key (base58 or JSON byte array): ${e.message}`);
  }
}

/** A raw token amount, as a string. Named, because "Cannot convert x to a BigInt" is not a diagnosis. */
function amountField(name, value) {
  try { return BigInt(value); }
  catch { throw new Error(`${name} must be a whole number of raw token units, as a string — got ${JSON.stringify(value)}`); }
}

function loadSnipeConfig() {
  let raw;
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { die(`could not read ${CONFIG_PATH}: ${e.message}`); }

  const s = raw.snipe;
  if (!s) die(`${CONFIG_PATH} has no "snipe" section — copy the one in config.example.json`);

  for (const key of ['privateKey', 'secretKey', 'keypair']) {
    if (s[key]) die(`snipe: remove "${key}" from the config file — keys are read from the environment only`);
  }

  const httpUrl = s.httpUrl ?? raw.solana?.httpUrl;
  const wsUrl = s.wsUrl ?? raw.solana?.wsUrl;
  if (!httpUrl || !wsUrl) die('snipe: httpUrl and wsUrl are required (or inherit them from the solana section)');

  const mint = parseAddress('snipe.mint', s.mint);
  const quoteMint = s.quoteMint ? parseAddress('snipe.quoteMint', s.quoteMint) : WSOL_MINT;
  const config = s.config ? parseAddress('snipe.config', s.config) : null;
  const baseTokenProgram = s.baseTokenProgram ? parseAddress('snipe.baseTokenProgram', s.baseTokenProgram) : null;
  if (baseTokenProgram && ![TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58()].includes(baseTokenProgram.toBase58())) {
    die(`snipe.baseTokenProgram must be ${TOKEN_PROGRAM.toBase58()} (SPL Token) or ${TOKEN_2022_PROGRAM.toBase58()} (Token-2022)`);
  }

  // No default, and there will not be one. A floor of zero means "fill me at any
  // price", which on a launch is a real and sometimes correct choice — but it is
  // the operator's to make out loud, not one this script makes on their behalf.
  if (s.minimumAmountOut === undefined) {
    die('snipe: minimumAmountOut is required. Set the raw base-token floor you will accept, or "0" to accept any fill — but set it deliberately.');
  }
  const defaultMinOut = amountField('snipe.minimumAmountOut', s.minimumAmountOut);
  if (defaultMinOut < 0n) die('snipe: minimumAmountOut cannot be negative');

  // The wallet list, or the single-wallet shorthand.
  let wallets;
  if (Array.isArray(s.wallets) && s.wallets.length) {
    wallets = s.wallets.map((w, i) => {
      const where = `snipe.wallets[${i}]`;
      if (w.privateKey || w.secretKey) die(`${where}: remove the key from the config file — name the ENV VAR in "keyEnv" instead`);
      const keyEnv = w.keyEnv ?? (i === 0 ? DEFAULT_KEY_ENV : null);
      if (!keyEnv) die(`${where}: "keyEnv" is required — the name of the environment variable holding this wallet's key`);
      if (w.amountIn === undefined) die(`${where}: "amountIn" is required`);
      const amountIn = amountField(`${where}.amountIn`, w.amountIn);
      if (amountIn <= 0n) die(`${where}: amountIn must be positive`);
      const minimumAmountOut = w.minimumAmountOut === undefined
        ? defaultMinOut
        : amountField(`${where}.minimumAmountOut`, w.minimumAmountOut);
      if (minimumAmountOut < 0n) die(`${where}: minimumAmountOut cannot be negative`);
      return { keyEnv, amountIn, minimumAmountOut, label: w.label ?? `w${i + 1}` };
    });

    const envs = wallets.map((w) => w.keyEnv);
    const dupe = envs.find((e, i) => envs.indexOf(e) !== i);
    // Two entries reading one env var is two transactions from one wallet
    // spending the same wrapped balance; the second fails having paid a fee.
    if (dupe) die(`snipe.wallets: ${dupe} is used by more than one entry — each wallet needs its own key`);
  } else {
    if (s.amountIn === undefined) die('snipe: amountIn is required — the raw quote amount to spend, as a string');
    const amountIn = amountField('snipe.amountIn', s.amountIn);
    if (amountIn <= 0n) die('snipe: amountIn must be positive');
    wallets = [{ keyEnv: DEFAULT_KEY_ENV, amountIn, minimumAmountOut: defaultMinOut, label: 'w1' }];
  }

  return {
    httpUrl, wsUrl,
    sendUrls: s.sendUrls?.length ? s.sendUrls : [httpUrl],
    mint, quoteMint, config, baseTokenProgram, wallets,
    computeUnitLimit: s.computeUnitLimit ?? 250_000,
    computeUnitPriceMicroLamports: s.computeUnitPriceMicroLamports ?? 1_000_000,
    resendMs: s.resendMs ?? 400,
    fireWindowMs: s.fireWindowMs ?? 30_000,
  };
}

/** Load every wallet's key, reporting ALL the missing ones rather than the first. */
function loadWallets(cfg) {
  const loaded = [];
  const missing = [];
  for (const w of cfg.wallets) {
    try { loaded.push({ ...w, keypair: loadKeypair(w.keyEnv) }); }
    catch (e) { missing.push(`${w.label}: ${e.message}`); }
  }
  if (missing.length) {
    for (const m of missing) log('error', m);
    die(`${missing.length} of ${cfg.wallets.length} wallet key(s) could not be loaded`);
  }
  return loaded;
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

async function commandPlan(cfg, wallets) {
  const total = wallets.reduce((s, w) => s + w.amountIn, 0n);
  log('info', 'target', {
    mint: cfg.mint.toBase58(),
    quoteMint: cfg.quoteMint.toBase58(),
    config: cfg.config?.toBase58() ?? '(none — discovered from the trigger notification)',
    wallets: wallets.length,
    totalAmountIn: total.toString(),
    totalSol: Number(total) / 1e9,
  });

  const quoteMintAccount = await getAccount(cfg.httpUrl, cfg.quoteMint.toBase58(), { commitment: 'confirmed' });
  if (!quoteMintAccount) die(`quote mint ${cfg.quoteMint.toBase58()} does not exist`);
  const quoteTokenProgram = new PublicKey(quoteMintAccount.owner);

  // What one wallet needs in plain SOL on top of its wrapped balance.
  const priorityFee = BigInt(cfg.computeUnitLimit) * BigInt(cfg.computeUnitPriceMicroLamports) / 1_000_000n;
  const needNative = priorityFee + 5_000n + 2_100_000n;

  let ready = 0;
  for (const w of wallets) {
    const address = w.keypair.publicKey;
    const quoteAta = deriveAta(address, cfg.quoteMint, quoteTokenProgram);
    const [wrapped, lamports] = await Promise.all([
      getTokenBalance(cfg.httpUrl, quoteAta.toBase58(), { commitment: 'confirmed' }),
      getBalance(cfg.httpUrl, address.toBase58(), { commitment: 'confirmed' }),
    ]);
    const wrappedOk = wrapped !== null && wrapped >= w.amountIn;
    const nativeOk = lamports >= needNative;
    if (wrappedOk && nativeOk) ready++;

    log(wrappedOk && nativeOk ? 'info' : 'warn', 'wallet', {
      label: w.label,
      keyEnv: w.keyEnv,
      address: address.toBase58(),
      amountIn: w.amountIn.toString(),
      quoteAta: quoteAta.toBase58(),
      wrapped: wrapped === null ? '(no account)' : wrapped.toString(),
      wrappedEnough: wrappedOk,
      nativeLamports: lamports.toString(),
      nativeEnough: nativeOk,
      shortfallNative: nativeOk ? '0' : (needNative - lamports).toString(),
      receivesInto: cfg.baseTokenProgram ? deriveAta(address, cfg.mint, cfg.baseTokenProgram).toBase58() : '(set snipe.baseTokenProgram to show)',
    });
  }

  log(ready === wallets.length ? 'info' : 'warn', 'wallets ready', {
    ready, of: wallets.length, needNativePerWallet: needNative.toString(),
  });

  const mintAccount = await getAccount(cfg.httpUrl, cfg.mint.toBase58(), { commitment: 'confirmed' });
  log('info', 'target mint', {
    exists: Boolean(mintAccount),
    note: mintAccount ? 'THE MINT ALREADY EXISTS — check this is really pre-launch' : 'does not exist yet, as expected before a launch',
  });

  if (!cfg.config) {
    if (!cfg.baseTokenProgram) {
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
  if (poolConfig.quoteMint.toBase58() !== cfg.quoteMint.toBase58()) {
    die(`config quotes ${poolConfig.quoteMint.toBase58()} but snipe.quoteMint is ${cfg.quoteMint.toBase58()} — the derived pool would be the wrong account`);
  }

  const plan = planSnipe({
    config: cfg.config, baseMint: cfg.mint, quoteMint: cfg.quoteMint, buyer: wallets[0].keypair.publicKey,
    baseTokenType: poolConfig.tokenType, quoteTokenType: poolConfig.quoteTokenFlag,
  });
  const poolExists = await getAccount(cfg.httpUrl, plan.pool.toBase58(), { commitment: 'confirmed' });
  log('info', 'derived addresses', {
    pool: plan.pool.toBase58(),
    poolExistsAlready: Boolean(poolExists),
    baseVault: plan.baseVault.toBase58(),
    quoteVault: plan.quoteVault.toBase58(),
  });
  log('info', 'ready', { mode: 'pre-signed', note: 'run `arm` to watch and fire' });
}

async function commandPrepare(cfg, wallets) {
  if (!isWrappedSol(cfg.quoteMint)) {
    // Only SOL can be created out of the balance already in a wallet. Any other
    // quote currency has to be acquired, and doing that silently with the
    // operator's money is not this script's business.
    const quoteMintAccount = await getAccount(cfg.httpUrl, cfg.quoteMint.toBase58(), { commitment: 'confirmed' });
    if (!quoteMintAccount) die(`quote mint ${cfg.quoteMint.toBase58()} does not exist`);
    const tokenProgram = new PublicKey(quoteMintAccount.owner);
    for (const w of wallets) {
      const ata = deriveAta(w.keypair.publicKey, cfg.quoteMint, tokenProgram);
      const balance = await getTokenBalance(cfg.httpUrl, ata.toBase58(), { commitment: 'confirmed' });
      if (balance === null) { log('error', `${w.label}: ${ata.toBase58()} does not exist — send ${cfg.quoteMint.toBase58()} to ${w.keypair.publicKey.toBase58()}`); continue; }
      if (balance < w.amountIn) { log('error', `${w.label}: holds ${balance}, needs ${w.amountIn}`); continue; }
      log('info', 'quote account already funded', { label: w.label, address: ata.toBase58(), balance: balance.toString() });
    }
    return;
  }

  // Rent is read from the cluster, never assumed: an underfunded account exists
  // and fails at fire time, which is the worst possible moment to find out.
  const { result: rent, error: rentError } = await rpc(cfg.httpUrl, 'getMinimumBalanceForRentExemption', [165]);
  if (rentError) die(`could not read rent exemption: ${rentError.message}`);

  let done = 0;
  for (const w of wallets) {
    const owner = w.keypair.publicKey;
    const ata = deriveAta(owner, WSOL_MINT, TOKEN_PROGRAM);
    const existing = await getTokenBalance(cfg.httpUrl, ata.toBase58(), { commitment: 'confirmed' });

    if (existing !== null && existing >= w.amountIn) {
      log('info', 'wrapped SOL already sufficient', { label: w.label, address: ata.toBase58(), balance: existing.toString(), need: w.amountIn.toString() });
      done++;
      continue;
    }

    let instructions;
    if (existing === null) {
      ({ instructions } = wrapSolInstructions({ owner, lamports: w.amountIn, rentExemptLamports: BigInt(rent) }));
      log('info', 'creating and funding wrapped SOL account', { label: w.label, address: ata.toBase58(), lamports: w.amountIn.toString(), rent });
    } else {
      const shortfall = w.amountIn - existing;
      ({ instructions } = topUpWrappedSolInstructions({ owner, lamports: shortfall }));
      log('info', 'topping up wrapped SOL account', { label: w.label, address: ata.toBase58(), have: existing.toString(), adding: shortfall.toString() });
    }

    if (DRY) { log('info', 'dry run — nothing sent', { label: w.label, instructions: instructions.length }); continue; }

    try {
      const signature = await sendAndConfirm(cfg.httpUrl, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
        ...instructions,
      ], w.keypair);
      const after = await getTokenBalance(cfg.httpUrl, ata.toBase58(), { commitment: 'confirmed' });
      log('info', 'funded', { label: w.label, signature, address: ata.toBase58(), balance: after?.toString() ?? '0' });
      done++;
    } catch (e) {
      // One wallet failing to fund must not stop the others: a partially prepared
      // set is still usable, and arm() reports exactly which wallets are short.
      log('error', `${w.label}: could not fund — ${e.message}`);
    }
  }
  log(done === wallets.length ? 'info' : 'warn', 'prepare done', { funded: done, of: wallets.length });
}

async function commandArm(cfg, wallets) {
  const sniper = new DbcSniper({
    wsUrl: cfg.wsUrl, httpUrl: cfg.httpUrl, sendUrls: cfg.sendUrls,
    mint: cfg.mint, quoteMint: cfg.quoteMint, config: cfg.config,
    baseTokenProgram: cfg.baseTokenProgram,
    buyers: wallets.map((w) => ({
      keypair: w.keypair, amountIn: w.amountIn, minimumAmountOut: w.minimumAmountOut, label: w.label,
    })),
    computeUnitLimit: cfg.computeUnitLimit,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
    resendMs: cfg.resendMs, fireWindowMs: cfg.fireWindowMs,
    dryRun: DRY,
  });

  for (const event of ['info', 'armed', 'open', 'subscribed', 'trigger', 'firing', 'sent', 'dry-run', 'replanned', 'wallet-ready']) {
    sniper.on(event, (d) => log('info', event, d));
  }
  for (const event of ['warn', 'closed', 'send-error', 'refused', 'abandoned', 'wallet-unusable']) {
    sniper.on(event, (d) => log('warn', event, d));
  }
  sniper.on('error', (d) => log('error', 'error', d));
  sniper.on('wallet-filled', (d) => log('signal', 'WALLET FILLED', d));
  sniper.on('wallet-failed', (d) => log('error', 'WALLET FAILED', d));

  sniper.on('settled', (d) => {
    log('signal', 'SETTLED', d);
    sniper.stop();
    process.exit(d.filled > 0 ? 0 : 1);
  });

  try {
    await sniper.arm();
  } catch (e) {
    die(`arm refused: ${e.message}`);
  }
  sniper.start();
  log('info', 'watching', { mint: cfg.mint.toBase58(), wallets: wallets.length, dryRun: DRY, note: 'ctrl-c to stop' });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('info', 'shutting down', { signal, state: sniper.state, stats: sniper.stats });
      sniper.stop();
      process.exit(sniper.state === STATE.SETTLED ? 0 : 130);
    });
  }
}

// ---------------------------------------------------------------------------

let cfg, wallets;
try {
  cfg = loadSnipeConfig();
  wallets = loadWallets(cfg);
} catch (e) {
  die(e.message);
}

const commands = { plan: commandPlan, prepare: commandPrepare, arm: commandArm };
if (!commands[command]) die(`unknown command "${command}" — expected one of: ${Object.keys(commands).join(', ')}`);

commands[command](cfg, wallets).catch((e) => die(e.stack ?? e.message));
