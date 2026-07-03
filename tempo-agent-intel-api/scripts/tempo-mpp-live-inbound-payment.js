import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { buildTempoRuntimeReadiness, loadAgentAccessKeyBundle } from '../src/runtime/accessKeyReadiness.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { loadMppxClient, loadTempoSdk } from '../src/runtime/tempoDeps.js';
import { ReportStore } from '../src/storage/reportStore.js';
import { PaymentLedger } from '../src/storage/paymentLedger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';
const MAX_AMOUNT_USD = '0.05';

const options = parseArgs(process.argv.slice(2));
assertSmallAmount(options.amountUsd);

const envFile = await readOptionalEnvFile(options.envFile);
const env = {
  ...process.env,
  ...(envFile.exists ? envFile.values : {}),
  HOST: '127.0.0.1',
  PORT: '0',
  PUBLIC_BASE_URL: 'http://127.0.0.1',
  PRICE_QUICK_USD: options.amountUsd,
  MAX_REPORT_PRICE_USD: options.amountUsd,
  TEMPO_MPP_SUPPORTED_MODES: options.mode,
};
const config = getConfig(env);
const readiness = await buildTempoRuntimeReadiness(config);

if (!readiness.ok) {
  console.log(JSON.stringify({
    ok: false,
    phase: 'readiness',
    readiness,
  }, null, 2));
  process.exit(1);
}

if (config.tempoCurrencyAddress.toLowerCase() !== USDC_E.toLowerCase()) {
  throw new Error(`Unexpected Tempo currency: ${config.tempoCurrencyAddress}`);
}

const payerAccessConfig = options.payerAccessEnv
  ? {
    ...config,
    agentAccessKeyEnvPath: options.payerAccessEnv,
    agentAccessKey: {
      AGENT_ROOT_ACCOUNT_ADDRESS: '',
      AGENT_ACCESS_KEY_ADDRESS: '',
      AGENT_ACCESS_KEY_PRIVATE_KEY: '',
      AGENT_ACCESS_KEY_EXPIRES_AT: '',
      AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON: '',
    },
  }
  : config;
const accessBundle = await loadAgentAccessKeyBundle(payerAccessConfig);
const sdk = await loadTempoSdk(config);
const mppxClient = await loadMppxClient(config);
const client = sdk.createClient({
  account: sdk.Account.fromSecp256k1(accessBundle.private_key, {
    access: accessBundle.root_account_address,
  }),
  chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
  transport: sdk.http(config.tempoRpcUrl),
});

if (client.account.address.toLowerCase() !== accessBundle.root_account_address.toLowerCase()) {
  throw new Error('Access-key account does not resolve to the expected root account address');
}

if (client.account.accessKeyAddress.toLowerCase() !== accessBundle.access_key_address.toLowerCase()) {
  throw new Error('Access-key private key does not resolve to the expected access key address');
}

const amountBaseUnits = decimalToBaseUnits(options.amountUsd, config.tempoTokenDecimals);
const before = await readWalletState({ config, sdk, account: accessBundle.root_account_address, accessKey: accessBundle.access_key_address });
if (BigInt(before.remaining_limit.raw) < BigInt(amountBaseUnits)) {
  throw new Error(`Remaining Access Key limit ${before.remaining_limit.raw} is below requested amount ${amountBaseUnits}`);
}
if (BigInt(before.balance.raw) < BigInt(amountBaseUnits)) {
  throw new Error(`Payer balance ${before.balance.raw} is below requested amount ${amountBaseUnits}`);
}

