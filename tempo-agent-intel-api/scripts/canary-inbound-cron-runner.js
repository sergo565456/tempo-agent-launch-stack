import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { loadAgentAccessKeyBundle } from '../src/runtime/accessKeyReadiness.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { loadMppxClient, loadTempoSdk } from '../src/runtime/tempoDeps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';

const REPORT_VARIANTS = [
  {
    path: '/v1/analyze',
    target: 'Tempo MPP canary health check',
    question: 'Synthetic canary check: verify paid opportunity report generation for Agent Launch Intel API.',
  },
  {
    path: '/v1/launch-readiness',
    target: 'Agent Launch Intel API public launch surface',
    question: 'Synthetic canary check: verify paid launch-readiness report generation.',
  },
  {
    path: '/v1/service-diligence',
    target: 'Agent Launch Intel API paid endpoint',
    question: 'Synthetic canary check: verify paid service-diligence report generation.',
  },
  {
    path: '/v1/ecosystem-fit',
    target: 'Tempo MPP, x402, MCP service catalog positioning',
    question: 'Synthetic canary check: verify paid ecosystem-fit report generation.',
  },
];

const options = parseArgs(process.argv.slice(2));
assertSmallAmount(options.amountUsd, options.maxAmountUsd);

const pointerPath = resolve(projectRoot, options.pointer);
const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
const manifestPath = resolve(projectRoot, pointer.pool_manifest);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const currentBinding = buildMachineBinding();
const allowedBindingHashes = getAllowedBindingHashes(pointer, manifest);

if (options.requireMachineBinding && !allowedBindingHashes.includes(currentBinding.binding_hash)) {
  throw new Error('Current machine binding does not match canary pool manifest.');
}

const eligibleWallets = (manifest.wallets || []).filter((wallet) => wallet.enabled === true && wallet.status === 'authorized_onchain');
if (eligibleWallets.length === 0) {
  throw new Error('No authorized enabled canary wallets are available.');
}

const statePath = resolve(projectRoot, options.stateFile);
const state = await loadState(statePath);
const localDate = localDateKey(new Date());
let dayState = state.days?.[localDate] || null;
if (!dayState || options.rescheduleToday) {
  dayState = createDaySchedule({ localDate, eligibleWallets, options });
  state.days = { ...(state.days || {}), [localDate]: dayState };
  await writeState(statePath, state);
}

if (dayState.completed === true && !options.forceRun) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: 'already_completed_today',
    read_only: true,
    live_actions: false,
    pool_id: manifest.pool_id,
    local_date: localDate,
    day_state: summarizeDayState(dayState),
  }, null, 2));
  process.exit(0);
}

const now = new Date();
if (!options.forceRun && now.getTime() < dayState.scheduled_after_epoch_ms) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: 'scheduled_time_not_reached',
    read_only: true,
    live_actions: false,
    pool_id: manifest.pool_id,
    local_date: localDate,
    now: now.toISOString(),
    day_state: summarizeDayState(dayState),
  }, null, 2));
  process.exit(0);
}

const selectedWallet = eligibleWallets.find((wallet) => wallet.label === dayState.wallet_label);
if (!selectedWallet) {
  throw new Error(`Scheduled wallet ${dayState.wallet_label} is no longer eligible.`);
}
const variant = REPORT_VARIANTS.find((item) => item.path === dayState.endpoint_path) || REPORT_VARIANTS[0];
const runtimeEnv = await readOptionalEnvFile(options.envFile);
const payerEnv = await readOptionalEnvFile(selectedWallet.files.access_key_env);
const config = getConfig({
  ...process.env,
  ...(runtimeEnv.exists ? runtimeEnv.values : {}),
  ...(payerEnv.exists ? payerEnv.values : {}),
  PUBLIC_BASE_URL: options.baseUrl,
  RECEIVE_TEMPO_ADDRESS: options.expectedRecipient,
  PRICE_QUICK_USD: options.amountUsd,
  MAX_REPORT_PRICE_USD: options.amountUsd,
  TEMPO_MPP_DEPS_ROOT: '.',
  AGENT_ACCESS_KEY_ENV_PATH: selectedWallet.files.access_key_env,
});

if (config.tempoCurrencyAddress.toLowerCase() !== USDC_E.toLowerCase()) {
  throw new Error(`Unexpected Tempo currency: ${config.tempoCurrencyAddress}`);
}

