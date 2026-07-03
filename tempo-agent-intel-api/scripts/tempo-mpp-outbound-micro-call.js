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
const DEFAULT_ENDPOINT = 'https://mpp.browserbase.com/fetch';
const DEFAULT_MAX_AMOUNT = '0.01';

const options = parseArgs(process.argv.slice(2));
const maxAmountBaseUnits = decimalToBaseUnits(options.maxAmountUsd, 6);
const runtimeEnv = await readOptionalEnvFile(options.envFile);
const config = getConfig({
  ...process.env,
  ...(runtimeEnv.exists ? runtimeEnv.values : {}),
});
const accessBundle = await loadAgentAccessKeyBundle(config);
const sdk = await loadTempoSdk(config);
const mppxClient = await loadMppxClient(config);
const client = sdk.createClient({
  account: sdk.Account.fromSecp256k1(accessBundle.private_key, {
    access: accessBundle.root_account_address,
  }),
  chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
  transport: sdk.http(config.tempoRpcUrl),
});

if (config.tempoCurrencyAddress.toLowerCase() !== USDC_E.toLowerCase()) {
  throw new Error(`Unexpected Tempo currency: ${config.tempoCurrencyAddress}`);
}

const before = await readAgentState({ config, sdk, account: accessBundle.root_account_address, accessKey: accessBundle.access_key_address });
const probe = await probePaymentChallenge(options.endpoint);
if (!probe.payment_required) {
  throw new Error(`Expected HTTP 402 payment challenge from ${options.endpoint}, got ${probe.status}`);
}
if (probe.challenge?.amount && BigInt(probe.challenge.amount) > BigInt(maxAmountBaseUnits)) {
  throw new Error(`Challenge amount ${probe.challenge.amount} exceeds hard cap ${maxAmountBaseUnits}`);
}

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    endpoint: options.endpoint,
    max_amount_usd: options.maxAmountUsd,
    max_amount_base_units: maxAmountBaseUnits,
    payer_account: accessBundle.root_account_address,
    payer_access_key: accessBundle.access_key_address,
    before,
    probe,
    next_step: 'Re-run with --confirm-outbound to submit exactly one real outbound MPP call.',
  }, null, 2));
  process.exit(0);
}

let selectedChallenge = null;
const payment = mppxClient.Mppx.create({
  polyfill: false,
  methods: [
    mppxClient.tempo.charge({
      account: client.account,
      clientId: 'agent-launch-intel-outbound-test',
      getClient: async () => client,
    }),
  ],
  onChallenge: async (challenge, helpers) => {
    selectedChallenge = summarizeChallenge(challenge);
    if (challenge.method !== 'tempo') {
      throw new Error(`Unexpected payment method: ${challenge.method}`);
    }
    if (challenge.request.currency.toLowerCase() !== config.tempoCurrencyAddress.toLowerCase()) {
      throw new Error(`Unexpected challenge currency: ${challenge.request.currency}`);
    }
    if (BigInt(challenge.request.amount) > BigInt(maxAmountBaseUnits)) {
      throw new Error(`Challenge amount ${challenge.request.amount} exceeds hard cap ${maxAmountBaseUnits}`);
    }
    return helpers.createCredential();
  },
});

const response = await payment.fetch(options.endpoint);
const responseText = await response.text();
assert.equal(response.status, 200);
const receiptHeader = response.headers.get('payment-receipt') || '';
assert.ok(receiptHeader.length > 0, 'missing payment receipt header');
const receipt = decodeReceipt(receiptHeader);
const txReceipt = await readTxReceipt(config.tempoRpcUrl, receipt.reference);
const after = await readAgentState({ config, sdk, account: accessBundle.root_account_address, accessKey: accessBundle.access_key_address });
const output = {
  ok: true,
  dry_run: false,
  endpoint: options.endpoint,
  max_amount_usd: options.maxAmountUsd,
  payer_account: accessBundle.root_account_address,
  payer_access_key: accessBundle.access_key_address,
  challenge: selectedChallenge,
  receipt,
  tx_receipt: {
    transaction_hash: txReceipt.transactionHash,
    status: txReceipt.status,
    block_number: Number(BigInt(txReceipt.blockNumber)),
    from: txReceipt.from,
    to: txReceipt.to,
    logs: txReceipt.logs?.length ?? null,
  },
  response_preview: previewJsonOrText(responseText),
  before,
  after,
};

