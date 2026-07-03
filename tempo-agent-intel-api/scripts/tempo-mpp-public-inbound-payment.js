import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { loadAgentAccessKeyBundle } from '../src/runtime/accessKeyReadiness.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { loadMppxClient, loadTempoSdk } from '../src/runtime/tempoDeps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_MAX_AMOUNT_USD = '0.05';

const options = parseArgs(process.argv.slice(2));
assertSmallAmount(options.amountUsd, options.maxAmountUsd);

const payerEnv = await readOptionalEnvFile(options.payerAccessEnv);
const config = getConfig({
  ...process.env,
  ...(payerEnv.exists ? payerEnv.values : {}),
  PUBLIC_BASE_URL: options.baseUrl,
  RECEIVE_TEMPO_ADDRESS: options.expectedRecipient,
  PRICE_QUICK_USD: options.amountUsd,
  MAX_REPORT_PRICE_USD: options.amountUsd,
  TEMPO_MPP_DEPS_ROOT: '.',
});
const payerAccessConfig = {
  ...config,
  agentAccessKeyEnvPath: options.payerAccessEnv,
  agentAccessKey: {
    AGENT_ROOT_ACCOUNT_ADDRESS: '',
    AGENT_ACCESS_KEY_ADDRESS: '',
    AGENT_ACCESS_KEY_PRIVATE_KEY: '',
    AGENT_ACCESS_KEY_EXPIRES_AT: '',
    AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON: '',
  },
};
const accessBundle = await loadAgentAccessKeyBundle(payerAccessConfig);
const sdk = await loadTempoSdk(config);
const mppxClient = await loadMppxClient(config);

if (config.tempoCurrencyAddress.toLowerCase() !== USDC_E.toLowerCase()) {
  throw new Error(`Unexpected Tempo currency: ${config.tempoCurrencyAddress}`);
}

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

const idempotencyKey = `public-live-tempo-inbound-${Date.now()}`;
const requestBody = {
  target: 'Tempo MPP public agent service',
  question: 'Controlled public live inbound payment test for Agent Launch Intel API.',
  depth: 'quick',
};
const url = new URL('/v1/analyze', options.baseUrl);

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    base_url: options.baseUrl,
    endpoint: url.toString(),
    amount_usd: options.amountUsd,
    max_amount_usd: options.maxAmountUsd,
    amount_base_units: amountBaseUnits,
    mode: options.mode,
    expected_recipient: options.expectedRecipient,
    payer_account: accessBundle.root_account_address,
    payer_access_key: accessBundle.access_key_address,
    payer_access_env: options.payerAccessEnv,
    balance_before: before.balance,
    remaining_limit_before: before.remaining_limit,
    next_step: 'Re-run with --confirm-live-payment to submit exactly one public Tempo MPP payment.',
  }, null, 2));
  process.exit(0);
}

const payment = mppxClient.Mppx.create({
  polyfill: false,
  methods: [
    mppxClient.tempo.charge({
      account: client.account,
      clientId: 'agent-launch-intel-public-controlled-test',
      expectedRecipients: [options.expectedRecipient],
      getClient: async () => client,
      mode: options.mode,
    }),
  ],
});

const response = await payment.fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  },
  body: JSON.stringify(requestBody),
});

const responseText = await response.text();
const responseBody = parseJsonOrText(responseText);
assert.equal(response.status, 200);
assert.equal(responseBody.payment.status, 'paid');
assert.equal(responseBody.payment.method, 'tempo_mpp');

const receiptHeader = response.headers.get('payment-receipt') || '';
assert.ok(receiptHeader.length > 0, 'missing payment receipt header');
const receipt = decodeReceipt(receiptHeader);
const txReceipt = await readTxReceipt(config.tempoRpcUrl, receipt.reference);
const reportResponse = await fetch(new URL(`/v1/reports/${responseBody.report_id}`, options.baseUrl), {
  headers: {
    'idempotency-key': idempotencyKey,
    'x-report-receipt-id': receiptHeader,
  },
});
assert.equal(reportResponse.status, 200);