const payerAccessConfig = {
  ...config,
  agentAccessKeyEnvPath: selectedWallet.files.access_key_env,
};
const accessBundle = await loadAgentAccessKeyBundle(payerAccessConfig);
const sdk = await loadTempoSdk(config);
const amountBaseUnits = decimalToBaseUnits(options.amountUsd, config.tempoTokenDecimals);
const before = await readWalletState({ config, sdk, account: accessBundle.root_account_address, accessKey: accessBundle.access_key_address });
if (BigInt(before.remaining_limit.raw) < BigInt(amountBaseUnits)) {
  throw new Error(`Remaining Access Key limit ${before.remaining_limit.raw} is below requested amount ${amountBaseUnits}.`);
}
if (BigInt(before.balance.raw) < BigInt(amountBaseUnits)) {
  throw new Error(`Payer balance ${before.balance.raw} is below requested amount ${amountBaseUnits}.`);
}

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    live_actions: false,
    pool_id: manifest.pool_id,
    local_date: localDate,
    day_state: summarizeDayState(dayState),
    selected_wallet: {
      label: selectedWallet.label,
      root_account_address: selectedWallet.root_account_address,
      access_key_address: selectedWallet.access_key_address,
    },
    amount_usd: options.amountUsd,
    amount_base_units: amountBaseUnits,
    before,
    next_step: 'Re-run with --confirm-live-payment to submit exactly one canary inbound payment.',
  }, null, 2));
  process.exit(0);
}

const client = sdk.createClient({
  account: sdk.Account.fromSecp256k1(accessBundle.private_key, {
    access: accessBundle.root_account_address,
  }),
  chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
  transport: sdk.http(config.tempoRpcUrl),
});
const mppxClient = await loadMppxClient(config);
const payment = mppxClient.Mppx.create({
  polyfill: false,
  methods: [
    mppxClient.tempo.charge({
      account: client.account,
      clientId: `agent-launch-intel-canary-${selectedWallet.label}`,
      expectedRecipients: [options.expectedRecipient],
      getClient: async () => client,
      mode: options.mode,
    }),
  ],
});

const requestBody = {
  target: variant.target,
  question: variant.question,
  depth: 'quick',
  output_format: 'json',
  constraints: {
    synthetic_activity_label: 'canary',
    canary_pool_id: manifest.pool_id,
    canary_wallet_label: selectedWallet.label,
  },
};
const url = new URL(variant.path, options.baseUrl);
const response = await payment.fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': dayState.idempotency_key,
  },
  body: JSON.stringify(requestBody),
});
const responseText = await response.text();
const responseBody = parseJsonOrText(responseText);
if (response.status !== 200) {
  throw new Error(`Canary payment request returned HTTP ${response.status}: ${responseText.slice(0, 500)}`);
}
if (responseBody.payment?.status !== 'paid') {
  throw new Error('Canary response did not return payment.status=paid.');
}

const receiptHeader = response.headers.get('payment-receipt') || '';
const receipt = receiptHeader ? decodeReceipt(receiptHeader) : null;
const after = await readWalletState({ config, sdk, account: accessBundle.root_account_address, accessKey: accessBundle.access_key_address });
dayState.completed = true;
dayState.completed_at = new Date().toISOString();
dayState.report_id = responseBody.report_id || null;
dayState.receipt_reference = receipt?.reference || null;
state.days[localDate] = dayState;
state.history = [
  ...(state.history || []),
  {
    local_date: localDate,
    completed_at: dayState.completed_at,
    wallet_label: selectedWallet.label,
    endpoint_path: variant.path,
    idempotency_key: dayState.idempotency_key,
    report_id: dayState.report_id,
    receipt_reference: dayState.receipt_reference,
  },
].slice(-120);
await writeState(statePath, state);

const artifact = {
  ok: true,
  dry_run: false,
  live_actions: true,
  pool_id: manifest.pool_id,
  local_date: localDate,
  selected_wallet: {
    label: selectedWallet.label,
    root_account_address: selectedWallet.root_account_address,
    access_key_address: selectedWallet.access_key_address,
  },
  endpoint: url.toString(),
  amount_usd: options.amountUsd,
  amount_base_units: amountBaseUnits,
  idempotency_key: dayState.idempotency_key,
  report_id: responseBody.report_id,
  receipt_reference: receipt?.reference || null,
  balance_before: before.balance,
  balance_after: after.balance,
  remaining_limit_before: before.remaining_limit,
  remaining_limit_after: after.remaining_limit,
  note: 'Synthetic canary payment completed. This is not an organic external user.',
};
await writeArtifact(artifact);
console.log(JSON.stringify(artifact, null, 2));

function createDaySchedule({ localDate, eligibleWallets, options }) {
  const wallet = eligibleWallets[randomInt(eligibleWallets.length)];
  const variant = REPORT_VARIANTS[randomInt(REPORT_VARIANTS.length)];
  const [year, month, day] = localDate.split('-').map(Number);
  const hour = randomInt(options.startHour, options.endHour + 1);
  const minute = randomInt(0, 60);
  const scheduled = new Date(year, month - 1, day, hour, minute, 0, 0);
  return {
    local_date: localDate,
    created_at: new Date().toISOString(),
    wallet_label: wallet.label,
    endpoint_path: variant.path,
    scheduled_local_time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    scheduled_after_epoch_ms: scheduled.getTime(),
    idempotency_key: `canary-inbound-${localDate}-${wallet.label}-${randomUUID().slice(0, 8)}`,
    completed: false,
  };
}

