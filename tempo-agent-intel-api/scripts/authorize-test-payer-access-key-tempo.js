import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { readOptionalEnvFile, parseEnvText } from '../src/runtime/envFiles.js';
import { loadTempoSdk } from '../src/runtime/tempoDeps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';

const options = parseArgs(process.argv.slice(2));
const runtimeEnv = await readOptionalEnvFile(options.envFile);
const config = getConfig({
  ...process.env,
  ...(runtimeEnv.exists ? runtimeEnv.values : {}),
});
const payerPointerPath = resolve(projectRoot, options.payerPointer);
const payerPointer = JSON.parse(await readFile(payerPointerPath, 'utf8'));
const rootWallet = JSON.parse(await readFile(resolve(projectRoot, payerPointer.files.root_wallet), 'utf8'));
const accessValues = parseEnvText(await readFile(resolve(projectRoot, payerPointer.files.access_key_env), 'utf8'));
const plan = JSON.parse(await readFile(resolve(projectRoot, payerPointer.files.authorization_plan), 'utf8'));
const sdk = await loadTempoSdk(config);

const tokenLimit = plan.access_key?.limits?.[0] ?? null;
assertAddress(rootWallet.address, 'root wallet address');
assertPrivateKey(rootWallet.private_key, 'root wallet private key');
assertPrivateKey(accessValues.AGENT_ACCESS_KEY_PRIVATE_KEY, 'payer access private key');
assertAddress(plan.access_key?.address, 'plan access key address');

if (rootWallet.address.toLowerCase() !== plan.root_account_address.toLowerCase()) {
  throw new Error('Payer root wallet does not match authorization plan');
}
if (rootWallet.address.toLowerCase() !== accessValues.AGENT_ROOT_ACCOUNT_ADDRESS.toLowerCase()) {
  throw new Error('Payer root wallet does not match payer access env');
}
if (!tokenLimit || tokenLimit.token.toLowerCase() !== USDC_E.toLowerCase()) {
  throw new Error('Payer Access Key token limit must target Tempo USDC.e');
}
if (Number(plan.access_key.expiry_unix) <= Math.floor(Date.now() / 1000)) {
  throw new Error('Payer Access Key expiry is not in the future');
}

const rootAccount = sdk.Account.fromSecp256k1(rootWallet.private_key);
const accessKey = sdk.Account.fromSecp256k1(accessValues.AGENT_ACCESS_KEY_PRIVATE_KEY, {
  access: rootAccount,
});

if (rootAccount.address.toLowerCase() !== rootWallet.address.toLowerCase()) {
  throw new Error('Payer root private key does not match root wallet address');
}
if (accessKey.accessKeyAddress.toLowerCase() !== plan.access_key.address.toLowerCase()) {
  throw new Error('Payer access private key does not match authorization plan');
}

const client = sdk.createClient({
  account: rootAccount,
  chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
  transport: sdk.http(config.tempoRpcUrl),
});

const before = await readPayerState({ config, sdk, account: rootAccount.address, accessKey: plan.access_key.address, token: tokenLimit.token });

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    payer_root_account: rootAccount.address,
    payer_access_key: accessKey.accessKeyAddress,
    expiry_iso: plan.access_key.expiry_iso,
    token_limit: tokenLimit,
    before,
    next_step: 'Re-run with --confirm-authorize to submit exactly one authorizeKey transaction from the payer root wallet.',
  }, null, 2));
  process.exit(0);
}

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
const after = await readPayerState({ config, sdk, account: rootAccount.address, accessKey: plan.access_key.address, token: tokenLimit.token });
const txHash = result.receipt?.transactionHash ?? null;
const output = {
  ok: true,
  dry_run: false,
  payer_root_account: rootAccount.address,
  payer_access_key: accessKey.accessKeyAddress,
  transaction_hash: txHash,
  explorer_url: txHash ? `https://explore.tempo.xyz/tx/${txHash}` : null,
  receipt_status: result.receipt?.status ?? null,
  block_number: stringify(result.receipt?.blockNumber),
  before,
  after,
};

await writeArtifact(output);
await writeFile(payerPointerPath, JSON.stringify({
  ...payerPointer,
  status: 'authorized_onchain',
  authorization: {
    transaction_hash: txHash,
    explorer_url: output.explorer_url,
    receipt_status: output.receipt_status,
    block_number: output.block_number,
    authorized_at: new Date().toISOString(),
  },
}, null, 2), 'utf8');

console.log(JSON.stringify(output, null, 2));

async function readPayerState({ config, sdk, account, accessKey, token }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const balance = await sdk.Actions.token.getBalance(readClient, { account, token });
  let metadata = null;
  let remaining = null;
  try {
    const keyMetadata = await sdk.Actions.accessKey.getMetadata(readClient, { account, accessKey });
    const keyRemaining = await sdk.Actions.accessKey.getRemainingLimit(readClient, { account, accessKey, token });
    metadata = {
      address: keyMetadata.address,
      key_type: keyMetadata.keyType,
      expiry: stringify(keyMetadata.expiry),
      spend_policy: keyMetadata.spendPolicy,
      is_revoked: keyMetadata.isRevoked,
    };
    remaining = formatBalance(keyRemaining.remaining, config.tempoTokenDecimals);
  } catch (error) {
    metadata = { error: error.message };
  }

  return {
    balance: formatBalance(balance, config.tempoTokenDecimals),
    access_key_metadata: metadata,
    remaining_limit: remaining,
  };
}

async function writeArtifact(output) {
  const artifactDir = resolve(projectRoot, '.data/live');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `tempo-test-payer-access-key-authorization-${Date.now()}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8',
  );
}

function parseArgs(args) {
  const values = {
    envFile: '.secrets/mpp-runtime.env',
    payerPointer: '.secrets/test-payer-current.json',
    confirm: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--payer-pointer' && next) {
      values.payerPointer = next;
      i += 1;
    } else if (arg === '--confirm-authorize') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/authorize-test-payer-access-key-tempo.js [--confirm-authorize]');
      process.exit(0);
    }
  }

  return values;
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function assertPrivateKey(value, label) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value || '')) {
    throw new Error(`${label} must be a valid private key`);
  }
}

function formatBalance(raw, decimals) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return {
    raw: value.toString(),
    formatted: fraction ? `${whole}.${fraction}` : `${whole}.00`,
  };
}

function stringify(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}
