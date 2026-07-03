const options = parseArgs(process.argv.slice(2));

if (!options.baseUrl) {
  throw new Error('Usage: node scripts/public-outbound-preview-smoke.js https://agent.example [--idempotency-key preview-key]');
}

if (!options.allowHttp && !/^https:\/\//.test(options.baseUrl)) {
  throw new Error('Public outbound preview requires HTTPS. Use --allow-http only for local diagnostics.');
}

if (!options.adminToken) {
  throw new Error('OUTBOUND_ADMIN_TOKEN is required to run the outbound preview smoke.');
}

const url = new URL('/v1/admin/outbound/browserbase-fetch/preview', options.baseUrl);
if (options.idempotencyKey) {
  url.searchParams.set('idempotency_key', options.idempotencyKey);
}

const preview = await request(url, {
  headers: {
    authorization: `Bearer ${options.adminToken}`,
  },
});
assertStatus(preview, 200, 'outbound payment preview');

const serialized = JSON.stringify(preview.body);
if (serialized.includes(options.adminToken)) {
  throw new Error('preview response leaked OUTBOUND_ADMIN_TOKEN');
}

if (options.signerAdminToken && serialized.includes(options.signerAdminToken)) {
  throw new Error('preview response leaked OUTBOUND_SIGNER_ADMIN_TOKEN');
}

if (options.requireReady && preview.body.ok !== true) {
  throw new Error(`outbound preview is not ready: ${serialized.slice(0, 700)}`);
}

console.log(JSON.stringify({
  ok: true,
  base_url: options.baseUrl,
  read_only: true,
  preview_ok: preview.body.ok,
  request: preview.body.request,
  limits: preview.body.limits,
  blockers: preview.body.blockers,
  warnings: preview.body.warnings,
  note: 'No signer request, payment, or outbound MPP fetch route was called.',
}, null, 2));

async function request(url, init = {}) {
  const response = await fetch(url, {
    method: 'GET',
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
    body,
  };
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
  }
}

function parseArgs(args) {
  const values = {
    baseUrl: (process.env.PUBLIC_AGENT_BASE_URL || '').replace(/\/$/, ''),
    adminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    signerAdminToken: process.env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
    idempotencyKey: process.env.OUTBOUND_PREVIEW_IDEMPOTENCY_KEY || '',
    requireReady: process.env.REQUIRE_OUTBOUND_PREVIEW_READY === 'true',
    allowHttp: false,
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
    } else if (arg === '--require-ready') {
      values.requireReady = true;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-preview-smoke.js https://agent.example [--idempotency-key preview-key] [--require-ready]');
      process.exit(0);
    }
  }

  return values;
}
