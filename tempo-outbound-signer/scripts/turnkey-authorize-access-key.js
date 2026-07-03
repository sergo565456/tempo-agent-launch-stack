import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Turnkey } from '@turnkey/sdk-server';
import { createAccount } from '@turnkey/viem';
import { createClient, encodeFunctionData, http } from 'viem';
import { sendTransactionSync } from 'viem/actions';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { Abis, Actions } from 'viem/tempo';
import { getConfig } from '../src/config.js';
import { readOptionalEnvFile, parseEnvText } from '../src/envFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const ACCOUNT_KEYCHAIN = '0xaAAAaaAA00000000000000000000000000000000';
const DEFAULT_LIMIT_UNITS = '0.05';
const DEFAULT_EXPIRY_HOURS = 72;

await main().catch((error) => {
  console.error(safeJson(sanitizeError(error)));
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envFile = await readOptionalEnvFile(options.envFile, { required: true });
  const env = { ...process.env, ...envFile.values };
  const config = getConfig(env);
  const agent = config.agentWallets.find((candidate) => candidate.agent_id === options.agentId);

  if (!agent) {
    throw new Error(`Agent ${options.agentId} was not found in AGENT_WALLETS_JSON.`);
  }

  assertTurnkeyWalletMode(config, agent);

  if (options.confirmAuthorize) {
    const result = await authorizeFromPlan({ config, options });
    console.log(safeJson(result));
  } else if (options.confirmCreatePolicy) {
    const result = await createPolicyFromPlan({ config, options });
    console.log(safeJson(result));
  } else {
    const result = await createPlan({ config, agent, options });
    console.log(safeJson(result));
  }
}

async function createPlan({ config, agent, options }) {
  const createdAt = new Date();
  const suffix = `${createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
  const accessPrivateKey = generatePrivateKey();
  const accessAccount = privateKeyToAccount(accessPrivateKey);
  const expiryUnix = Math.floor(createdAt.getTime() / 1000) + options.expiryHours * 60 * 60;
  const limitBaseUnits = decimalToBaseUnits(options.limitUnits, config.tempoTokenDecimals);
  const calldata = buildAuthorizeCalldata({
    accessKeyAddress: accessAccount.address,
    expiryUnix,
    token: config.tempoUsdcAddress,
    limitBaseUnits,
  });
  const policy = buildAuthorizePolicy({
    agent,
    accessKeyAddress: accessAccount.address,
    calldata,
    config,
    limitBaseUnits,
    suffix,
  });

  await mkdir(resolve(projectRoot, '.secrets'), { recursive: true });
  const accessEnvPath = resolve(projectRoot, '.secrets', `turnkey-access-key.${suffix}.env`);
  const planPath = resolve(projectRoot, '.secrets', `turnkey-access-key-plan.${suffix}.json`);

  const accessEnv = [
    '# Local secondary Tempo Access Key for the Turnkey wallet.',
    '# Do not upload this private key to the public agent runtime.',
    '# Wallet-mode outbound payments do not use this private key.',
    `AGENT_ID=${agent.agent_id}`,
    `AGENT_ROOT_ACCOUNT_ADDRESS=${agent.wallet_address}`,
    `AGENT_ACCESS_KEY_ADDRESS=${accessAccount.address}`,
    `AGENT_ACCESS_KEY_PRIVATE_KEY=${accessPrivateKey}`,
    `AGENT_ACCESS_KEY_EXPIRES_AT=${new Date(expiryUnix * 1000).toISOString()}`,
    `AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON=${JSON.stringify([{ token: config.tempoUsdcAddress, symbol: 'USDC.e', decimals: config.tempoTokenDecimals, amount_base_units: limitBaseUnits, amount_units: options.limitUnits }])}`,
    '',
  ].join('\n');

  const plan = {
    ok: true,
    created_at: createdAt.toISOString(),
    status: 'generated_locally_not_authorized_onchain',
    agent_id: agent.agent_id,
    wallet_address: agent.wallet_address,
    access_key_address: accessAccount.address,
    access_key_type: 'secp256k1',
    expiry_unix: expiryUnix,
    expiry_iso: new Date(expiryUnix * 1000).toISOString(),
    limit_token: config.tempoUsdcAddress,
    limit_base_units: limitBaseUnits,
    limit_units: options.limitUnits,
    tempo_chain_id: config.tempoChainId,
    tempo_rpc_url: config.tempoRpcUrl,
    fee_token: config.tempoUsdcAddress,
    account_keychain: ACCOUNT_KEYCHAIN,
    authorize_calldata: calldata,
    authorize_selector: calldata.slice(0, 10),
    turnkey_policy_review_draft: policy,
    files: {
      access_env: relativePath(accessEnvPath),
      plan: relativePath(planPath),
    },
    next_steps: [
      'Create the exact Turnkey policy from turnkey_policy_review_draft.',
      'After owner approval, run this script with --confirm-authorize --plan <plan> --access-env <access env>.',
      'Then set agent_tempo_access_key_address to this access_key_address in tempo-agent-intel-api/.secrets/live-values.json and re-run the full-stack handoff gate.',
    ],
    safety_notes: [
      'This generated only local files and did not call Turnkey or Tempo RPC.',
      'The generated Access Key private key is not needed by wallet-mode outbound payments.',
      'The Turnkey policy draft is scoped to one wallet, one chain, one fee token, one AccountKeychain call, and exact calldata chunks.',
    ],
  };

  await writeFile(accessEnvPath, accessEnv, { encoding: 'utf8', mode: 0o600 });
  await writeFile(planPath, `${safeJson(plan)}\n`, { encoding: 'utf8', mode: 0o600 });

  return {
    ok: true,
    read_only: false,
    live_actions: false,
    agent_id: agent.agent_id,
    wallet_address: redactAddress(agent.wallet_address),
    access_key_address: accessAccount.address,
    expiry_iso: plan.expiry_iso,
    limit_units: options.limitUnits,
    files_written: [relativePath(accessEnvPath), relativePath(planPath)],
    turnkey_policy_name: policy.policyName,
    turnkey_policy_description: policy.description,
    turnkey_policy_json: policy.policyValue,
    next_step: 'Create this Turnkey policy, then run --confirm-authorize with the generated plan and access env.',
  };
}

async function authorizeFromPlan({ config, options }) {
  if (!options.plan || !options.accessEnv) {
    throw new Error('--plan and --access-env are required with --confirm-authorize.');
  }

  const plan = JSON.parse(await readFile(resolve(options.plan), 'utf8'));
  const accessEnv = parseEnvText(await readFile(resolve(options.accessEnv), 'utf8'));
  const agent = config.agentWallets.find((candidate) => candidate.agent_id === plan.agent_id);
  if (!agent) {
    throw new Error(`Agent ${plan.agent_id} was not found in signer config.`);
  }

  assertTurnkeyWalletMode(config, agent);
  assertAddress(plan.access_key_address, 'plan.access_key_address');
  assertAddress(plan.wallet_address, 'plan.wallet_address');
  assertPrivateKey(accessEnv.AGENT_ACCESS_KEY_PRIVATE_KEY, 'AGENT_ACCESS_KEY_PRIVATE_KEY');
  if (!addressEqual(plan.wallet_address, agent.wallet_address)) {
    throw new Error('Plan wallet address does not match signer AGENT_WALLETS_JSON.');
  }
  if (!addressEqual(accessEnv.AGENT_ACCESS_KEY_ADDRESS, plan.access_key_address)) {
    throw new Error('Access env AGENT_ACCESS_KEY_ADDRESS does not match the plan.');
  }
  if (!addressEqual(privateKeyToAccount(accessEnv.AGENT_ACCESS_KEY_PRIVATE_KEY).address, plan.access_key_address)) {
    throw new Error('Access Key private key does not derive the planned Access Key address.');
  }
  if (String(plan.status) !== 'generated_locally_not_authorized_onchain') {
    throw new Error(`Unexpected plan status: ${plan.status}`);
  }
  if (Number(plan.expiry_unix) <= Math.floor(Date.now() / 1000)) {
    throw new Error('Planned Access Key expiry is not in the future.');
  }
  if (BigInt(plan.limit_base_units) > decimalToBaseUnits(options.maxLimitUnits, config.tempoTokenDecimals)) {
    throw new Error(`Plan limit exceeds --max-limit ${options.maxLimitUnits}.`);
  }

  const calldata = buildAuthorizeCalldata({
    accessKeyAddress: plan.access_key_address,
    expiryUnix: Number(plan.expiry_unix),
    token: plan.limit_token,
    limitBaseUnits: String(plan.limit_base_units),
  });
  if (calldata.toLowerCase() !== String(plan.authorize_calldata).toLowerCase()) {
    throw new Error('Plan calldata does not match recalculated authorizeKey calldata.');
  }

  const turnkey = new Turnkey({
    apiBaseUrl: config.turnkey.apiBaseUrl,
    apiPrivateKey: config.turnkey.apiPrivateKey,
    apiPublicKey: config.turnkey.apiPublicKey,
    defaultOrganizationId: config.turnkey.organizationId,
  });
  const account = await createAccount({
    client: turnkey.apiClient(),
    organizationId: config.turnkey.organizationId,
    signWith: agent.turnkey_sign_with || agent.wallet_address,
  });
  if (!addressEqual(account.address, agent.wallet_address)) {
    throw new Error(`Turnkey account ${account.address} does not match agent wallet ${agent.wallet_address}.`);
  }

  const client = createClient({
    account,
    chain: tempo.extend({ feeToken: config.tempoUsdcAddress }),
    transport: http(config.tempoRpcUrl),
  });

  const before = await readAccessKeyState({ client, config, account: agent.wallet_address, accessKey: plan.access_key_address });
  if (before.metadata.expiry !== '0') {
    throw new Error(`Access Key already appears authorized with expiry ${before.metadata.expiry}.`);
  }

  const receipt = await sendTransactionSync(client, {
    calls: [{ to: ACCOUNT_KEYCHAIN, data: calldata }],
    throwOnReceiptRevert: true,
  });
  const after = await readAccessKeyState({ client, config, account: agent.wallet_address, accessKey: plan.access_key_address });

  const output = {
    ok: true,
    read_only: false,
    live_actions: true,
    agent_id: agent.agent_id,
    wallet_address: redactAddress(agent.wallet_address),
    access_key_address: plan.access_key_address,
    receipt_status: receipt.status ?? null,
    transaction_hash: receipt.transactionHash ?? null,
    explorer_url: receipt.transactionHash ? `https://explore.tempo.xyz/tx/${receipt.transactionHash}` : null,
    before,
    after,
    next_step: 'Update tempo-agent-intel-api/.secrets/live-values.json agent_tempo_access_key_address and re-run full-stack live handoff check.',
  };

  await mkdir(resolve(projectRoot, '.data', 'live'), { recursive: true });
  await writeFile(
    resolve(projectRoot, '.data', 'live', `turnkey-access-key-authorization-${Date.now()}.json`),
    `${safeJson(output)}\n`,
    'utf8',
  );

  return output;
}

