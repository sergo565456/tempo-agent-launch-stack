import { fileURLToPath } from 'node:url';

const DEFAULT_EXPECTED_ENDPOINT = 'https://mpp.browserbase.com/fetch';
const DEFAULT_EXPECTED_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const DEFAULT_EXPECTED_CURRENCY = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_EXPECTED_CHAIN_ID = 4217;
const DEFAULT_EXPECTED_AMOUNT_BASE_UNITS = '10000';

export async function runPublicOutboundLivePayment(options) {
  options = {
    expectedEndpoint: DEFAULT_EXPECTED_ENDPOINT,
    expectedRecipient: DEFAULT_EXPECTED_RECIPIENT,
    expectedCurrency: DEFAULT_EXPECTED_CURRENCY,
    expectedChainId: DEFAULT_EXPECTED_CHAIN_ID,
    expectedAmountBaseUnits: DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
    expectedDynamicMppRecipient: false,
    ...options,
  };
  options.expectedEndpoint ||= DEFAULT_EXPECTED_ENDPOINT;
  options.expectedRecipient ||= DEFAULT_EXPECTED_RECIPIENT;
  options.expectedCurrency ||= DEFAULT_EXPECTED_CURRENCY;
  options.expectedChainId ??= DEFAULT_EXPECTED_CHAIN_ID;
  options.expectedAmountBaseUnits ||= DEFAULT_EXPECTED_AMOUNT_BASE_UNITS;
  const baseUrl = (options.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error('baseUrl is required.');
  }
  if (!options.allowHttp && !/^https:\/\//.test(baseUrl)) {
    throw new Error('Public outbound live payment requires HTTPS. Use allowHttp only for local diagnostics.');
  }
  if (!options.adminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required.');
  }
  if (!options.idempotencyKey) {
    throw new Error('--idempotency-key is required so preview and execution use the same stable key.');
  }

  const preview = await fetchPreview(baseUrl, options);
  validatePreview(preview.body, options);

  if (options.previewOnly) {
    return {
      ok: true,
      read_only: true,
      base_url: baseUrl,
      idempotency_key: options.idempotencyKey,
      preview: {
        request: preview.body.request,
        limits: preview.body.limits,
        blockers: preview.body.blockers || [],
        warnings: preview.body.warnings || [],
      },
      note: 'Read-only outbound payment preview. No signer request, payment, signing, or outbound MPP fetch route was called.',
    };
  }

  if (!options.confirmLivePayment) {
    throw new Error('Refusing to execute outbound payment without --confirm-live-payment. Preview passed, but no payment was sent.');
  }

  const execution = await request(`${baseUrl}/v1/admin/outbound/browserbase-fetch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      confirm: 'run-one-outbound-payment',
      idempotency_key: options.idempotencyKey,
    }),
  });
  assertStatus(execution, 200, 'outbound live payment');

  validateExecution(execution.body, options);
  assertNoSecretLeak(JSON.stringify(execution.body), options);
  const signerLedger = options.verifySignerLedger
    ? await verifySignerLedgerRecord(execution.body, options)
    : null;

  return {
    ok: true,
    base_url: baseUrl,
    idempotency_key: options.idempotencyKey,
    preview: {
      request: preview.body.request,
      limits: preview.body.limits,
    },
    execution: {
      provider: execution.body.provider,
      signer_agent_id: execution.body.signer_agent_id,
      signer_command: execution.body.signer_command,
      service: execution.body.service,
      endpoint: execution.body.endpoint,
      requested_amount_base_units: execution.body.requested_amount_base_units,
      recipient: execution.body.recipient,
      requested_recipient: execution.body.requested_recipient ?? null,
      allow_dynamic_mpp_recipient: execution.body.allow_dynamic_mpp_recipient === true,
      signer_approval_operation: execution.body.signer_response?.approval?.operation ?? null,
      signer_fetch_mode: execution.body.signer_response?.fetch_result?.mode ?? null,
      signer_receipt: execution.body.signer_response?.fetch_result?.receipt ?? null,
    },
    signer_ledger: signerLedger,
    note: 'One outbound payment request was sent only after preview validation and explicit confirmation.',
  };
}

async function fetchPreview(baseUrl, options) {
  const url = new URL('/v1/admin/outbound/browserbase-fetch/preview', baseUrl);
  url.searchParams.set('idempotency_key', options.idempotencyKey);
  const preview = await request(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.adminToken}`,
    },
  });
  assertStatus(preview, 200, 'outbound payment preview');
  assertNoSecretLeak(JSON.stringify(preview.body), options);
  return preview;
}