await writeArtifact(output);
console.log(JSON.stringify(output, null, 2));

async function probePaymentChallenge(endpoint) {
  const response = await fetch(endpoint, {
    headers: {
      accept: 'application/json',
    },
  });
  const header = response.headers.get('www-authenticate') || '';
  return {
    status: response.status,
    payment_required: response.status === 402 && /^Payment\b/i.test(header),
    challenge: parseChallengeHeader(header),
  };
}

function parseChallengeHeader(header) {
  if (!header) {
    return null;
  }
  const fields = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    fields[match[1]] = match[2];
  }
  const request = fields.request ? JSON.parse(Buffer.from(fields.request, 'base64url').toString('utf8')) : null;
  return {
    id: fields.id || null,
    method: fields.method || null,
    intent: fields.intent || null,
    realm: fields.realm || null,
    expires: fields.expires || null,
    amount: request?.amount || null,
    currency: request?.currency || null,
    recipient: request?.recipient || null,
    chain_id: request?.methodDetails?.chainId || null,
  };
}

function summarizeChallenge(challenge) {
  return {
    id: challenge.id,
    method: challenge.method,
    intent: challenge.intent,
    realm: challenge.realm,
    expires: challenge.expires,
    amount: challenge.request.amount,
    currency: challenge.request.currency,
    recipient: challenge.request.recipient,
    chain_id: challenge.request.methodDetails?.chainId ?? null,
  };
}

async function readAgentState({ config, sdk, account, accessKey }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const [balance, remaining] = await Promise.all([
    sdk.Actions.token.getBalance(readClient, { account, token: config.tempoCurrencyAddress }),
    sdk.Actions.accessKey.getRemainingLimit(readClient, {
      account,
      accessKey,
      token: config.tempoCurrencyAddress,
    }),
  ]);

  return {
    balance: formatBalance(balance, config.tempoTokenDecimals),
    remaining_limit: formatBalance(remaining.remaining, config.tempoTokenDecimals),
  };
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
    resolve(artifactDir, `tempo-outbound-mpp-micro-call-${Date.now()}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8',
  );
}

function parseArgs(args) {
  const values = {
    endpoint: DEFAULT_ENDPOINT,
    envFile: '.secrets/mpp-runtime.env',
    maxAmountUsd: DEFAULT_MAX_AMOUNT,
    confirm: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--endpoint' && next) {
      values.endpoint = next;
      i += 1;
    } else if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--max-amount-usd' && next) {
      values.maxAmountUsd = next;
      i += 1;
    } else if (arg === '--confirm-outbound') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/tempo-mpp-outbound-micro-call.js [--endpoint https://...] [--max-amount-usd 0.01] [--confirm-outbound]');
      process.exit(0);
    }
  }

  if (!/^https:\/\//.test(values.endpoint)) {
    throw new Error('--endpoint must be an https URL');
  }

  return values;
}

function decimalToBaseUnits(decimal, decimals) {
  if (!/^\d+(\.\d{1,6})?$/.test(decimal)) {
    throw new Error(`Invalid decimal amount: ${decimal}`);
  }
  const [whole, fraction = ''] = String(decimal).split('.');
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
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

function decodeReceipt(header) {
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
}

function previewJsonOrText(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return {
        type: 'array',
        length: parsed.length,
        first_item: parsed[0] ?? null,
      };
    }
    return {
      type: 'object',
      keys: Object.keys(parsed).slice(0, 20),
      sample: parsed,
    };
  } catch {
    return {
      type: 'text',
      preview: text.slice(0, 500),
    };
  }
}