async function createPolicyFromPlan({ config, options }) {
  if (!options.plan) {
    throw new Error('--plan is required with --confirm-create-policy.');
  }

  const planPath = resolve(options.plan);
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const draft = plan.turnkey_policy_review_draft;
  if (!draft?.policyName || !draft?.policyValue?.effect || !draft?.policyValue?.condition || !draft?.policyValue?.consensus) {
    throw new Error('Plan is missing turnkey_policy_review_draft.');
  }
  if (String(plan.status) !== 'generated_locally_not_authorized_onchain') {
    throw new Error(`Unexpected plan status: ${plan.status}`);
  }
  if (plan.turnkey_policy_id) {
    throw new Error(`Plan already has turnkey_policy_id ${plan.turnkey_policy_id}.`);
  }

  const turnkey = new Turnkey({
    apiBaseUrl: config.turnkey.apiBaseUrl,
    apiPrivateKey: config.turnkey.apiPrivateKey,
    apiPublicKey: config.turnkey.apiPublicKey,
    defaultOrganizationId: config.turnkey.organizationId,
  });
  const policy = {
    policyName: draft.policyName,
    effect: draft.policyValue.effect,
    condition: draft.policyValue.condition,
    consensus: draft.policyValue.consensus,
    notes: draft.description || 'One-time exact Tempo Access Key authorization policy.',
  };
  const response = await turnkey.apiClient().createPolicy(policy);
  const policyId = response.policyId
    || response.activity?.result?.createPolicyResult?.policyId
    || response.activity?.result?.activity?.result?.createPolicyResult?.policyId
    || null;
  if (!policyId) {
    throw new Error(`Turnkey createPolicy response did not include policyId: ${safeJson(response).slice(0, 1000)}`);
  }

  const updatedPlan = {
    ...plan,
    turnkey_policy_id: policyId,
    turnkey_policy_created_at: new Date().toISOString(),
    turnkey_policy_activity_id: response.activity?.id || null,
    turnkey_policy_activity_status: response.activity?.status || null,
  };
  await writeFile(planPath, `${safeJson(updatedPlan)}\n`, { encoding: 'utf8', mode: 0o600 });

  return {
    ok: true,
    read_only: false,
    live_actions: true,
    plan: relativePath(planPath),
    policy_id: policyId,
    activity_id: response.activity?.id || null,
    activity_status: response.activity?.status || null,
    next_step: 'Run --confirm-authorize with this plan and the generated access env.',
  };
}