async function readWalletState({ config, sdk, account, accessKey }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const [balanceRaw, remaining] = await Promise.all([
    readErc20Balance({ rpcUrl: config.tempoRpcUrl, token: config.tempoCurrencyAddress, wallet: account }),
    sdk.Actions.accessKey.getRemainingLimit(readClient, { account, accessKey, token: config.tempoCurrencyAddress }),
  ]);
  return {
    balance: formatBalance(balanceRaw, config.tempoTokenDecimals),
    remaining_limit: formatBalance(remaining.remaining, config.tempoTokenDecimals),
  };
}

async function readErc20Balance({ rpcUrl, token, wallet }) {
  const data = `0x70a08231${wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`Tempo RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  return BigInt(payload.result);
}

async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, days: {}, history: [] };
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function writeArtifact(output) {
  const artifactDir = resolve(projectRoot, '.data/canary');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, `canary-inbound-payment-${Date.now()}.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function parseArgs(args) {
  const values = {
    pointer: '.secrets/canary-payers/current-pool.json',
    envFile: '.secrets/mpp-runtime.env',
    stateFile: '.data/canary/canary-inbound-cron-state.json',
    baseUrl: process.env.PUBLIC_SMOKE_BASE_URL || 'https://tempo-agent-intel-api.vercel.app',
    expectedRecipient: process.env.RECEIVE_TEMPO_ADDRESS || '0x0000000000000000000000000000000000000000',
    amountUsd: '0.01',
    maxAmountUsd: '0.01',
    mode: 'push',
    startHour: 0,
    endHour: 23,
    requireMachineBinding: true,
    confirm: false,
    forceRun: false,
    rescheduleToday: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--pointer' && next) {
      values.pointer = next; i += 1;
    } else if (arg === '--env-file' && next) {
      values.envFile = next; i += 1;
    } else if (arg === '--state-file' && next) {
      values.stateFile = next; i += 1;
    } else if (arg === '--base-url' && next) {
      values.baseUrl = next.replace(/\/$/, ''); i += 1;
    } else if (arg === '--expected-recipient' && next) {
      values.expectedRecipient = next; i += 1;
    } else if (arg === '--amount-usd' && next) {
      values.amountUsd = next; i += 1;
    } else if (arg === '--max-amount-usd' && next) {
      values.maxAmountUsd = next; i += 1;
    } else if (arg === '--start-hour' && next) {
      values.startHour = Number.parseInt(next, 10); i += 1;
    } else if (arg === '--end-hour' && next) {
      values.endHour = Number.parseInt(next, 10); i += 1;
    } else if (arg === '--allow-other-machine') {
      values.requireMachineBinding = false;
    } else if (arg === '--force-run') {
      values.forceRun = true;
    } else if (arg === '--reschedule-today') {
      values.rescheduleToday = true;
    } else if (arg === '--confirm-live-payment') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/canary-inbound-cron-runner.js [--confirm-live-payment] [--force-run]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(values.startHour) || !Number.isInteger(values.endHour) || values.startHour < 0 || values.endHour > 23 || values.startHour > values.endHour) {
    throw new Error('--start-hour/--end-hour must define a valid 0..23 range.');
  }
  if (!/^https:\/\//.test(values.baseUrl)) throw new Error('--base-url must be an https URL.');
  if (!/^0x[a-fA-F0-9]{40}$/.test(values.expectedRecipient)) throw new Error('--expected-recipient must be an EVM address.');
  return values;
}

function assertSmallAmount(amount, maxAmount) {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error(`Invalid amount: ${amount}`);
  if (BigInt(decimalToBaseUnits(amount, 6)) > BigInt(decimalToBaseUnits(maxAmount, 6))) {
    throw new Error(`Amount ${amount} exceeds configured cap ${maxAmount}`);
  }
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) throw new Error(`Amount has more fractional digits than token decimals (${decimals})`);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
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

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function summarizeDayState(dayState) {
  return {
    local_date: dayState.local_date,
    wallet_label: dayState.wallet_label,
    endpoint_path: dayState.endpoint_path,
    scheduled_local_time: dayState.scheduled_local_time,
    idempotency_key: dayState.idempotency_key,
    completed: dayState.completed,
    completed_at: dayState.completed_at || null,
    report_id: dayState.report_id || null,
  };
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

function getAllowedBindingHashes(pointer, manifest) {
  return [
    ...(Array.isArray(manifest.machine_binding?.allowed_binding_hashes) ? manifest.machine_binding.allowed_binding_hashes : []),
    ...(Array.isArray(pointer.allowed_binding_hashes) ? pointer.allowed_binding_hashes : []),
    manifest.machine_binding?.binding_hash,
    pointer.machine_binding_hash,
  ].filter((value, index, values) => (
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/i.test(value) &&
    values.indexOf(value) === index
  ));
}

function decodeReceipt(header) {
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
