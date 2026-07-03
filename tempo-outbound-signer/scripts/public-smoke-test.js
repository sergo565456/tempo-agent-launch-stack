const options = parseArgs(process.argv.slice(2));

if (!options.baseUrl) {
  throw new Error('Usage: node scripts/public-smoke-test.js https://signer.example [--expect-provider turnkey] [--require-ready]');
}

if (!options.allowHttp && !/^https:\/\//.test(options.baseUrl)) {
  throw new Error('Public signer smoke requires an HTTPS base URL. Use --allow-http only for local diagnostics.');
}

const health = await request('GET', '/health');
assertStatus(health, 200, 'health');
if (health.body.status !== 'ok') {
  throw new Error(`health expected status=ok, got ${JSON.stringify(health.body).slice(0, 500)}`);
}

const readiness = await request('GET', '/v1/readiness');
assertStatus(readiness, 200, 'readiness');

if (options.expectProvider && readiness.body.provider !== options.expectProvider) {
  throw new Error(`expected provider ${options.expectProvider}, got ${readiness.body.provider}`);
}

if (options.requireReady && readiness.body.ok !== true) {
  throw new Error(`signer readiness is not ok: ${JSON.stringify(readiness.body).slice(0, 500)}`);
}

if (options.requireDurableLedger) {
  const ledger = readiness.body.ledger || {};
  if (ledger.backend !== 'upstash_redis' || ledger.durable_configured !== true) {
    throw new Error(`signer ledger is not durable: ${JSON.stringify(ledger).slice(0, 300)}`);
  }
}

const unauthorized = await request('GET', '/v1/agents');
const expectedUnauthorizedStatus = readiness.body.admin_token_configured ? 401 : 503;
assertStatus(unauthorized, expectedUnauthorizedStatus, 'unauthorized agent inventory');

let authorized = null;
let authorizedAgentCount = null;
if (options.adminToken) {
  authorized = await request('GET', '/v1/agents', {
    headers: {
      authorization: `Bearer ${options.adminToken}`,
    },
  });
  assertStatus(authorized, 200, 'authorized agent inventory');
  authorizedAgentCount = Array.isArray(authorized.body.agents) ? authorized.body.agents.length : null;
  if (authorizedAgentCount === null) {
    throw new Error('authorized agent inventory did not return an agents array');
  }
}

console.log(JSON.stringify({
  ok: true,
  base_url: options.baseUrl,
  read_only: true,
  health_status: health.status,
  readiness_status: readiness.status,
  provider: readiness.body.provider,
  readiness_ok: readiness.body.ok,
  admin_token_configured: readiness.body.admin_token_configured,
  ledger_backend: readiness.body.ledger?.backend ?? null,
  ledger_durable_configured: readiness.body.ledger?.durable_configured ?? null,
  unauthorized_status: unauthorized.status,
  authorized_status: authorized?.status ?? null,
  authorized_agent_count: authorizedAgentCount,
  note: 'No payment/signing route was called.',
}, null, 2));

async function request(method, path, init = {}) {
  const response = await fetch(`${options.baseUrl}${path}`, {
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
    baseUrl: '',
    adminToken: process.env.SIGNER_ADMIN_TOKEN || '',
    expectProvider: process.env.EXPECT_SIGNER_PROVIDER || '',
    requireReady: process.env.REQUIRE_SIGNER_READY === 'true',
    requireDurableLedger: process.env.REQUIRE_DURABLE_SIGNER_LEDGER === 'true',
    allowHttp: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--') && !values.baseUrl) {
      values.baseUrl = arg.replace(/\/$/, '');
    } else if (arg === '--expect-provider' && next) {
      values.expectProvider = next;
      i += 1;
    } else if (arg === '--require-ready') {
      values.requireReady = true;
    } else if (arg === '--require-durable-ledger') {
      values.requireDurableLedger = true;
    } else if (arg === '--admin-token-env' && next) {
      values.adminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-smoke-test.js https://signer.example [--expect-provider turnkey] [--require-ready] [--require-durable-ledger] [--admin-token-env SIGNER_ADMIN_TOKEN]');
      process.exit(0);
    }
  }

  return values;
}