function buildAuthorizeCalldata({ accessKeyAddress, expiryUnix, token, limitBaseUnits }) {
  return encodeFunctionData({
    abi: Abis.accountKeychain,
    functionName: 'authorizeKey',
    args: [
      accessKeyAddress,
      0,
      {
        expiry: BigInt(expiryUnix),
        enforceLimits: true,
        limits: [{ token, amount: BigInt(limitBaseUnits), period: 0n }],
        allowAnyCalls: true,
        allowedCalls: [],
      },
    ],
  });
}

function buildAuthorizePolicy({ agent, accessKeyAddress, calldata, config, limitBaseUnits, suffix }) {
  const inputChunks = chunkString(calldata.toLowerCase(), 64).map(({ start, end, value }) => (
    `tempo.tx.calls[0].input[${start}..${end}] == '${value}'`
  ));
  const condition = [
    "activity.action == 'SIGN'",
    "activity.params.type == 'TRANSACTION_TYPE_TEMPO'",
    `wallet_account.address == '${agent.wallet_address}'`,
    `tempo.tx.chain_id == ${config.tempoChainId}`,
    `tempo.tx.fee_token == '${config.tempoUsdcAddress}'`,
    'tempo.tx.calls.count() == 1',
    `tempo.tx.calls[0].to == '${ACCOUNT_KEYCHAIN}'`,
    `tempo.tx.calls[0].function_signature == '${calldata.slice(0, 10).toLowerCase()}'`,
    ...inputChunks,
  ].join(' && ');

  return {
    policyName: `${agent.agent_id}-tempo-access-key-authorize-${suffix.slice(-8)}`,
    description: `One-time exact Tempo Access Key authorization for ${agent.agent_id}: ${accessKeyAddress.slice(0, 6)}...${accessKeyAddress.slice(-4)}, ${limitBaseUnits} USDC.e base units.`,
    policyValue: {
      effect: 'EFFECT_ALLOW',
      consensus: `approvers.any(user, user.id == '${config.turnkey.signerApiUserId}')`,
      condition,
    },
  };
}

