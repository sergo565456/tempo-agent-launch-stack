import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const dataDir = resolve(projectRoot, '.data', 'canary');

const DEFAULT_TOKEN = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_TOKEN_SYMBOL = 'USDC.e';
const DEFAULT_TOKEN_DECIMALS = 6;
const DEFAULT_LIMIT_UNITS = '0.20';
const DEFAULT_EXPIRY_HOURS = 1800;

const options = parseArgs(process.argv.slice(2));
const accountModule = await loadViemAccounts();
const pointerPath = resolve(projectRoot, options.pointer);
const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
const manifestPath = resolve(projectRoot, pointer.pool_manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const currentBinding = buildMachineBinding();
const expectedBindingHash = manifest.machine_binding?.binding_hash || pointer.machine_binding_hash || '';

if (options.requireMachineBinding && expectedBindingHash !== currentBinding.binding_hash) {
  throw new Error('Current machine binding does not match canary pool manifest.');
}

const createdAt = new Date();
const suffix = `${createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
const expiresAt = new Date(createdAt.getTime() + options.expiryHours * 60 * 60 * 1000);
const limitBaseUnits = decimalToBaseUnits(options.limitUnits, options.tokenDecimals);
const excludedLabels = new Set(options.excludeLabels);

const updatedWallets = [];
for (const wallet of manifest.wallets || []) {
  if (excludedLabels.has(wallet.label)) {
    updatedWallets.push({
      ...wallet,
      enabled: false,
      status: 'excluded_underfunded',
      exclusion_reason: 'underfunded_canary_wallet_excluded_from_daily_cron',
    });
    continue;
  }

  const accessPrivateKey = accountModule.generatePrivateKey();
  const accessAccount = accountModule.privateKeyToAccount(accessPrivateKey);
  const accessEnvPath = resolve(manifestDir(manifestPath), `${wallet.label}-access-key.${suffix}.env`);
  const authorizationPlanPath = resolve(manifestDir(manifestPath), `${wallet.label}-authorization-plan.${suffix}.json`);

  const accessKeyEnv = [
    '# Canary payer Access Key only. Used for controlled synthetic health payments into Agent Launch Intel API.',
    '# Do not copy root wallet private keys into runtime, source code, docs, tickets, or chat.',
    `CANARY_POOL_ID=${manifest.pool_id}`,
    `CANARY_WALLET_LABEL=${wallet.label}`,
    `CANARY_MACHINE_BINDING_HASH=${expectedBindingHash}`,
    `AGENT_ROOT_ACCOUNT_ADDRESS=${wallet.root_account_address}`,
    `AGENT_ACCESS_KEY_ADDRESS=${accessAccount.address}`,
    `AGENT_ACCESS_KEY_PRIVATE_KEY=${accessPrivateKey}`,
    `AGENT_ACCESS_KEY_EXPIRES_AT=${expiresAt.toISOString()}`,
    `AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON=${JSON.stringify([{ token: options.token, symbol: options.tokenSymbol, decimals: options.tokenDecimals, amount_base_units: limitBaseUnits, amount_units: options.limitUnits }])}`,
    '',
  ].join('\n');

  const authorizationPlan = {
    pool_id: manifest.pool_id,
    wallet_label: wallet.label,
    created_at: createdAt.toISOString(),
    status: 'generated_locally_not_authorized_onchain',
    machine_binding: manifest.machine_binding,
    root_account_address: wallet.root_account_address,
    access_key: {
      address: accessAccount.address,
      signature_type: 0,
      signature_type_name: 'Secp256k1',
      expiry_unix: Math.floor(expiresAt.getTime() / 1000),
      expiry_iso: expiresAt.toISOString(),
      enforce_limits: true,
      limits: [
        {
          token: options.token,
          symbol: options.tokenSymbol,
          decimals: options.tokenDecimals,
          amount_units: options.limitUnits,
          amount_base_units: limitBaseUnits,
        },
      ],
    },
    security_notes: [
      'This is a transparent canary/test Access Key, not an organic user key.',
      'The root private key is required only to authorize this payer Access Key.',
      'Daily cron runners must use this limited Access Key, not the root key.',
      'Canary runners must refuse to run if the machine binding hash does not match this plan.',
    ],
  };

  await writeFile(accessEnvPath, accessKeyEnv, { encoding: 'utf8', mode: 0o600 });
  await writeFile(authorizationPlanPath, `${JSON.stringify(authorizationPlan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  updatedWallets.push({
    ...wallet,
    enabled: true,
    status: 'generated_locally_not_authorized_onchain',
    access_key_address: accessAccount.address,
    access_key_expires_at: expiresAt.toISOString(),
    token_limit: {
      token: options.token,
      symbol: options.tokenSymbol,
      amount_units: options.limitUnits,
      amount_base_units: limitBaseUnits,
    },
    files: {
      ...wallet.files,
      access_key_env: relativeProjectPath(accessEnvPath),
      authorization_plan: relativeProjectPath(authorizationPlanPath),
    },
  });
}

const updatedManifest = {
  ...manifest,
  status: 'access_keys_refreshed_not_authorized_onchain',
  updated_at: createdAt.toISOString(),
  excluded_labels: [...excludedLabels],
  access_key_limit: {
    amount_units: options.limitUnits,
    amount_base_units: limitBaseUnits,
    expiry_iso: expiresAt.toISOString(),
  },
  wallets: updatedWallets,
};

await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await writeFile(pointerPath, `${JSON.stringify({
  ...pointer,
  status: updatedManifest.status,
  updated_at: updatedManifest.updated_at,
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

const publicSummaryPath = resolve(dataDir, `canary-payer-pool-access-refresh-${suffix}-public-summary.json`);
await writeFile(publicSummaryPath, `${JSON.stringify(stripForPublicSummary(updatedManifest, manifestPath), null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  live_actions: false,
  pool_id: updatedManifest.pool_id,
  status: updatedManifest.status,
  excluded_labels: updatedManifest.excluded_labels,
  enabled_wallet_count: updatedWallets.filter((wallet) => wallet.enabled === true).length,
  access_key_limit: updatedManifest.access_key_limit,
  pool_manifest: relativeProjectPath(manifestPath),
  public_summary: relativeProjectPath(publicSummaryPath),
  wallets: updatedWallets.map((wallet) => ({
    label: wallet.label,
    enabled: wallet.enabled === true,
    status: wallet.status,
    root_account_address: wallet.root_account_address,
    access_key_address: wallet.access_key_address,
    access_key_expires_at: wallet.access_key_expires_at,
  })),
  note: 'Local Access Key refresh only. No funding, on-chain authorization, payment, deploy, cron, signer request, or external MPP call was executed.',
}, null, 2));

function parseArgs(args) {
  const values = {
    pointer: '.secrets/canary-payers/current-pool.json',
    excludeLabels: ['canary-04'],
    token: DEFAULT_TOKEN,
    tokenSymbol: DEFAULT_TOKEN_SYMBOL,
    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
    limitUnits: DEFAULT_LIMIT_UNITS,
    expiryHours: DEFAULT_EXPIRY_HOURS,
    requireMachineBinding: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--pointer' && next) {
      values.pointer = next;
      i += 1;
    } else if (arg === '--exclude-label' && next) {
      values.excludeLabels.push(next);
      i += 1;
    } else if (arg === '--no-default-excludes') {
      values.excludeLabels = [];
    } else if (arg === '--limit' && next) {
      values.limitUnits = next;
      i += 1;
    } else if (arg === '--expiry-hours' && next) {
      values.expiryHours = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--allow-other-machine') {
      values.requireMachineBinding = false;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/refresh-canary-payer-access-keys.js [--exclude-label canary-04] [--limit 0.20] [--expiry-hours 1800]');
      process.exit(0);
    }
  }

  values.excludeLabels = [...new Set(values.excludeLabels)];
  if (!/^\d+(\.\d{1,6})?$/.test(values.limitUnits)) {
    throw new Error('--limit must be a decimal string with up to 6 decimals.');
  }
  if (BigInt(decimalToBaseUnits(values.limitUnits, values.tokenDecimals)) > BigInt(decimalToBaseUnits('0.50', values.tokenDecimals))) {
    throw new Error('--limit must be <= 0.50 USDC.e per canary Access Key.');
  }
  if (!Number.isInteger(values.expiryHours) || values.expiryHours < 1 || values.expiryHours > 24 * 90) {
    throw new Error('--expiry-hours must be an integer from 1 to 2160.');
  }
  return values;
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount has more fractional digits than token decimals (${decimals}).`);
  }
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

function stripForPublicSummary(manifest, manifestPath) {
  return {
    pool_id: manifest.pool_id,
    status: manifest.status,
    updated_at: manifest.updated_at,
    excluded_labels: manifest.excluded_labels,
    pool_manifest: relativeProjectPath(manifestPath),
    access_key_limit: manifest.access_key_limit,
    wallets: manifest.wallets.map((wallet) => ({
      label: wallet.label,
      enabled: wallet.enabled === true,
      status: wallet.status,
      root_account_address: wallet.root_account_address,
      access_key_address: wallet.access_key_address,
      access_key_expires_at: wallet.access_key_expires_at,
    })),
  };
}

function manifestDir(path) {
  return path.replace(/[\\/][^\\/]+$/, '');
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
  return {
    ...values,
    binding_hash: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
  };
}

function relativeProjectPath(path) {
  return path.replace(`${projectRoot}\\`, '').replaceAll('\\', '/');
}

async function loadViemAccounts() {
  const candidates = [
    resolve(projectRoot, 'node_modules/viem/_esm/accounts/index.js'),
    resolve(projectRoot, '..', 'tempo-agent-spend-firewall/node_modules/viem/_esm/accounts/index.js'),
    resolve(projectRoot, '..', 'trust402/node_modules/viem/_esm/accounts/index.js'),
    resolve(projectRoot, '..', 'proof402/node_modules/viem/_esm/accounts/index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return import(pathToFileURL(candidate));
    }
  }

  throw new Error('Could not find viem accounts module.');
}
