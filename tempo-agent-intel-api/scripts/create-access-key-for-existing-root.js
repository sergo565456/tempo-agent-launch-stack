import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const secretsDir = resolve(projectRoot, '.secrets');

const DEFAULT_TOKEN = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_TOKEN_SYMBOL = 'USDC.e';
const DEFAULT_LIMIT_UNITS = '1.00';
const DEFAULT_TOKEN_DECIMALS = 6;
const DEFAULT_EXPIRY_HOURS = 168;

const options = parseArgs(process.argv.slice(2));
const accountModule = await loadViemAccounts();
const createdAt = new Date();
const expiresAt = new Date(createdAt.getTime() + options.expiryHours * 60 * 60 * 1000);
const accessPrivateKey = accountModule.generatePrivateKey();
const accessAccount = accountModule.privateKeyToAccount(accessPrivateKey);
const limitBaseUnits = decimalToBaseUnits(options.limitUnits, options.tokenDecimals);
const suffix = `${createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
const bundleId = `agent_launch_intel_access_${suffix}`;

await mkdir(secretsDir, { recursive: true });

const accessKeyEnvPath = resolve(secretsDir, `agent-access-key.${suffix}.env`);
const authorizationPlanPath = resolve(secretsDir, `access-key-authorization-plan.${suffix}.json`);

const accessKeyEnv = [
  '# Agent Access Key only. This is a secondary key for the existing owner/root wallet.',
  '# Do not add the owner/root private key to any app env file.',
  `AGENT_ROOT_ACCOUNT_ADDRESS=${options.rootAddress}`,
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
  root_account_address: options.rootAddress,
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
  tempo_account_keychain: {
    precompile: '0xAAAAAAAA00000000000000000000000000000000',
    authorize_signature: 'authorizeKey(address,uint8,uint64,bool,(address,uint256)[])',
    cast_template: [
      'cast send 0xAAAAAAAA00000000000000000000000000000000',
      "'authorizeKey(address,uint8,uint64,bool,(address,uint256)[])'",
      `${accessAccount.address} 0 ${Math.floor(expiresAt.getTime() / 1000)} true "[(\"${options.token}\",${limitBaseUnits})]"`,
      '--rpc-url $TEMPO_RPC_URL',
      '--private-key $ROOT_PRIVATE_KEY',
    ].join(' '),
  },
  security_notes: [
    'This script does not read or write the owner/root private key.',
    'The spending limit is not enforceable on-chain until the owner/root wallet signs and submits authorizeKey.',
    'Current AccountKeychain limits apply to documented TIP-20 token flows, not every possible native value or contract interaction.',
    'Use app-level outbound spend caps even after Access Key authorization.',
  ],
};

await writeFile(accessKeyEnvPath, accessKeyEnv, { encoding: 'utf8', mode: 0o600 });
await writeFile(authorizationPlanPath, JSON.stringify(authorizationPlan, null, 2), { encoding: 'utf8', mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  bundle_id: bundleId,
  root_account_address: options.rootAddress,
  access_key_address: accessAccount.address,
  access_key_expires_at: expiresAt.toISOString(),
  token_limit: {
    token: options.token,
    symbol: options.tokenSymbol,
    amount_units: options.limitUnits,
    amount_base_units: limitBaseUnits,
  },
  files_written: [
    relativeSecretPath(accessKeyEnvPath),
    relativeSecretPath(authorizationPlanPath),
  ],
  next_step: 'Authorize this access key on-chain with the owner/root wallet only after explicit transaction approval.',
}, null, 2));

function parseArgs(args) {
  const values = {
    rootAddress: '',
    token: DEFAULT_TOKEN,
    tokenSymbol: DEFAULT_TOKEN_SYMBOL,
    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
    limitUnits: DEFAULT_LIMIT_UNITS,
    expiryHours: DEFAULT_EXPIRY_HOURS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--root-address' && next) {
      values.rootAddress = next;
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
    } else if (arg === '--help') {
      console.log('Usage: node scripts/create-access-key-for-existing-root.js --root-address 0x... [--limit 1.00] [--expiry-hours 168]');
      process.exit(0);
    }
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(values.rootAddress)) {
    throw new Error('--root-address must be a valid EVM address');
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
  const base = BigInt(whole || '0') * 10n ** BigInt(decimals);
  const frac = BigInt(paddedFraction || '0');
  return (base + frac).toString();
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