async function readAccessKeyState({ client, config, account, accessKey }) {
  const metadata = await Actions.accessKey.getMetadata(client, { account, accessKey });
  const remaining = await Actions.accessKey.getRemainingLimit(client, {
    account,
    accessKey,
    token: config.tempoUsdcAddress,
  });
  return {
    metadata: {
      address: redactAddress(metadata.address),
      key_type: metadata.keyType || null,
      expiry: stringifyBigInt(metadata.expiry),
      spend_policy: metadata.spendPolicy || null,
      is_revoked: Boolean(metadata.isRevoked),
    },
    remaining_limit: {
      raw: stringifyBigInt(remaining.remaining),
      formatted: formatTokenAmount(remaining.remaining, config.tempoTokenDecimals),
      period_end: stringifyBigInt(remaining.periodEnd),
    },
  };
}

function assertTurnkeyWalletMode(config, agent) {
  if (config.provider !== 'turnkey') {
    throw new Error('SIGNER_PROVIDER must be turnkey.');
  }
  if (config.turnkey.signWithMode !== 'wallet') {
    throw new Error('This script is only for TURNKEY_SIGN_WITH_MODE=wallet.');
  }
  if (!config.turnkey.organizationId || !config.turnkey.apiPublicKey || !config.turnkey.apiPrivateKeyConfigured) {
    throw new Error('Turnkey org/API credentials are required.');
  }
  if (!config.turnkey.signerApiUserId) {
    throw new Error('TURNKEY_SIGNER_API_USER_ID is required to build policy consensus.');
  }
  assertAddress(agent.wallet_address, 'agent.wallet_address');
  if (agent.turnkey_sign_with) {
    assertAddress(agent.turnkey_sign_with, 'agent.turnkey_sign_with');
    if (!addressEqual(agent.turnkey_sign_with, agent.wallet_address)) {
      throw new Error('agent.turnkey_sign_with must match agent.wallet_address.');
    }
  }
}