const after = await readWalletState({ config, sdk, account: accessBundle.root_account_address, accessKey: accessBundle.access_key_address });
const artifact = {
  ok: true,
  dry_run: false,
  base_url: options.baseUrl,
  endpoint: url.toString(),
  amount_usd: options.amountUsd,
  max_amount_usd: options.maxAmountUsd,
  amount_base_units: amountBaseUnits,
  mode: options.mode,
  expected_recipient: options.expectedRecipient,
  payer_account: accessBundle.root_account_address,
  payer_access_key: accessBundle.access_key_address,
  payer_access_env: options.payerAccessEnv,
  idempotency_key: idempotencyKey,
  report_id: responseBody.report_id,
  payment_receipt_header: receiptHeader,
  receipt,
  tx_receipt: {
    transaction_hash: txReceipt.transactionHash,
    status: txReceipt.status,
    block_number: Number(BigInt(txReceipt.blockNumber)),
    from: txReceipt.from,
    to: txReceipt.to,
    logs: txReceipt.logs?.length ?? null,
  },
  balance_before: before.balance,
  balance_after: after.balance,
  remaining_limit_before: before.remaining_limit,
  remaining_limit_after: after.remaining_limit,
};

await writeArtifact(artifact);
console.log(JSON.stringify(artifact, null, 2));

async function readWalletState({ config, sdk, account, accessKey }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const [balanceRaw, remaining] = await Promise.all([
    readErc20Balance({
      rpcUrl: config.tempoRpcUrl,
      token: config.tempoCurrencyAddress,
      wallet: account,
    }),
    sdk.Actions.accessKey.getRemainingLimit(readClient, {
      account,
      accessKey,
      token: config.tempoCurrencyAddress,
    }),
  ]);

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

async function readTxReceipt(rpcUrl, hash) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [hash],
    }),
  });
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
    resolve(artifactDir, `tempo-public-live-inbound-payment-${Date.now()}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8',
  );
}

function parseArgs(args) {
  const values = {
    amountUsd: '0.01',
    maxAmountUsd: DEFAULT_MAX_AMOUNT_USD,
    baseUrl: process.env.PUBLIC_SMOKE_BASE_URL || 'https://tempo-agent-intel-api.vercel.app',
    expectedRecipient: process.env.RECEIVE_TEMPO_ADDRESS || '0x0000000000000000000000000000000000000000',
    payerAccessEnv: '.secrets/test-payer-access-key.20260606T033829_d9f4734c.env',
    mode: 'push',
    confirm: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--amount-usd' && next) {
      values.amountUsd = next;
      i += 1;
    } else if (arg === '--max-amount-usd' && next) {
      values.maxAmountUsd = next;
      i += 1;
    } else if (arg === '--base-url' && next) {
      values.baseUrl = next.replace(/\/$/, '');
      i += 1;
    } else if (arg === '--expected-recipient' && next) {
      values.expectedRecipient = next;
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
      console.log('Usage: node scripts/tempo-mpp-public-inbound-payment.js [--base-url https://...] [--amount-usd 0.01] [--max-amount-usd 0.05] [--mode push|pull] [--payer-access-env .secrets/test-payer-access-key.env] [--confirm-live-payment]');
      process.exit(0);
    }
  }

  if (!/^\d+(\.\d{1,6})?$/.test(values.maxAmountUsd)) {
    throw new Error(`Invalid max amount: ${values.maxAmountUsd}`);
  }
  if (!/^https:\/\//.test(values.baseUrl)) {
    throw new Error('--base-url must be an https URL');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(values.expectedRecipient)) {
    throw new Error('--expected-recipient must be an EVM address');
  }
  if (!['push', 'pull'].includes(values.mode)) {
    throw new Error('--mode must be push or pull');
  }

  return values;
}

function assertSmallAmount(amount, maxAmount) {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  if (BigInt(decimalToBaseUnits(amount, 6)) > BigInt(decimalToBaseUnits(maxAmount, 6))) {
    throw new Error(`Amount ${amount} exceeds configured cap ${maxAmount}`);
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
