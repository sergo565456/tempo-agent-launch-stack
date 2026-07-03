import { fileURLToPath } from 'node:url';

const SUCCESS_EVENT_TYPES = new Set([
  'outbound_admin_payment_succeeded',
  'outbound_cron_payment_succeeded',
]);

const DEFAULT_AGENT_ID = 'agent-launch-intel';
const DEFAULT_EXPECTED_AMOUNT_BASE_UNITS = '10000';

export async function runPublicOutboundReconcile(options) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');

  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }

  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for outbound reconciliation.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for outbound reconciliation.');
  }
  if (!options.idempotencyKey) {
    throw new Error('--idempotency-key is required.');
  }

  const secretValues = [options.agentAdminToken, options.signerAdminToken].filter(Boolean);
  const agentEvents = await fetchAgentEvents(agentUrl, options, secretValues);
  const agentEvent = findAgentEvent(agentEvents.body.events || [], options.idempotencyKey);
  const signerLedger = await fetchSignerLedger(signerUrl, {
    ...options,
    agentId: agentEvent.signer_agent_id || options.agentId || DEFAULT_AGENT_ID,
  }, secretValues);

  validateAgentEvent(agentEvent, options);
  validateSignerLedger(signerLedger.body.record, agentEvent, {
    ...options,
    agentId: agentEvent.signer_agent_id || options.agentId || DEFAULT_AGENT_ID,
  });

  return {
    ok: true,
    read_only: true,
    idempotency_key: options.idempotencyKey,
    agent: {
      base_url: agentUrl,
      event_id: agentEvent.event_id,
      event_type: agentEvent.type,
      trigger: agentEvent.trigger,
      service: agentEvent.service,
      endpoint: agentEvent.endpoint,
      amount_base_units: agentEvent.amount_base_units,
      receipt_reference: agentEvent.receipt_reference ?? null,
      created_at: agentEvent.created_at,
      total_events_seen: agentEvents.body.total_events ?? null,
    },
    signer: summarizeSignerRecord(signerLedger.body.record),
    note: 'Read-only reconciliation only. No report, payment, signing, or outbound MPP fetch route was called.',
  };
}

async function fetchAgentEvents(agentUrl, options, secretValues) {
  const url = new URL('/v1/admin/payment-events', agentUrl);
  url.searchParams.set('limit', String(options.eventLimit || 100));
  const response = await request(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.agentAdminToken}`,
    },
  });
  assertStatus(response, 200, 'agent payment events');
  assertNoSecretLeak('agent payment events', response.text, secretValues);
  if (!Array.isArray(response.body.events)) {
    throw new Error('agent payment events response did not include an events array.');
  }
  return response;
}

async function fetchSignerLedger(signerUrl, options, secretValues) {
  const url = new URL(`/v1/agents/${encodeURIComponent(options.agentId || DEFAULT_AGENT_ID)}/ledger/${encodeURIComponent(options.idempotencyKey)}`, signerUrl);
  const response = await request(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.signerAdminToken}`,
    },
  });
  assertStatus(response, 200, 'signer ledger lookup');
  assertNoSecretLeak('signer ledger lookup', response.text, secretValues);
  if (!response.body.record) {
    throw new Error('signer ledger lookup did not include a record.');
  }
  return response;
}

function findAgentEvent(events, idempotencyKey) {
  const event = events.find((item) => item.idempotency_key === idempotencyKey);
  if (!event) {
    throw new Error(`No agent payment event found for idempotency key ${idempotencyKey}.`);
  }
  return event;
}

function validateAgentEvent(event, options) {
  if (!SUCCESS_EVENT_TYPES.has(event.type)) {
    throw new Error(`Agent payment event is not a successful outbound event: ${event.type}`);
  }
  if (options.expectedAmountBaseUnits && String(event.amount_base_units) !== String(options.expectedAmountBaseUnits)) {
    throw new Error(`Agent event amount expected ${options.expectedAmountBaseUnits}, got ${event.amount_base_units}.`);
  }
  if (options.expectedService && event.service !== options.expectedService) {
    throw new Error(`Agent event service expected ${options.expectedService}, got ${event.service}.`);
  }
  if (options.expectedEndpoint && event.endpoint !== options.expectedEndpoint) {
    throw new Error(`Agent event endpoint expected ${options.expectedEndpoint}, got ${event.endpoint}.`);
  }
  if (options.expectedCommand && event.signer_command !== options.expectedCommand) {
    throw new Error(`Agent event command expected ${options.expectedCommand}, got ${event.signer_command}.`);
  }
  if (options.expectedEventType && event.type !== options.expectedEventType) {
    throw new Error(`Agent event type expected ${options.expectedEventType}, got ${event.type}.`);
  }
  if (options.expectedTrigger && event.trigger !== options.expectedTrigger) {
    throw new Error(`Agent event trigger expected ${options.expectedTrigger}, got ${event.trigger}.`);
  }
}