function validatePreview(body, options) {
  if (body.ok !== true) {
    throw new Error(`Preview is not ready: ${JSON.stringify(body).slice(0, 700)}`);
  }
  if (body.read_only !== true) {
    throw new Error('Preview response did not declare read_only=true.');
  }
  if (body.request?.method !== 'POST') {
    throw new Error(`Preview method must be POST, got ${body.request?.method}`);
  }

  const payload = body.request?.body || {};
  assertEqual(payload.confirm, 'fetch-one-mpp-endpoint', 'preview.confirm');
  assertEqual(payload.idempotency_key, options.idempotencyKey, 'preview.idempotency_key');
  assertEqual(payload.command, options.expectedCommand, 'preview.command');
  assertEqual(payload.service, options.expectedService, 'preview.service');
  assertEqual(payload.endpoint, options.expectedEndpoint, 'preview.endpoint');
  assertEqual(payload.recipient?.toLowerCase(), options.expectedRecipient.toLowerCase(), 'preview.recipient');
  assertEqual(Boolean(payload.allow_dynamic_mpp_recipient), options.expectedDynamicMppRecipient === true, 'preview.allow_dynamic_mpp_recipient');
  assertEqual(payload.currency?.toLowerCase(), options.expectedCurrency.toLowerCase(), 'preview.currency');
  assertEqual(Number(payload.chain_id), Number(options.expectedChainId), 'preview.chain_id');
  assertEqual(String(payload.amount_base_units), String(options.expectedAmountBaseUnits), 'preview.amount_base_units');

  if (body.blockers?.length) {
    throw new Error(`Preview has blockers: ${body.blockers.join('; ')}`);
  }
}

function validateExecution(body, options) {
  assertEqual(body.ok, true, 'execution.ok');
  assertEqual(body.provider, 'remote_signer', 'execution.provider');
  assertEqual(body.service, options.expectedService, 'execution.service');
  assertEqual(body.endpoint, options.expectedEndpoint, 'execution.endpoint');
  assertEqual(String(body.requested_amount_base_units), String(options.expectedAmountBaseUnits), 'execution.requested_amount_base_units');

  const approval = body.signer_response?.approval || {};
  assertEqual(approval.operation, 'mpp_fetch', 'signer.approval.operation');
  assertEqual(approval.idempotency_key, options.idempotencyKey, 'signer.approval.idempotency_key');
  assertEqual(approval.endpoint, options.expectedEndpoint, 'signer.approval.endpoint');
  assertEqual(approval.currency?.toLowerCase(), options.expectedCurrency.toLowerCase(), 'signer.approval.currency');
  assertEqual(Number(approval.chain_id), Number(options.expectedChainId), 'signer.approval.chain_id');
  assertEqual(String(approval.amount_base_units), String(options.expectedAmountBaseUnits), 'signer.approval.amount_base_units');

  if (options.expectedDynamicMppRecipient === true) {
    assertEvmAddress(body.recipient, 'execution.recipient');
    assertEqual(body.requested_recipient?.toLowerCase(), options.expectedRecipient.toLowerCase(), 'execution.requested_recipient');
    assertEqual(body.allow_dynamic_mpp_recipient, true, 'execution.allow_dynamic_mpp_recipient');
    assertEvmAddress(approval.recipient, 'signer.approval.recipient');
    assertEqual(approval.requested_recipient?.toLowerCase(), options.expectedRecipient.toLowerCase(), 'signer.approval.requested_recipient');
    assertEqual(approval.allow_dynamic_mpp_recipient, true, 'signer.approval.allow_dynamic_mpp_recipient');

    const fetchResult = body.signer_response?.fetch_result || {};
    if (fetchResult.recipient) {
      assertEqual(fetchResult.recipient.toLowerCase(), body.recipient.toLowerCase(), 'signer.fetch_result.recipient');
    }
    return;
  }

  assertEqual(body.recipient?.toLowerCase(), options.expectedRecipient.toLowerCase(), 'execution.recipient');
  assertEqual(approval.recipient?.toLowerCase(), options.expectedRecipient.toLowerCase(), 'signer.approval.recipient');
}

