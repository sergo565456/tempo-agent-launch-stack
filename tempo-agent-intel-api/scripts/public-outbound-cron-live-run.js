import { fileURLToPath } from 'node:url';
import { runPublicOutboundCronReadinessSmoke } from './public-outbound-cron-readiness-smoke.js';

const DEFAULT_EXPECTED_ENDPOINT = 'https://mpp.browserbase.com/fetch';
const DEFAULT_EXPECTED_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const DEFAULT_EXPECTED_AMOUNT_BASE_UNITS = '10000';

export async function runPublicOutboundCronLiveRun(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || options.agentUrl);
  if (!options.allowHttp && !/^https:\/\//.test(baseUrl)) {
    throw new Error('Public outbound cron live run requires HTTPS. Use --allow-http only for local diagnostics.');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public outbound cron live run.');
  }
  if (!options.cronSecret) {
    throw new Error('CRON_SECRET is required for public outbound cron live run.');
  }

  const secretValues = [
    options.agentAdminToken,
    options.cronSecret,
    options.signerAdminToken,
  ].filter(Boolean);

  const readiness = await runPublicOutboundCronReadinessSmoke({
    baseUrl,
    agentAdminToken: options.agentAdminToken,
    expectAuthGated: true,
    allowHttp: options.allowHttp,
  });
  assertNoSecretLeak('cron readiness summary', JSON.stringify(readiness), secretValues);

  const expectedIdempotencyKey = options.expectedIdempotencyKey || readiness.next_idempotency_key;
  if (!expectedIdempotencyKey) {
    throw new Error('Cron readiness did not return next_idempotency_key.');
  }
  if (readiness.next_idempotency_key !== expectedIdempotencyKey) {
    throw new Error(`Expected cron idempotency key ${expectedIdempotencyKey}, got ${readiness.next_idempotency_key}.`);
  }

  if (!options.confirmLiveCronRun) {
    throw new Error('Refusing to execute outbound cron without --confirm-live-cron-run. Cron readiness passed, but no payment was sent.');
  }

  const execution = await request(new URL('/api/cron/outbound/browserbase-fetch', baseUrl), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.cronSecret}`,
    },
  });
  assertStatus(execution, 200, 'authorized outbound cron run');
  assertNoSecretLeak('authorized outbound cron run', execution.text, secretValues);
  validateCronExecution(execution.body, {
    ...options,
    expectedIdempotencyKey,
  });

  const agentLedger = await verifyAgentCronLedgerRecord(baseUrl, execution.body, {
    ...options,
    expectedIdempotencyKey,
    secretValues,
  });
  const signerLedger = options.verifySignerLedger
    ? await verifySignerLedgerRecord(execution.body, {
      ...options,
      expectedIdempotencyKey,
      secretValues,
    })
    : null;

  return {
    ok: true,
    base_url: baseUrl,
    idempotency_key: execution.body.idempotency_key,
    readiness: {
      ready_to_enable: readiness.ready_to_enable,
      ready_to_run_authorized: readiness.ready_to_run_authorized,
      arming_found: readiness.arming_found,
      next_idempotency_key: readiness.next_idempotency_key,
    },
    execution: {
      trigger: execution.body.trigger,
      ledger_event_id: execution.body.ledger_event_id,
      provider: execution.body.result?.provider,
      signer_agent_id: execution.body.result?.signer_agent_id,
      signer_command: execution.body.result?.signer_command,
      service: execution.body.result?.service,
      endpoint: execution.body.result?.endpoint,
      requested_amount_base_units: execution.body.result?.requested_amount_base_units,
      recipient: execution.body.result?.recipient,
      signer_approval_operation: execution.body.result?.signer_response?.approval?.operation ?? null,
      signer_receipt: execution.body.result?.signer_response?.fetch_result?.receipt ?? null,
    },
    agent_ledger: agentLedger,
    signer_ledger: signerLedger,
    note: 'One authorized outbound cron run was sent only after cron readiness validation and explicit confirmation.',
  };
}

function validateCronExecution(body, options) {
  assertEqual(body.trigger, 'vercel_cron', 'cron.trigger');
  assertEqual(body.read_only, false, 'cron.read_only');
  assertEqual(body.idempotency_key, options.expectedIdempotencyKey, 'cron.idempotency_key');
  if (!/^payevt_/.test(body.ledger_event_id || '')) {
    throw new Error(`cron.ledger_event_id must be payevt_*, got ${body.ledger_event_id}`);
  }

  const result = body.result || {};
  assertEqual(result.ok, true, 'cron.result.ok');
  assertEqual(result.provider, 'remote_signer', 'cron.result.provider');
  assertEqual(result.service, options.expectedService || 'mpp.browserbase.com', 'cron.result.service');
  assertEqual(result.endpoint, options.expectedEndpoint || DEFAULT_EXPECTED_ENDPOINT, 'cron.result.endpoint');
  assertEqual(result.recipient?.toLowerCase(), (options.expectedRecipient || DEFAULT_EXPECTED_RECIPIENT).toLowerCase(), 'cron.result.recipient');
  assertEqual(String(result.requested_amount_base_units), String(options.expectedAmountBaseUnits || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS), 'cron.result.requested_amount_base_units');

  const approval = result.signer_response?.approval || {};
  assertEqual(approval.operation, 'mpp_fetch', 'cron.signer.approval.operation');
  assertEqual(approval.idempotency_key, options.expectedIdempotencyKey, 'cron.signer.approval.idempotency_key');
  assertEqual(approval.endpoint, options.expectedEndpoint || DEFAULT_EXPECTED_ENDPOINT, 'cron.signer.approval.endpoint');
  assertEqual(String(approval.amount_base_units), String(options.expectedAmountBaseUnits || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS), 'cron.signer.approval.amount_base_units');
}

async function verifyAgentCronLedgerRecord(baseUrl, cronBody, options) {
  const response = await request(new URL('/v1/admin/payment-events?limit=20', baseUrl), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.agentAdminToken}`,
    },
  });
  assertStatus(response, 200, 'agent payment-events lookup after cron');
  assertNoSecretLeak('agent payment-events lookup after cron', response.text, options.secretValues);

  if (response.body.read_only !== true) {
    throw new Error('agent payment-events response must declare read_only=true.');
  }
  const events = Array.isArray(response.body.events) ? response.body.events : [];
  const event = events.find((candidate) => candidate.event_id === cronBody.ledger_event_id
    || candidate.idempotency_key === options.expectedIdempotencyKey);
  if (!event) {
    throw new Error(`No agent payment ledger event found for cron idempotency key ${options.expectedIdempotencyKey}.`);
  }
  assertEqual(event.type, 'outbound_cron_payment_succeeded', 'agent.ledger.type');
  assertEqual(event.trigger, 'vercel_cron', 'agent.ledger.trigger');
  assertEqual(event.idempotency_key, options.expectedIdempotencyKey, 'agent.ledger.idempotency_key');
  assertEqual(String(event.amount_base_units), String(options.expectedAmountBaseUnits || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS), 'agent.ledger.amount_base_units');

  return {
    event_id: event.event_id,
    type: event.type,
    trigger: event.trigger,
    idempotency_key: event.idempotency_key,
    amount_base_units: event.amount_base_units,
    receipt_reference: event.receipt_reference || null,
  };
}

