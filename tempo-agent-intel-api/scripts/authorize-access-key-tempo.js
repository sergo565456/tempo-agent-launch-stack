import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const workspaceRoot = resolve(projectRoot, '..');
const defaultDepsRoot = resolve(workspaceRoot, 'tempo-agent-spend-firewall');
const defaultSignerEnv = resolve(defaultDepsRoot, '.local/secrets/agent-hot-wallet.env');
const defaultPlanPath = resolve(projectRoot, '.secrets/access-key-authorization-plan.20260606T012346_f2fe5409.json');
const defaultAccessEnvPath = resolve(projectRoot, '.secrets/agent-access-key.20260606T012346_f2fe5409.env');
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_RPC_URL = 'https://rpc.tempo.xyz';
const TEMPO_CHAIN_ID = 4217;

const options = parseArgs(process.argv.slice(2));
const depsRoot = resolve(options.depsRoot);
const { createClient, http, Account, Actions, tempo } = await loadTempoSdk(depsRoot);

const plan = JSON.parse(await readFile(options.plan, 'utf8'));
const signerValues = parseEnvText(await readFile(options.signerEnv, 'utf8'));
const accessValues = parseEnvText(await readFile(options.accessEnv, 'utf8'));

const rootPrivateKey = signerValues.AGENT_PRIVATE_KEY ?? '';
const expectedRootAddress = signerValues.AGENT_WALLET_ADDRESS ?? '';
const accessPrivateKey = accessValues.AGENT_ACCESS_KEY_PRIVATE_KEY ?? '';
const expectedAccessAddress = plan.access_key?.address ?? '';
const tokenLimit = plan.access_key?.limits?.[0] ?? null;

assertAddress(expectedRootAddress, 'AGENT_WALLET_ADDRESS');
assertPrivateKey(rootPrivateKey, 'AGENT_PRIVATE_KEY');
assertPrivateKey(accessPrivateKey, 'AGENT_ACCESS_KEY_PRIVATE_KEY');
assertAddress(expectedAccessAddress, 'plan.access_key.address');

if (plan.status !== 'generated_locally_not_authorized_onchain') {
  throw new Error(`Unexpected plan status: ${plan.status}`);
}

if (plan.root_account_address.toLowerCase() !== expectedRootAddress.toLowerCase()) {
  throw new Error(`Plan root ${plan.root_account_address} does not match signer wallet ${expectedRootAddress}`);
}

if (Number(plan.access_key?.expiry_unix ?? 0) <= Math.floor(Date.now() / 1000)) {
  throw new Error(`Access key expiry is not in the future: ${plan.access_key?.expiry_iso}`);
}

if (!tokenLimit || tokenLimit.token.toLowerCase() !== USDC_E.toLowerCase()) {
  throw new Error('Plan token limit must target Tempo USDC.e');
}

if (!/^\d+$/.test(String(tokenLimit.amount_base_units)) || BigInt(tokenLimit.amount_base_units) <= 0n) {
  throw new Error(`Plan token limit must be a positive base-unit integer, got ${tokenLimit.amount_base_units}`);
}

const maxLimitBaseUnits = decimalToBaseUnits(options.maxLimitUnits, tokenLimit.decimals ?? 6);
if (BigInt(tokenLimit.amount_base_units) > BigInt(maxLimitBaseUnits)) {
  throw new Error(`Plan token limit ${tokenLimit.amount_base_units} exceeds max allowed ${maxLimitBaseUnits} (${options.maxLimitUnits} USDC.e)`);
}

const rootAccount = Account.fromSecp256k1(rootPrivateKey);
const accessKey = Account.fromSecp256k1(accessPrivateKey, { access: rootAccount });

if (rootAccount.address.toLowerCase() !== expectedRootAddress.toLowerCase()) {
  throw new Error('Root private key does not match AGENT_WALLET_ADDRESS');
}

if (accessKey.accessKeyAddress.toLowerCase() !== expectedAccessAddress.toLowerCase()) {
  throw new Error('Access key private key does not match authorization plan');
}

const client = createClient({
  account: rootAccount,
  chain: tempo.extend({ feeToken: USDC_E }),
  transport: http(TEMPO_RPC_URL),
});

const balanceBeforeRaw = await getErc20Balance({
  tokenAddress: USDC_E,
  walletAddress: rootAccount.address,
});

const before = await readAccessKeyState(client, {
  account: rootAccount.address,
  accessKey: expectedAccessAddress,
  token: USDC_E,
});

if (before.metadata.expiry !== '0') {
  throw new Error(`Access key already appears authorized with expiry ${before.metadata.expiry}`);
}

const summary = {
  network: {
    name: 'tempo-mainnet',
    chain_id: TEMPO_CHAIN_ID,
    rpc_url: TEMPO_RPC_URL,
    fee_token: USDC_E,
  },
  root_account_address: rootAccount.address,
  access_key_address: accessKey.accessKeyAddress,
  expiry_unix: plan.access_key.expiry_unix,
  expiry_iso: plan.access_key.expiry_iso,
  limit_token: tokenLimit.token,
  limit_base_units: tokenLimit.amount_base_units,
  limit_units: tokenLimit.amount_units,
  balance_before_usdce: formatTokenAmount(balanceBeforeRaw, tokenLimit.decimals),
  before,
  mode: options.confirm ? 'live_authorize' : 'dry_run',
};

