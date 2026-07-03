const baseUrl = (process.argv[2] || process.env.PUBLIC_SMOKE_BASE_URL || '').replace(/\/$/, '');

if (!/^https:\/\//.test(baseUrl)) {
  throw new Error('Usage: node scripts/public-smoke-test.js https://deployment.example');
}

const requestBody = {
  target: 'Tempo MPP',
  question: 'public production smoke',
  depth: 'quick',
};

const health = await request('GET', '/health');
assertStatus(health, 200, 'health');
const paymentMode = health.body.payment_mode;

const malformed = await request('POST', '/v1/analyze', {
  headers: {
    'content-type': 'application/json',
    'x-mock-payment': 'paid',
  },
  body: '{"target":',
});
assertStatus(malformed, 400, 'malformed json');

const unpaid = await request('POST', '/v1/analyze', {
  headers: {
    'content-type': 'application/json',
    'idempotency-key': `public-smoke-unpaid-${Date.now()}`,
  },
  body: JSON.stringify(requestBody),
});
assertStatus(unpaid, 402, 'unpaid mock payment');

let paid = null;
let stored = null;
let reportId = null;

if (paymentMode === 'mock') {
  const idempotencyKey = `public-smoke-paid-${Date.now()}`;
  paid = await request('POST', '/v1/analyze', {
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-mock-payment': 'paid',
    },
    body: JSON.stringify(requestBody),
  });
  assertStatus(paid, 200, 'paid mock payment');

  reportId = paid.body.report_id;
  if (!reportId) {
    throw new Error('paid mock payment did not return report_id');
  }

  stored = await request('GET', `/v1/reports/${reportId}`);
  assertStatus(stored, 200, 'stored report retrieval');
}

if (paymentMode === 'tempo' && unpaid.body?.payment?.method !== 'tempo') {
  throw new Error(`expected tempo payment challenge, got ${JSON.stringify(unpaid.body?.payment)}`);
}

console.log(JSON.stringify({
  ok: true,
  base_url: baseUrl,
  health: {
    payment_mode: health.body.payment_mode,
    outbound_live_payments: health.body.outbound_live_payments,
  },
  malformed_status: malformed.status,
  unpaid_status: unpaid.status,
  unpaid_payment_method: unpaid.body?.payment?.method || null,
  paid_status: paid?.status ?? null,
  payment_receipt: paid?.headers['payment-receipt'] ?? null,
  report_id: reportId,
  stored_status: stored?.status ?? null,
}, null, 2));

async function request(method, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...init,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    status: response.status,
    headers: {
      'payment-receipt': response.headers.get('payment-receipt'),
      'www-authenticate': response.headers.get('www-authenticate'),
      'x-report-cache': response.headers.get('x-report-cache'),
    },
    body,
  };
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
  }
}
