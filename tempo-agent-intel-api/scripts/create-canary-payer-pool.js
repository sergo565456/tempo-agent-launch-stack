import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const secretsDir = resolve(projectRoot, '.secrets', 'canary-payers');
const dataDir = resolve(projectRoot, '.data', 'canary');

const DEFAULT_TOKEN = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_TOKEN_SYMBOL = 'USDC.e';
const DEFAULT_TOKEN_DECIMALS = 6;
const DEFAULT_COUNT = 10;
const DEFAULT_LIMIT_UNITS = '0.05';
const DEFAULT_EXPIRY_HOURS = 336;

const options = parseArgs(process.argv.slice(2));
const accountModule = await loadViemAccounts();
const createdAt = new Date();
const suffix = `${createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
const poolId = options.poolId || `tempo_canary_payer_pool_${suffix}`;
const poolDir = resolve(secretsDir, poolId);
const limitBaseUnits = decimalToBaseUnits(options.limitUnits, options.tokenDecimals);
const expiresAt = new Date(createdAt.getTime() + options.expiryHours * 60 * 60 * 1000);
const machineBinding = buildMachineBinding();

if (existsSync(poolDir) && !options.force) {
  throw new Error(`Canary payer pool already exists: ${relativeProjectPath(poolDir)}. Use --force only if you intentionally chose this pool id.`);
}

await mkdir(poolDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const wallets = [];

for (let index = 1; index <= options.count; index += 1) {
  const walletLabel = `canary-${String(index).padStart(2, '0')}`;
  const rootPrivateKey = accountModule.generatePrivateKey();
  const rootAccount = accountModule.privateKeyToAccount(rootPrivateKey);
  const accessPrivateKey = accountModule.generatePrivateKey();
  const accessAccount = accountModule.privateKeyToAccount(accessPrivateKey);

  const rootWalletFile = resolve(poolDir, `${walletLabel}-root.owner-only.json`);
  const accessEnvFile = resolve(poolDir, `${walletLabel}-access-key.env`);
  const authorizationPlanFile = resolve(poolDir, `${walletLabel}-authorization-plan.json`);

  const rootWallet = {
    pool_id: poolId,
    wallet_label: walletLabel,
    created_at: createdAt.toISOString(),
    role: 'tempo_canary_payer_root_wallet',
    warning: 'Owner-only canary payer root wallet. Do not copy this private key into service runtime, source code, docs, tickets, or chat.',
    machine_binding: machineBinding,
    chain_context: 'Tempo / EVM-compatible secp256k1 root key',
    address: rootAccount.address,
    private_key: rootPrivateKey,
  };

  const accessKeyEnv = [
    '# Canary payer Access Key only. Used for controlled synthetic health payments into Agent Launch Intel API.',
    '# Do not copy root wallet private keys into runtime, source code, docs, tickets, or chat.',
    `CANARY_POOL_ID=${poolId}`,
    `CANARY_WALLET_LABEL=${walletLabel}`,
    `CANARY_MACHINE_BINDING_HASH=${machineBinding.binding_hash}`,
    `AGENT_ROOT_ACCOUNT_ADDRESS=${rootAccount.address}`,
    `AGENT_ACCESS_KEY_ADDRESS=${accessAccount.address}`,
    `AGENT_ACCESS_KEY_PRIVATE_KEY=${accessPrivateKey}`,
    `AGENT_ACCESS_KEY_EXPIRES_AT=${expiresAt.toISOString()}`,
    `AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON=${JSON.stringify([{ token: options.token, symbol: options.tokenSymbol, decimals: options.tokenDecimals, amount_base_units: limitBaseUnits, amount_units: options.limitUnits }])}`,
    '',
  ].join('\n');

  const authorizationPlan = {
    pool_id: poolId,
    wallet_label: walletLabel,
    created_at: createdAt.toISOString(),
    status: 'generated_locally_not_funded_not_authorized_onchain',
    machine_binding: machineBinding,
    root_account_address: rootAccount.address,
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
      'This wallet is for transparent canary/test payments only, not for pretending to be an organic user.',
      'The root private key is required only to fund/authorize this payer Access Key.',
      'Daily cron runners should use the limited Access Key, not the root key.',
      'Future canary runners should refuse to run if the local machine binding hash does not match this plan.',
    ],
  };

  await writeFile(rootWalletFile, `${JSON.stringify(rootWallet, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(accessEnvFile, accessKeyEnv, { encoding: 'utf8', mode: 0o600 });
  await writeFile(authorizationPlanFile, `${JSON.stringify(authorizationPlan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  wallets.push({
    label: walletLabel,
    root_account_address: rootAccount.address,
    access_key_address: accessAccount.address,
    access_key_expires_at: expiresAt.toISOString(),
    token_limit: {
      token: options.token,
      symbol: options.tokenSymbol,
      amount_units: options.limitUnits,
      amount_base_units: limitBaseUnits,
    },
    status: 'generated_locally_not_funded_not_authorized_onchain',
    files: {
      root_wallet: relativeProjectPath(rootWalletFile),
      access_key_env: relativeProjectPath(accessEnvFile),
      authorization_plan: relativeProjectPath(authorizationPlanFile),
    },
  });
}

const manifest = {
  pool_id: poolId,
  created_at: createdAt.toISOString(),
  status: 'generated_locally_not_funded_not_authorized_onchain',
  purpose: 'Transparent canary payer pool for controlled daily health payments into Agent Launch Intel API.',
  count: wallets.length,
  machine_binding: machineBinding,
  payment_policy: {
    synthetic_activity_label: 'canary',
    max_recommended_payment_per_run_usd: '0.01',
    recommended_schedule: 'at most once per day',
    do_not_count_as_external_organic_users: true,
  },
  token: {
    address: options.token,
    symbol: options.tokenSymbol,
    decimals: options.tokenDecimals,
  },
  access_key_limit: {
    amount_units: options.limitUnits,
    amount_base_units: limitBaseUnits,
    expiry_iso: expiresAt.toISOString(),
  },
  wallets,
  next_steps: [
    'Review the generated addresses and files.',
    'Fund each canary root wallet with a small USDC.e amount only after explicit approval.',
    'Authorize each Access Key on-chain only after explicit approval.',
    'Use only the limited Access Key files for future canary cron payments.',
  ],
};

const manifestFile = resolve(poolDir, 'pool-manifest.json');
const currentPointerFile = resolve(secretsDir, 'current-pool.json');
const publicSummaryFile = resolve(dataDir, `canary-payer-pool-${suffix}-public-summary.json`);

await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await writeFile(currentPointerFile, `${JSON.stringify({
  pool_id: poolId,
  created_at: createdAt.toISOString(),
  pool_manifest: relativeProjectPath(manifestFile),
  machine_binding_hash: machineBinding.binding_hash,
  status: manifest.status,
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await writeFile(publicSummaryFile, `${JSON.stringify(stripPrivatePathsForSummary(manifest, manifestFile), null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  dry_run: false,
  live_actions: false,
  pool_id: poolId,
  count: wallets.length,
  machine_binding_hash: machineBinding.binding_hash,
  access_key_limit: manifest.access_key_limit,
  pool_manifest: relativeProjectPath(manifestFile),
  current_pointer: relativeProjectPath(currentPointerFile),
  public_summary: relativeProjectPath(publicSummaryFile),
  wallets: wallets.map((wallet) => ({
    label: wallet.label,
    root_account_address: wallet.root_account_address,
    access_key_address: wallet.access_key_address,
    access_key_expires_at: wallet.access_key_expires_at,
    status: wallet.status,
  })),
  note: 'Generated locally only. No funding, on-chain authorization, payment, deploy, cron setup, signer request, or external MPP call was executed. Private keys were written only under ignored .secrets/canary-payers.',
}, null, 2));

function parseArgs(args) {
  const values = {
    count: DEFAULT_COUNT,
    token: DEFAULT_TOKEN,
    tokenSymbol: DEFAULT_TOKEN_SYMBOL,
    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
    limitUnits: DEFAULT_LIMIT_UNITS,
    expiryHours: DEFAULT_EXPIRY_HOURS,
    poolId: '',
    force: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--count' && next) {
      values.count = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--token' && next) {
      values.token = next;
      i += 1;
    } else if (arg === '--token-symbol' && next) {
      values.tokenSymbol = next;
      i += 1;
    } else if (arg === '--token-decimals' && next) {
      values.tokenDecimals = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--limit' && next) {
      values.limitUnits = next;
      i += 1;
    } else if (arg === '--expiry-hours' && next) {
      values.expiryHours = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--pool-id' && next) {
      values.poolId = next;
      i += 1;
    } else if (arg === '--force') {
      values.force = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/create-canary-payer-pool.js [--count 10] [--limit 0.05] [--expiry-hours 336] [--pool-id tempo_canary_payer_pool_name]');
      process.exit(0);
    }
  }

  if (!Number.isInteger(values.count) || values.count < 1 || values.count > 50) {
    throw new Error('--count must be an integer from 1 to 50.');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(values.token)) {
    throw new Error(`Invalid token address: ${values.token}`);
  }
  if (!Number.isInteger(values.tokenDecimals) || values.tokenDecimals < 0 || values.tokenDecimals > 36) {
    throw new Error('--token-decimals must be an integer from 0 to 36.');
  }
  if (!/^\d+(\.\d+)?$/.test(values.limitUnits)) {
    throw new Error('--limit must be a positive decimal string.');
  }
  if (BigInt(decimalToBaseUnits(values.limitUnits, values.tokenDecimals)) > BigInt(decimalToBaseUnits('0.50', values.tokenDecimals))) {
    throw new Error('--limit must be <= 0.50 USDC.e per canary Access Key.');
  }
  if (!Number.isInteger(values.expiryHours) || values.expiryHours < 1 || values.expiryHours > 24 * 30) {
    throw new Error('--expiry-hours must be an integer from 1 to 720.');
  }
  if (values.poolId && !/^[a-zA-Z0-9_.-]+$/.test(values.poolId)) {
    throw new Error('--pool-id may contain only letters, numbers, underscore, dot, and dash.');
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
  const bindingHash = createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
  return {
    ...values,
    binding_hash: bindingHash,
    enforcement: 'metadata_only_until_canary_runner_is_added',
  };
}

function stripPrivatePathsForSummary(manifest, manifestFile) {
  return {
    pool_id: manifest.pool_id,
    created_at: manifest.created_at,
    status: manifest.status,
    purpose: manifest.purpose,
    count: manifest.count,
    machine_binding_hash: manifest.machine_binding.binding_hash,
    pool_manifest: relativeProjectPath(manifestFile),
    payment_policy: manifest.payment_policy,
    token: manifest.token,
    access_key_limit: manifest.access_key_limit,
    wallets: manifest.wallets.map((wallet) => ({
      label: wallet.label,
      root_account_address: wallet.root_account_address,
      access_key_address: wallet.access_key_address,
      access_key_expires_at: wallet.access_key_expires_at,
      status: wallet.status,
    })),
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

  throw new Error('Could not find viem accounts module. Install viem locally or keep a sibling project with viem node_modules available.');
}
