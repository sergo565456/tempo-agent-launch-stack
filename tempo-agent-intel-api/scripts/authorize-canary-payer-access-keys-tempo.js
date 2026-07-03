import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { parseEnvText, readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { loadTempoSdk } from '../src/runtime/tempoDeps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const options = parseArgs(process.argv.slice(2));
const runtimeEnv = await readOptionalEnvFile(options.envFile);
const config = getConfig({
  ...process.env,
  ...(runtimeEnv.exists ? runtimeEnv.values : {}),
});
const pointerPath = resolve(projectRoot, options.pointer);
const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
const manifestPath = resolve(projectRoot, pointer.pool_manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const currentBinding = buildMachineBinding();
const expectedBindingHash = manifest.machine_binding?.binding_hash || pointer.machine_binding_hash || '';

if (options.requireMachineBinding && expectedBindingHash !== currentBinding.binding_hash) {
  throw new Error('Current machine binding does not match canary pool manifest.');
}

const sdk = await loadTempoSdk(config);
const eligibleWallets = (manifest.wallets || []).filter((wallet) => wallet.enabled === true && !options.excludeLabels.includes(wallet.label));
const dryRunItems = [];

for (const wallet of eligibleWallets) {
  const rootWallet = JSON.parse(await readFile(resolve(projectRoot, wallet.files.root_wallet), 'utf8'));
  const accessValues = parseEnvText(await readFile(resolve(projectRoot, wallet.files.access_key_env), 'utf8'));
  const plan = JSON.parse(await readFile(resolve(projectRoot, wallet.files.authorization_plan), 'utf8'));
  validateWalletBundle({ wallet, rootWallet, accessValues, plan });
  const state = await readPayerState({ config, sdk, account: wallet.root_account_address, accessKey: wallet.access_key_address, token: config.tempoCurrencyAddress });
  dryRunItems.push({
    label: wallet.label,
    root_account_address: wallet.root_account_address,
    access_key_address: wallet.access_key_address,
    expiry_iso: plan.access_key.expiry_iso,
    token_limit: plan.access_key.limits[0],
    balance: state.balance,
    onchain_authorized: state.authorized,
  });
}

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    live_actions: false,
    pool_id: manifest.pool_id,
    eligible_wallet_count: eligibleWallets.length,
    excluded_labels: options.excludeLabels,
    wallets: dryRunItems,
    next_step: 'Re-run with --confirm-authorize to submit one authorizeKey transaction per eligible canary wallet.',
    note: 'Dry-run only. No on-chain authorization, payment, deploy, cron, signer request, or external MPP call was executed.',
  }, null, 2));
  process.exit(0);
}