const tempDir = await mkdtemp(join(tmpdir(), 'tempo-live-inbound-payment-'));
const reportStore = new ReportStore(join(tempDir, 'reports.json'));
const paymentLedger = new PaymentLedger(join(tempDir, 'payment-events.json'));
const server = createServer(createApp({ config, store: reportStore, paymentLedger }));
const idempotencyKey = `live-tempo-inbound-${Date.now()}`;
const requestBody = {
  target: 'Tempo MPP agent service',
  question: 'Controlled live inbound payment test for Agent Launch Intel API.',
  depth: 'quick',
};

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    amount_usd: options.amountUsd,
    amount_base_units: amountBaseUnits,
    mode: options.mode,
    receiver: config.receiveTempoAddress,
    payer_account: accessBundle.root_account_address,
    payer_access_key: accessBundle.access_key_address,
    payer_access_env: options.payerAccessEnv || config.agentAccessKeyEnvPath,
    balance_before: before.balance,
    remaining_limit_before: before.remaining_limit,
    next_step: 'Re-run with --confirm-live-payment to submit exactly one real Tempo payment transaction.',
  }, null, 2));
  await rm(tempDir, { recursive: true, force: true });
  process.exit(0);
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const payment = mppxClient.Mppx.create({
    polyfill: false,
    methods: [
      mppxClient.tempo.charge({
        account: client.account,
        clientId: 'agent-launch-intel-controlled-test',
        expectedRecipients: [config.receiveTempoAddress],
        getClient: async () => client,
        mode: options.mode,
      }),
    ],
  });

  const response = await payment.fetch(`${baseUrl}/v1/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(requestBody),
  });

  const responseBody = await response.json();
  assert.equal(response.status, 200);
  assert.equal(responseBody.payment.status, 'paid');
  assert.equal(responseBody.payment.method, 'tempo_mpp');

  const receiptHeader = response.headers.get('payment-receipt') || '';
  assert.ok(receiptHeader.length > 0, 'missing payment receipt header');

  const reportResponse = await fetch(`${baseUrl}/v1/reports/${responseBody.report_id}`, {
    headers: {
      'idempotency-key': idempotencyKey,
      'x-report-receipt-id': receiptHeader,
    },
  });
  assert.equal(reportResponse.status, 200);

  const after = await readWalletState({ config, sdk, account: accessBundle.root_account_address, accessKey: accessBundle.access_key_address });
  const ledgerEvents = await paymentLedger.list();
  const artifact = {
    ok: true,
    dry_run: false,
    amount_usd: options.amountUsd,
    amount_base_units: amountBaseUnits,
    mode: options.mode,
    receiver: config.receiveTempoAddress,
    payer_account: accessBundle.root_account_address,
    payer_access_key: accessBundle.access_key_address,
    payer_access_env: options.payerAccessEnv || config.agentAccessKeyEnvPath,
    idempotency_key: idempotencyKey,
    report_id: responseBody.report_id,
    payment_receipt_header: receiptHeader,
    balance_before: before.balance,
    balance_after: after.balance,
    remaining_limit_before: before.remaining_limit,
    remaining_limit_after: after.remaining_limit,
    ledger_event_count: ledgerEvents.length,
  };

  await writeArtifact(artifact);
  console.log(JSON.stringify(artifact, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}

async function readWalletState({ config, sdk, account, accessKey }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const balanceRaw = await readErc20Balance({
    rpcUrl: config.tempoRpcUrl,
    token: config.tempoCurrencyAddress,
    wallet: account,
  });
  const remaining = await sdk.Actions.accessKey.getRemainingLimit(readClient, {
    account,
    accessKey,
    token: config.tempoCurrencyAddress,
  });

  return {
    balance: {
      raw: balanceRaw.toString(),
      formatted: formatTokenAmount(balanceRaw, config.tempoTokenDecimals),
    },
    remaining_limit: {
      raw: remaining.remaining.toString(),
      formatted: formatTokenAmount(remaining.remaining, config.tempoTokenDecimals),
      period_end: remaining.periodEnd ? remaining.periodEnd.toString() : null,
    },
  };
}

async function readErc20Balance({ rpcUrl, token, wallet }) {
  const data = `0x70a08231${wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: token, data }, 'latest'],
    }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`Tempo RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  return BigInt(payload.result);
}

async function writeArtifact(output) {
  const artifactDir = resolve(projectRoot, '.data/live');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `tempo-live-inbound-payment-${Date.now()}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8',
  );
}

function parseArgs(args) {
  const values = {
    amountUsd: MAX_AMOUNT_USD,
    envFile: process.env.APP_ENV_FILE || '.secrets/mpp-runtime.env',
    mode: 'push',
    payerAccessEnv: '',
    confirm: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--amount-usd' && next) {
      values.amountUsd = next;
      i += 1;
    } else if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--payer-access-env' && next) {
      values.payerAccessEnv = next;
      i += 1;
    } else if (arg === '--mode' && next) {
      values.mode = next;
      i += 1;
    } else if (arg === '--confirm-live-payment') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/tempo-mpp-live-inbound-payment.js [--amount-usd 0.05] [--mode push|pull] [--payer-access-env .secrets/test-payer-access-key.env] [--env-file .secrets/mpp-runtime.env] [--confirm-live-payment]');
      process.exit(0);
    }
  }

  if (!['push', 'pull'].includes(values.mode)) {
    throw new Error('--mode must be push or pull');
  }

  return values;
}

function assertSmallAmount(amount) {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  if (BigInt(decimalToBaseUnits(amount, 6)) > BigInt(decimalToBaseUnits(MAX_AMOUNT_USD, 6))) {
    throw new Error(`Amount ${amount} exceeds hard cap ${MAX_AMOUNT_USD}`);
  }
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount has more fractional digits than token decimals (${decimals})`);
  }
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

function formatTokenAmount(raw, decimals = 6) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}.00`;
}