function validateSignerLedger(record, agentEvent, options) {
  if (record.status !== 'approved') {
    throw new Error(`Signer ledger status expected approved, got ${record.status}.`);
  }
  if (record.agent_id !== (options.agentId || DEFAULT_AGENT_ID)) {
    throw new Error(`Signer ledger agent expected ${options.agentId || DEFAULT_AGENT_ID}, got ${record.agent_id}.`);
  }
  if (record.idempotency_key !== options.idempotencyKey) {
    throw new Error(`Signer ledger idempotency key expected ${options.idempotencyKey}, got ${record.idempotency_key}.`);
  }
  if (String(record.amount_base_units) !== String(agentEvent.amount_base_units)) {
    throw new Error(`Signer ledger amount ${record.amount_base_units} does not match agent event amount ${agentEvent.amount_base_units}.`);
  }

  const approval = record.response?.approval || {};
  compareIfPresent(approval.command, agentEvent.signer_command, 'signer approval command');
  compareIfPresent(approval.service, agentEvent.service, 'signer approval service');
  compareIfPresent(approval.endpoint, agentEvent.endpoint, 'signer approval endpoint');
  compareIfPresent(String(approval.amount_base_units ?? ''), String(agentEvent.amount_base_units ?? ''), 'signer approval amount');
  if (approval.operation !== 'mpp_fetch') {
    throw new Error(`Signer approval operation expected mpp_fetch, got ${approval.operation}.`);
  }
}

function compareIfPresent(actual, expected, label) {
  if (expected == null || expected === '') {
    return;
  }
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected}, got ${actual}.`);
  }
}

function summarizeSignerRecord(record) {
  return {
    status: record.status,
    agent_id: record.agent_id,
    idempotency_key: record.idempotency_key,
    amount_base_units: record.amount_base_units,
    operation: record.response?.approval?.operation ?? null,
    command: record.response?.approval?.command ?? null,
    service: record.response?.approval?.service ?? null,
    endpoint: record.response?.approval?.endpoint ?? null,
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

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin token.`);
    }
  }
}

function normalizeBaseUrl(value, label) {
  const raw = (value || '').trim().replace(/\/$/, '');
  if (!raw) {
    throw new Error(`${label} is required.`);
  }
  try {
    new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  return raw;
}

function requireHttps(value, label) {
  if (!/^https:\/\//.test(value)) {
    throw new Error(`${label} must be HTTPS. Use --allow-http only for local diagnostics.`);
  }
}

function parseArgs(args) {
  const values = {
    agentUrl: process.env.PUBLIC_AGENT_BASE_URL || '',
    signerUrl: process.env.PUBLIC_SIGNER_BASE_URL || '',
    agentAdminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    signerAdminToken: process.env.SIGNER_ADMIN_TOKEN || process.env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
    idempotencyKey: process.env.OUTBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    agentId: process.env.OUTBOUND_SIGNER_AGENT_ID || DEFAULT_AGENT_ID,
    eventLimit: Number(process.env.OUTBOUND_RECONCILE_EVENT_LIMIT || 100),
    allowHttp: false,
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || 'fetch_browserbase_page',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || 'https://mpp.browserbase.com/fetch',
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
    expectedEventType: process.env.EXPECTED_OUTBOUND_EVENT_TYPE || '',
    expectedTrigger: process.env.EXPECTED_OUTBOUND_TRIGGER || '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--agent-url' && next) {
      values.agentUrl = next;
      i += 1;
    } else if (arg === '--signer-url' && next) {
      values.signerUrl = next;
      i += 1;
    } else if (arg === '--agent-admin-token-env' && next) {
      values.agentAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--signer-admin-token-env' && next) {
      values.signerAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--idempotency-key' && next) {
      values.idempotencyKey = next;
      i += 1;
    } else if (arg === '--agent-id' && next) {
      values.agentId = next;
      i += 1;
    } else if (arg === '--event-limit' && next) {
      values.eventLimit = Number(next);
      i += 1;
    } else if (arg === '--expected-event-type' && next) {
      values.expectedEventType = next;
      i += 1;
    } else if (arg === '--expected-trigger' && next) {
      values.expectedTrigger = next;
      i += 1;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-reconcile.js --agent-url https://agent.example --signer-url https://signer.example --idempotency-key first-live-browserbase-001');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicOutboundReconcile(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