async function verifySignerLedgerRecord(body, options) {
  if (!options.signerAdminToken) {
    throw new Error('--verify-signer-ledger requires OUTBOUND_SIGNER_ADMIN_TOKEN or --signer-token-env.');
  }

  const signerUrl = new URL(body.signer_url);
  const agentId = body.signer_agent_id;
  const ledgerUrl = new URL(`/v1/agents/${encodeURIComponent(agentId)}/ledger/${encodeURIComponent(options.idempotencyKey)}`, signerUrl.origin);
  const ledger = await request(ledgerUrl, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.signerAdminToken}`,
    },
  });
  assertStatus(ledger, 200, 'signer ledger lookup');
  assertNoSecretLeak(JSON.stringify(ledger.body), options);

  const record = ledger.body.record || {};
  assertEqual(record.status, 'approved', 'signer.ledger.status');
  assertEqual(record.agent_id, agentId, 'signer.ledger.agent_id');
  assertEqual(record.idempotency_key, options.idempotencyKey, 'signer.ledger.idempotency_key');
  assertEqual(String(record.amount_base_units), String(options.expectedAmountBaseUnits), 'signer.ledger.amount_base_units');
  assertEqual(record.response?.approval?.operation, 'mpp_fetch', 'signer.ledger.response.approval.operation');

  return {
    status: record.status,
    agent_id: record.agent_id,
    idempotency_key: record.idempotency_key,
    amount_base_units: record.amount_base_units,
    operation: record.response?.approval?.operation ?? null,
    created_at: record.created_at,
  };
}

async function request(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    status: response.status,
    body,
  };
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected}, got ${actual}`);
  }
}

function assertEvmAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    throw new Error(`${label} must be an EVM address, got ${value}`);
  }
  if (String(value).toLowerCase() === '0x0000000000000000000000000000000000000000') {
    throw new Error(`${label} must not be the zero address.`);
  }
}

function assertNoSecretLeak(serialized, options) {
  if (options.adminToken && serialized.includes(options.adminToken)) {
    throw new Error('Response leaked OUTBOUND_ADMIN_TOKEN.');
  }
  if (options.signerAdminToken && serialized.includes(options.signerAdminToken)) {
    throw new Error('Response leaked OUTBOUND_SIGNER_ADMIN_TOKEN.');
  }
}

function parseArgs(args) {
  const values = {
    baseUrl: (process.env.PUBLIC_AGENT_BASE_URL || '').replace(/\/$/, ''),
    adminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    signerAdminToken: process.env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
    idempotencyKey: process.env.OUTBOUND_LIVE_IDEMPOTENCY_KEY || '',
    confirmLivePayment: false,
    verifySignerLedger: process.env.VERIFY_SIGNER_LEDGER === 'true',
    allowHttp: false,
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || 'fetch_browserbase_page',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || DEFAULT_EXPECTED_ENDPOINT,
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || DEFAULT_EXPECTED_RECIPIENT,
    expectedCurrency: process.env.EXPECTED_OUTBOUND_CURRENCY || DEFAULT_EXPECTED_CURRENCY,
    expectedChainId: Number(process.env.EXPECTED_OUTBOUND_CHAIN_ID || DEFAULT_EXPECTED_CHAIN_ID),
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
    expectedDynamicMppRecipient: process.env.EXPECT_OUTBOUND_DYNAMIC_MPP_RECIPIENT
      ? process.env.EXPECT_OUTBOUND_DYNAMIC_MPP_RECIPIENT === 'true'
      : true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--') && !values.baseUrl) {
      values.baseUrl = arg.replace(/\/$/, '');
    } else if (arg === '--admin-token-env' && next) {
      values.adminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--signer-token-env' && next) {
      values.signerAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--idempotency-key' && next) {
      values.idempotencyKey = next;
      i += 1;
    } else if (arg === '--expected-amount-base-units' && next) {
      values.expectedAmountBaseUnits = next;
      i += 1;
    } else if (arg === '--expected-recipient' && next) {
      values.expectedRecipient = next;
      i += 1;
    } else if (arg === '--expect-dynamic-mpp-recipient') {
      values.expectedDynamicMppRecipient = true;
    } else if (arg === '--no-dynamic-mpp-recipient') {
      values.expectedDynamicMppRecipient = false;
    } else if (arg === '--preview-only') {
      values.previewOnly = true;
    } else if (arg === '--confirm-live-payment') {
      values.confirmLivePayment = true;
    } else if (arg === '--verify-signer-ledger') {
      values.verifySignerLedger = true;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-live-payment.js https://agent.example --idempotency-key first-live-browserbase-001 --confirm-live-payment [--verify-signer-ledger]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicOutboundLivePayment(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
