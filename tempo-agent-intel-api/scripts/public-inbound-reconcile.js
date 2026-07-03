import { fileURLToPath } from 'node:url';

const DEFAULT_EVENT_LIMIT = 100;

export async function runPublicInboundReconcile(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || options.agentUrl);
  if (!options.allowHttp && !/^https:\/\//.test(baseUrl)) {
    throw new Error('Public inbound reconciliation requires HTTPS. Use --allow-http only for local diagnostics.');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public inbound reconciliation.');
  }
  if (!options.idempotencyKey && !options.reportId && !options.receiptId) {
    throw new Error('Provide --idempotency-key, --report-id, or --receipt-id for inbound reconciliation.');
  }

  const secretValues = [options.agentAdminToken].filter(Boolean);
  const eventsResponse = await request(new URL(`/v1/admin/payment-events?limit=${eventLimit(options.eventLimit)}`, baseUrl), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.agentAdminToken}`,
    },
  });
  assertStatus(eventsResponse, 200, 'agent payment-events lookup');
  assertNoSecretLeak('agent payment-events lookup', eventsResponse.text, secretValues);
  if (eventsResponse.body.read_only !== true) {
    throw new Error('agent payment-events response must declare read_only=true.');
  }

  const events = Array.isArray(eventsResponse.body.events) ? eventsResponse.body.events : [];
  const event = events.find((candidate) => isMatchingInboundPaymentEvent(candidate, options));
  if (!event) {
    throw new Error(`No matching inbound payment_verified event found in the last ${eventLimit(options.eventLimit)} payment events.`);
  }
  validateInboundPaymentEvent(event, options);

  const reportResponse = await request(new URL(`/v1/reports/${encodeURIComponent(event.report_id)}`, baseUrl), {
    method: 'GET',
    headers: {
      ...(event.idempotency_key ? { 'idempotency-key': event.idempotency_key } : {}),
      ...(event.receipt_id ? { 'x-report-receipt-id': event.receipt_id } : {}),
    },
  });
  assertStatus(reportResponse, 200, 'stored report lookup');
  assertNoSecretLeak('stored report lookup', reportResponse.text, secretValues);
  validateStoredReport(reportResponse.body, event);

  return {
    ok: true,
    read_only: true,
    base_url: baseUrl,
    match: {
      idempotency_key: event.idempotency_key || null,
      report_id: event.report_id,
      receipt_id: event.receipt_id,
      payment_mode: event.payment_mode,
      payment_method: event.payment_method,
      payment_status: event.payment_status,
      report_type: event.report_type,
    },
    report: {
      report_id: reportResponse.body.report?.report_id,
      report_type: reportResponse.body.report?.report_type,
      payment_mode: reportResponse.body.metadata?.payment_mode,
      payment_method: reportResponse.body.metadata?.payment_method,
      payment_status: reportResponse.body.metadata?.payment_status,
      receipt_id: reportResponse.body.metadata?.receipt_id,
    },
    note: 'Read-only inbound reconciliation. No report POST, payment, signing, signer fetch, or downstream MPP route was called.',
  };
}

function isMatchingInboundPaymentEvent(event, options) {
  if (event?.type !== 'payment_verified') {
    return false;
  }
  if (options.idempotencyKey && event.idempotency_key !== options.idempotencyKey) {
    return false;
  }
  if (options.reportId && event.report_id !== options.reportId) {
    return false;
  }
  if (options.receiptId && event.receipt_id !== options.receiptId) {
    return false;
  }
  return true;
}

function validateInboundPaymentEvent(event, options) {
  if (!event.report_id) {
    throw new Error('Inbound payment event is missing report_id.');
  }
  if (!event.receipt_id) {
    throw new Error('Inbound payment event is missing receipt_id.');
  }
  assertEqual(event.payment_status, 'paid', 'inbound.payment_status');
  assertEqual(event.payment_mode, options.expectedPaymentMode || 'tempo', 'inbound.payment_mode');
  assertEqual(event.payment_method, options.expectedPaymentMethod || 'tempo_mpp', 'inbound.payment_method');
}

function validateStoredReport(body, event) {
  assertEqual(body.metadata?.payment_status, event.payment_status, 'report.metadata.payment_status');
  assertEqual(body.metadata?.payment_mode, event.payment_mode, 'report.metadata.payment_mode');
  assertEqual(body.metadata?.payment_method, event.payment_method, 'report.metadata.payment_method');
  assertEqual(body.metadata?.receipt_id, event.receipt_id, 'report.metadata.receipt_id');
  assertEqual(body.report?.report_id, event.report_id, 'report.report_id');
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

function eventLimit(value) {
  const parsed = Number(value || DEFAULT_EVENT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_EVENT_LIMIT;
  }
  return Math.min(Math.floor(parsed), 200);
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
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin token.`);
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
    idempotencyKey: process.env.INBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    reportId: process.env.INBOUND_RECONCILE_REPORT_ID || '',
    receiptId: process.env.INBOUND_RECONCILE_RECEIPT_ID || '',
    eventLimit: Number(process.env.INBOUND_RECONCILE_EVENT_LIMIT || DEFAULT_EVENT_LIMIT),
    expectedPaymentMode: process.env.EXPECTED_INBOUND_PAYMENT_MODE || 'tempo',
    expectedPaymentMethod: process.env.EXPECTED_INBOUND_PAYMENT_METHOD || 'tempo_mpp',
    allowHttp: false,
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
    } else if (arg === '--idempotency-key' && next) {
      values.idempotencyKey = next;
      i += 1;
    } else if (arg === '--report-id' && next) {
      values.reportId = next;
      i += 1;
    } else if (arg === '--receipt-id' && next) {
      values.receiptId = next;
      i += 1;
    } else if (arg === '--event-limit' && next) {
      values.eventLimit = Number(next);
      i += 1;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-inbound-reconcile.js https://agent.example --idempotency-key public-live-tempo-inbound-...');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicInboundReconcile(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