const results = [];
for (const wallet of eligibleWallets) {
  const rootWallet = JSON.parse(await readFile(resolve(projectRoot, wallet.files.root_wallet), 'utf8'));
  const accessValues = parseEnvText(await readFile(resolve(projectRoot, wallet.files.access_key_env), 'utf8'));
  const plan = JSON.parse(await readFile(resolve(projectRoot, wallet.files.authorization_plan), 'utf8'));
  const rootAccount = sdk.Account.fromSecp256k1(rootWallet.private_key);
  const accessKey = sdk.Account.fromSecp256k1(accessValues.AGENT_ACCESS_KEY_PRIVATE_KEY, {
    access: rootAccount,
  });
  const before = await readPayerState({ config, sdk, account: wallet.root_account_address, accessKey: wallet.access_key_address, token: config.tempoCurrencyAddress });
  if (before.authorized) {
    results.push({
      label: wallet.label,
      skipped: true,
      reason: 'already_authorized_onchain',
      root_account_address: wallet.root_account_address,
      access_key_address: wallet.access_key_address,
      before,
    });
    continue;
  }

  const tokenLimit = plan.access_key.limits[0];
  const client = sdk.createClient({
    account: rootAccount,
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const result = await sdk.Actions.accessKey.authorizeSync(client, {
    accessKey,
    expiry: plan.access_key.expiry_unix,
    limits: [
      {
        token: tokenLimit.token,
        limit: BigInt(tokenLimit.amount_base_units),
      },
    ],
    throwOnReceiptRevert: true,
  });
  const after = await readPayerState({ config, sdk, account: wallet.root_account_address, accessKey: wallet.access_key_address, token: config.tempoCurrencyAddress });
  const txHash = result.receipt?.transactionHash ?? null;
  results.push({
    label: wallet.label,
    skipped: false,
    root_account_address: wallet.root_account_address,
    access_key_address: wallet.access_key_address,
    transaction_hash: txHash,
    explorer_url: txHash ? `https://explore.tempo.xyz/tx/${txHash}` : null,
    receipt_status: result.receipt?.status ?? null,
    block_number: stringify(result.receipt?.blockNumber),
    before,
    after,
  });
}

const authorizedAt = new Date().toISOString();
const authorizedLabels = new Set(results.filter((item) => item.after?.authorized || item.skipped).map((item) => item.label));
const updatedManifest = {
  ...manifest,
  status: 'canary_access_keys_authorized_onchain',
  authorized_at: authorizedAt,
  wallets: (manifest.wallets || []).map((wallet) => authorizedLabels.has(wallet.label)
    ? { ...wallet, status: 'authorized_onchain', authorized_at: authorizedAt }
    : wallet),
};
await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await writeFile(pointerPath, `${JSON.stringify({ ...pointer, status: updatedManifest.status, authorized_at: authorizedAt }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await writeArtifact({ pool_id: manifest.pool_id, authorized_at: authorizedAt, results });

console.log(JSON.stringify({
  ok: results.every((item) => item.skipped || item.after?.authorized),
  dry_run: false,
  live_actions: true,
  pool_id: manifest.pool_id,
  eligible_wallet_count: eligibleWallets.length,
  authorized_count: results.filter((item) => item.skipped || item.after?.authorized).length,
  results: results.map((item) => ({
    label: item.label,
    skipped: item.skipped,
    root_account_address: item.root_account_address,
    access_key_address: item.access_key_address,
    transaction_hash: item.transaction_hash || null,
    receipt_status: item.receipt_status || null,
    authorized_after: item.after?.authorized ?? item.before?.authorized ?? false,
  })),
  note: 'Submitted canary Access Key authorization transactions only. No report payment, deploy, cron bearer route, signer request, or external MPP service call was executed.',
}, null, 2));

async function readPayerState({ config, sdk, account, accessKey, token }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const balance = await sdk.Actions.token.getBalance(readClient, { account, token });
  let authorized = false;
  let metadata = null;
  let remaining = null;
  try {
    const keyMetadata = await sdk.Actions.accessKey.getMetadata(readClient, { account, accessKey });
    const keyRemaining = await sdk.Actions.accessKey.getRemainingLimit(readClient, { account, accessKey, token });
    metadata = {
      expiry: stringify(keyMetadata.expiry),
      is_revoked: keyMetadata.isRevoked,
    };
    remaining = formatBalance(keyRemaining.remaining, config.tempoTokenDecimals);
    authorized = !keyMetadata.isRevoked && BigInt(stringify(keyMetadata.expiry)) > BigInt(Math.floor(Date.now() / 1000));
  } catch (error) {
    metadata = { error: error.message };
  }
  return {
    balance: formatBalance(balance, config.tempoTokenDecimals),
    authorized,
    metadata,
    remaining_limit: remaining,
  };
}

function validateWalletBundle({ wallet, rootWallet, accessValues, plan }) {
  if (rootWallet.address.toLowerCase() !== wallet.root_account_address.toLowerCase()) {
    throw new Error(`${wallet.label}: root wallet address mismatch.`);
  }
  if (accessValues.AGENT_ROOT_ACCOUNT_ADDRESS.toLowerCase() !== wallet.root_account_address.toLowerCase()) {
    throw new Error(`${wallet.label}: access env root mismatch.`);
  }
  if (accessValues.AGENT_ACCESS_KEY_ADDRESS.toLowerCase() !== wallet.access_key_address.toLowerCase()) {
    throw new Error(`${wallet.label}: access env address mismatch.`);
  }
  if (plan.root_account_address.toLowerCase() !== wallet.root_account_address.toLowerCase()) {
    throw new Error(`${wallet.label}: authorization plan root mismatch.`);
  }
  if (plan.access_key.address.toLowerCase() !== wallet.access_key_address.toLowerCase()) {
    throw new Error(`${wallet.label}: authorization plan access key mismatch.`);
  }
}

async function writeArtifact(output) {
  const artifactDir = resolve(projectRoot, '.data/canary');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `canary-access-key-authorization-${Date.now()}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8',
  );
}

function parseArgs(args) {
  const values = {
    pointer: '.secrets/canary-payers/current-pool.json',
    envFile: '.secrets/mpp-runtime.env',
    excludeLabels: [],
    requireMachineBinding: true,
    confirm: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--pointer' && next) {
      values.pointer = next;
      i += 1;
    } else if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--exclude-label' && next) {
      values.excludeLabels.push(next);
      i += 1;
    } else if (arg === '--allow-other-machine') {
      values.requireMachineBinding = false;
    } else if (arg === '--confirm-authorize') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/authorize-canary-payer-access-keys-tempo.js [--confirm-authorize]');
      process.exit(0);
    }
  }
  return values;
}

function buildMachineBinding() {
  const user = os.userInfo();
  const values = {
    hostname: os.hostname(),
    username: user.username,
    platform: process.platform,
    arch: process.arch,
    user_domain: process.env.USERDOMAIN || '',
    computer_name: process.env.COMPUTERNAME || '',
  };
  return { ...values, binding_hash: createHash('sha256').update(JSON.stringify(values)).digest('hex') };
}

function formatBalance(raw, decimals) {
  const value = coerceBaseUnits(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return { raw: value.toString(), formatted: fraction ? `${whole}.${fraction}` : `${whole}.00` };
}

function coerceBaseUnits(raw) {
  if (raw === undefined || raw === null) return 0n;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(raw);
  if (typeof raw === 'string') return BigInt(raw);
  if (typeof raw === 'object') {
    for (const key of ['raw', 'value', 'balance', 'amount', 'amountBaseUnits', 'baseUnits', 'remaining']) {
      if (raw[key] !== undefined && raw[key] !== null) return coerceBaseUnits(raw[key]);
    }
    const text = raw.toString?.();
    if (text && text !== '[object Object]') return BigInt(text);
    throw new Error(`Unsupported token amount object keys: ${Object.keys(raw).join(', ')}`);
  }
  throw new Error(`Unsupported token amount type: ${typeof raw}`);
}

function stringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || value === null) return null;
  return String(value);
}