async function verifySignerLedgerRecord(cronBody, options) {
  if (!options.signerAdminToken) {
    throw new Error('--verify-signer-ledger requires SIGNER_ADMIN_TOKEN or --signer-token-env.');
  }

  const signerUrl = new URL(cronBody.result.signer_url);
  const agentId = cronBody.result.signer_agent_id;
  const ledgerUrl = new URL(`/v1/agents/${encodeURIComponent(agentId)}/ledger/${encodeURIComponent(options.expectedIdempotencyKey)}`, signerUrl.origin);
  const ledger = await request(ledgerUrl, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.signerAdminToken}`,
    },
  });
  assertStatus(ledger, 200, 'signer ledger lookup after cron');
  assertNoSecretLeak('signer ledger lookup after cron', ledger.text, options.secretValues);

  const record = ledger.body.record || {};
  assertEqual(record.status, 'approved', 'signer.ledger.status');
  assertEqual(record.agent_id, agentId, 'signer.ledger.agent_id');
  assertEqual(record.idempotency_key, options.expectedIdempotencyKey, 'signer.ledger.idempotency_key');
  assertEqual(String(record.amount_base_units), String(options.expectedAmountBaseUnits || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS), 'signer.ledger.amount_base_units');
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
    text,
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

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues || []) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin or cron token.`);
    }
  }
}

function normalizeBaseUrl(value) {
  const raw = (value || '').trim().replace(/\/$/, '');
  if (!raw) {
    throw new Error('baseUrl is required.');
  }
  try {
    new URL(raw);
  } catch {
    throw new Error('baseUrl must be a valid URL.');
  }
  return raw;
}

function parseArgs(args) {
  const values = {
    baseUrl: process.env.PUBLIC_AGENT_BASE_URL || '',
    agentAdminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    cronSecret: process.env.CRON_SECRET || '',
    signerAdminToken: process.env.SIGNER_ADMIN_TOKEN || process.env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
    expectedIdempotencyKey: process.env.OUTBOUND_CRON_EXPECTED_IDEMPOTENCY_KEY || '',
    confirmLiveCronRun: false,
    verifySignerLedger: process.env.VERIFY_SIGNER_LEDGER === 'true',
    allowHttp: false,
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || DEFAULT_EXPECTED_ENDPOINT,
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || DEFAULT_EXPECTED_RECIPIENT,
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--') && !values.baseUrl) {
      values.baseUrl = arg;
    } else if (arg === '--base-url' && next) {
      values.baseUrl = next;
      i += 1;
    } else if (arg === '--agent-url' && next) {
      values.baseUrl = next;
      i += 1;
    } else if (arg === '--agent-admin-token-env' && next) {
      values.agentAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--cron-secret-env' && next) {
      values.cronSecret = process.env[next] || '';
      i += 1;
    } else if (arg === '--signer-token-env' && next) {
      values.signerAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--expected-idempotency-key' && next) {
      values.expectedIdempotencyKey = next;
      i += 1;
    } else if (arg === '--expected-amount-base-units' && next) {
      values.expectedAmountBaseUnits = next;
      i += 1;
    } else if (arg === '--expected-recipient' && next) {
      values.expectedRecipient = next;
      i += 1;
    } else if (arg === '--confirm-live-cron-run') {
      values.confirmLiveCronRun = true;
    } else if (arg === '--verify-signer-ledger') {
      values.verifySignerLedger = true;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-cron-live-run.js https://agent.example --confirm-live-cron-run [--expected-idempotency-key cron-browserbase-fetch-YYYY-MM-DD] [--verify-signer-ledger]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicOutboundCronLiveRun(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