if (!options.confirm) {
  console.log(safeJson({
    ok: true,
    dry_run: true,
    summary,
    next_step: 'Re-run with --confirm-authorize to submit one on-chain authorization transaction.',
  }));
  process.exit(0);
}

const result = await Actions.accessKey.authorizeSync(client, {
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

const balanceAfterRaw = await getErc20Balance({
  tokenAddress: USDC_E,
  walletAddress: rootAccount.address,
});

const after = await readAccessKeyState(client, {
  account: rootAccount.address,
  accessKey: expectedAccessAddress,
  token: USDC_E,
});

const txHash = result.receipt?.transactionHash ?? null;
const output = {
  ok: true,
  dry_run: false,
  root_account_address: rootAccount.address,
  access_key_address: accessKey.accessKeyAddress,
  transaction_hash: txHash,
  explorer_url: txHash ? `https://explore.tempo.xyz/tx/${txHash}` : null,
  receipt_status: result.receipt?.status ?? null,
  block_number: stringifyBigInt(result.receipt?.blockNumber),
  balance_before_usdce: formatTokenAmount(balanceBeforeRaw, tokenLimit.decimals),
  balance_after_usdce: formatTokenAmount(balanceAfterRaw, tokenLimit.decimals),
  spent_usdce: formatTokenAmount(balanceBeforeRaw > balanceAfterRaw ? balanceBeforeRaw - balanceAfterRaw : 0n, tokenLimit.decimals),
  before,
  after,
};

await writeArtifact(output);
console.log(safeJson(output));

async function readAccessKeyState(client, { account, accessKey, token }) {
  const metadata = await Actions.accessKey.getMetadata(client, {
    account,
    accessKey,
  });
  const remaining = await Actions.accessKey.getRemainingLimit(client, {
    account,
    accessKey,
    token,
  });

  return {
    metadata: {
      address: metadata.address,
      key_type: metadata.keyType,
      expiry: stringifyBigInt(metadata.expiry),
      spend_policy: metadata.spendPolicy,
      is_revoked: metadata.isRevoked,
    },
    remaining_limit: {
      raw: stringifyBigInt(remaining.remaining),
      formatted: formatTokenAmount(remaining.remaining, 6),
      period_end: stringifyBigInt(remaining.periodEnd),
    },
  };
}

async function getErc20Balance({ tokenAddress, walletAddress }) {
  const data = `0x70a08231${walletAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const result = await rpcCall('eth_call', [{ to: tokenAddress, data }, 'latest']);
  return result && result !== '0x' ? BigInt(result) : 0n;
}

async function rpcCall(method, params) {
  const response = await fetch(TEMPO_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Tempo RPC HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`Tempo RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

async function writeArtifact(output) {
  const artifactDir = resolve(projectRoot, '.data/live');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `access-key-authorization-${Date.now()}.json`),
    `${safeJson(output)}\n`,
    'utf8',
  );
}

function parseArgs(args) {
  const values = {
    plan: defaultPlanPath,
    accessEnv: defaultAccessEnvPath,
    signerEnv: defaultSignerEnv,
    depsRoot: defaultDepsRoot,
    maxLimitUnits: '0.05',
    confirm: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--plan' && next) {
      values.plan = resolve(next);
      i += 1;
    } else if (arg === '--access-env' && next) {
      values.accessEnv = resolve(next);
      i += 1;
    } else if (arg === '--signer-env' && next) {
      values.signerEnv = resolve(next);
      i += 1;
    } else if (arg === '--deps-root' && next) {
      values.depsRoot = resolve(next);
      i += 1;
    } else if (arg === '--max-limit' && next) {
      values.maxLimitUnits = next;
      i += 1;
    } else if (arg === '--confirm-authorize') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/authorize-access-key-tempo.js [--plan .secrets/plan.json] [--access-env .secrets/key.env] [--max-limit 0.05] [--confirm-authorize]');
      process.exit(0);
    }
  }

  if (!/^\d+(\.\d{1,6})?$/.test(values.maxLimitUnits)) {
    throw new Error('--max-limit must be a positive decimal string with up to 6 decimals');
  }

  return values;
}

async function loadTempoSdk(depsRoot) {
  const nodeModules = resolve(depsRoot, 'node_modules');
  if (!existsSync(nodeModules)) {
    throw new Error(`Missing dependency folder: ${nodeModules}`);
  }

  const viem = await import(pathToFileURL(resolve(nodeModules, 'viem/_esm/index.js')));
  const tempoModule = await import(pathToFileURL(resolve(nodeModules, 'viem/_esm/tempo/index.js')));
  const tempoChainModule = await import(pathToFileURL(resolve(nodeModules, 'viem/_esm/chains/definitions/tempo.js')));

  return {
    createClient: viem.createClient,
    http: viem.http,
    Account: tempoModule.Account,
    Actions: tempoModule.Actions,
    tempo: tempoChainModule.tempo,
  };
}

function parseEnvText(text) {
  const output = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }
  return output;
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function assertPrivateKey(value, label) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a valid private key`);
  }
}

function formatTokenAmount(raw, decimals = 6) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}.00`;
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw new Error(`decimal has more fractional digits than token decimals (${decimals})`);
  }
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

function stringifyBigInt(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}

function safeJson(value) {
  return JSON.stringify(
    value,
    (_, child) => (typeof child === 'bigint' ? child.toString() : child),
    2,
  );
}
