import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const secretsDir = resolve(projectRoot, '.secrets');

const DEFAULT_TOKEN = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_TOKEN_SYMBOL = 'USDC.e';
const DEFAULT_LIMIT_UNITS = '0.50';
const DEFAULT_TOKEN_DECIMALS = 6;
const DEFAULT_EXPIRY_HOURS = 168;

const options = parseArgs(process.argv.slice(2));
const accountModule = await loadViemAccounts();
const createdAt = new Date();
const expiresAt = new Date(createdAt.getTime() + options.expiryHours * 60 * 60 * 1000);
const suffix = `${createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
const bundleId = `tempo_test_payer_${suffix}`;

const accessPrivateKey = accountModule.generatePrivateKey();
const accessAccount = accountModule.privateKeyToAccount(accessPrivateKey);
const limitBaseUnits = decimalToBaseUnits(options.limitUnits, options.tokenDecimals);

let rootPrivateKey = '';
let rootAccount = null;
let rootWallet = null;
let rootWalletPath = resolve(secretsDir, `test-payer-root-wallet.${suffix}.owner-only.json`);
let rootWalletWritten = true;

if (options.reuseCurrentRoot) {
  const currentPointer = JSON.parse(await readFile(resolve(projectRoot, options.payerPointer), 'utf8'));
  rootWalletPath = resolve(projectRoot, currentPointer.files.root_wallet);
  rootWallet = JSON.parse(await readFile(rootWalletPath, 'utf8'));
  rootPrivateKey = rootWallet.private_key;
  rootAccount = accountModule.privateKeyToAccount(rootPrivateKey);
  if (rootAccount.address.toLowerCase() !== rootWallet.address.toLowerCase()) {
    throw new Error('Existing test payer root private key does not match root wallet address.');
  }
  rootWalletWritten = false;
} else {
  rootPrivateKey = accountModule.generatePrivateKey();
  rootAccount = accountModule.privateKeyToAccount(rootPrivateKey);
  rootWallet = {
    bundle_id: bundleId,
    created_at: createdAt.toISOString(),
    role: 'tempo_test_payer_root_wallet',
    warning: 'Owner-only test payer root wallet. Do not copy this private key into service runtime, source code, docs, tickets, or chat.',
    chain_context: 'Tempo / EVM-compatible secp256k1 root key',
    address: rootAccount.address,
    private_key: rootPrivateKey,
  };
}

const accessKeyEnvPath = resolve(secretsDir, `test-payer-access-key.${suffix}.env`);
const authorizationPlanPath = resolve(secretsDir, `test-payer-access-key-authorization-plan.${suffix}.json`);
const currentPointerPath = resolve(secretsDir, 'test-payer-current.json');

await mkdir(secretsDir, { recursive: true });

const accessKeyEnv = [
  '# Test payer Access Key only. This key is for controlled payments into the agent service.',
  '# Do not add this root wallet private key to the agent service runtime.',
  `AGENT_ROOT_ACCOUNT_ADDRESS=${rootAccount.address}`,
  `AGENT_ACCESS_KEY_ADDRESS=${accessAccount.address}`,
  `AGENT_ACCESS_KEY_PRIVATE_KEY=${accessPrivateKey}`,
  `AGENT_ACCESS_KEY_EXPIRES_AT=${expiresAt.toISOString()}`,
  `AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON=${JSON.stringify([{ token: options.token, symbol: options.tokenSymbol, decimals: options.tokenDecimals, amount_base_units: limitBaseUnits, amount_units: options.limitUnits }])}`,
  '',
].join('\n');

const authorizationPlan = {
  bundle_id: bundleId,
  created_at: createdAt.toISOString(),
  status: 'generated_locally_not_authorized_onchain',
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
    'This root wallet is for testing payer behavior only.',
    'The payer root private key is required only to authorize its payer Access Key.',
    'Use the payer Access Key, not the payer root key, for repeat payment tests.',
  ],
};

const currentPointer = {
  bundle_id: bundleId,
  created_at: createdAt.toISOString(),
  root_account_address: rootAccount.address,
  access_key_address: accessAccount.address,
  access_key_expires_at: expiresAt.toISOString(),
  token_limit: {
    token: options.token,
    symbol: options.tokenSymbol,
    amount_units: options.limitUnits,
    amount_base_units: limitBaseUnits,
  },
  files: {
    root_wallet: relativeSecretPath(rootWalletPath),
    access_key_env: relativeSecretPath(accessKeyEnvPath),
    authorization_plan: relativeSecretPath(authorizationPlanPath),
  },
  status: 'generated_locally_not_authorized_onchain',
};

if (rootWalletWritten) {
  await writeFile(rootWalletPath, JSON.stringify(rootWallet, null, 2), { encoding: 'utf8', mode: 0o600 });
}
await writeFile(accessKeyEnvPath, accessKeyEnv, { encoding: 'utf8', mode: 0o600 });
await writeFile(authorizationPlanPath, JSON.stringify(authorizationPlan, null, 2), { encoding: 'utf8', mode: 0o600 });
await writeFile(currentPointerPath, JSON.stringify(currentPointer, null, 2), { encoding: 'utf8', mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  bundle_id: bundleId,
  root_account_address: rootAccount.address,
  access_key_address: accessAccount.address,
  access_key_expires_at: expiresAt.toISOString(),
  token_limit: currentPointer.token_limit,
  reused_existing_root_wallet: !rootWalletWritten,
  root_wallet: relativeSecretPath(rootWalletPath),
  files_written: [
    ...(rootWalletWritten ? [relativeSecretPath(rootWalletPath)] : []),
    relativeSecretPath(accessKeyEnvPath),
    relativeSecretPath(authorizationPlanPath),
    relativeSecretPath(currentPointerPath),
  ],
  next_step: 'Fund the test payer root wallet, then authorize its Access Key on-chain.',
}, null, 2));

function parseArgs(args) {
  const values = {
    token: DEFAULT_TOKEN,
    tokenSymbol: DEFAULT_TOKEN_SYMBOL,
    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
    limitUnits: DEFAULT_LIMIT_UNITS,
    expiryHours: DEFAULT_EXPIRY_HOURS,
    payerPointer: '.secrets/test-payer-current.json',
    reuseCurrentRoot: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--token' && next) {
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
    } else if (arg === '--payer-pointer' && next) {
      values.payerPointer = next;
      i += 1;
    } else if (arg === '--reuse-current-root') {
      values.reuseCurrentRoot = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/create-test-payer-wallet.js [--limit 0.50] [--expiry-hours 168] [--reuse-current-root] [--payer-pointer .secrets/test-payer-current.json]');
      process.exit(0);
    }
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(values.token)) {
    throw new Error(`Invalid token address: ${values.token}`);
  }
  if (!Number.isInteger(values.tokenDecimals) || values.tokenDecimals < 0 || values.tokenDecimals > 36) {
    throw new Error('token decimals must be an integer from 0 to 36');
  }
  if (!/^\d+(\.\d+)?$/.test(values.limitUnits)) {
    throw new Error('limit must be a positive decimal string');
  }
  if (!Number.isInteger(values.expiryHours) || values.expiryHours < 1) {
    throw new Error('expiry-hours must be a positive integer');
  }

  return values;
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = decimal.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  if (fraction.length > decimals) {
    throw new Error(`limit has more fractional digits than token decimals (${decimals})`);
  }
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(paddedFraction || '0')).toString();
}

function relativeSecretPath(path) {
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