function parseArgs(args) {
  const values = {
    envFile: '.secrets/signer-live.env',
    agentId: 'agent-launch-intel',
    limitUnits: DEFAULT_LIMIT_UNITS,
    maxLimitUnits: DEFAULT_LIMIT_UNITS,
    expiryHours: DEFAULT_EXPIRY_HOURS,
    plan: '',
    accessEnv: '',
    confirmAuthorize: false,
    confirmCreatePolicy: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--agent-id' && next) {
      values.agentId = next;
      i += 1;
    } else if (arg === '--limit' && next) {
      values.limitUnits = next;
      i += 1;
    } else if (arg === '--max-limit' && next) {
      values.maxLimitUnits = next;
      i += 1;
    } else if (arg === '--expiry-hours' && next) {
      values.expiryHours = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--plan' && next) {
      values.plan = next;
      i += 1;
    } else if (arg === '--access-env' && next) {
      values.accessEnv = next;
      i += 1;
    } else if (arg === '--confirm-authorize') {
      values.confirmAuthorize = true;
    } else if (arg === '--confirm-create-policy') {
      values.confirmCreatePolicy = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/turnkey-authorize-access-key.js [--env-file .secrets/signer-live.env] [--limit 0.05] [--expiry-hours 72] [--confirm-create-policy --plan .secrets/turnkey-access-key-plan.X.json] [--confirm-authorize --plan .secrets/turnkey-access-key-plan.X.json --access-env .secrets/turnkey-access-key.X.env]');
      process.exit(0);
    }
  }

  if (!/^\d+(\.\d{1,6})?$/.test(values.limitUnits)) {
    throw new Error('--limit must be a positive decimal string with up to 6 decimals.');
  }
  if (!/^\d+(\.\d{1,6})?$/.test(values.maxLimitUnits)) {
    throw new Error('--max-limit must be a positive decimal string with up to 6 decimals.');
  }
  if (!Number.isInteger(values.expiryHours) || values.expiryHours < 1 || values.expiryHours > 168) {
    throw new Error('--expiry-hours must be an integer from 1 to 168.');
  }
  if (values.confirmAuthorize && values.confirmCreatePolicy) {
    throw new Error('Use only one of --confirm-authorize or --confirm-create-policy.');
  }
  return values;
}

function chunkString(value, size) {
  const chunks = [];
  for (let start = 0; start < value.length; start += size) {
    const end = Math.min(value.length, start + size);
    chunks.push({ start, end, value: value.slice(start, end) });
  }
  return chunks;
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw new Error(`decimal has more fractional digits than token decimals (${decimals})`);
  }
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    throw new Error(`${label} must be a valid EVM address.`);
  }
}

function assertPrivateKey(value, label) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value || '')) {
    throw new Error(`${label} must be a valid private key.`);
  }
}

function addressEqual(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function redactAddress(value) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    return null;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function stringifyBigInt(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || value === null) return null;
  return String(value);
}

function formatTokenAmount(raw, decimals = 6) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}.00`;
}

function relativePath(path) {
  return path.replace(`${projectRoot}\\`, '').replaceAll('\\', '/');
}

function safeJson(value) {
  return JSON.stringify(value, (_key, child) => (typeof child === 'bigint' ? child.toString() : child), 2);
}

function sanitizeError(error) {
  return {
    ok: false,
    error: error?.name || 'Error',
    short_message: error?.shortMessage || null,
    details: error?.details || null,
    message: error?.message || String(error),
  };
}
