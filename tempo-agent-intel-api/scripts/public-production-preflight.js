import { fileURLToPath } from 'node:url';
import { runPublicOutboundReadinessSmoke } from './public-outbound-readiness-smoke.js';

const DISCOVERY_PATHS = [
  '/openapi.json',
  '/llms.txt',
  '/.well-known/agent-card.json',
  '/.well-known/x402',
];

export async function runPublicProductionPreflight(options) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');

  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }

  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public production preflight.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public production preflight.');
  }

  const secretValues = [options.agentAdminToken, options.signerAdminToken].filter(Boolean);

  const signer = await runSignerPreflight({
    baseUrl: signerUrl,
    adminToken: options.signerAdminToken,
    expectProvider: options.expectSignerProvider || 'turnkey',
    requireReady: options.requireSignerReady !== false,
    requireDurableLedger: options.requireDurableSignerLedger !== false,
    secretValues,
  });

  const core = await runAgentCorePreflight(agentUrl, secretValues);
  const discovery = await runAgentDiscoveryPreflight(agentUrl, secretValues);
  const agent = await runPublicOutboundReadinessSmoke({
    baseUrl: agentUrl,
    adminToken: options.agentAdminToken,
    expectPaymentMode: options.expectPaymentMode || 'tempo',
    requireOutboundReady: options.requireOutboundReady !== false,
    requireDurableStorage: options.requireDurableStorage !== false,
    requireDurableSignerLedger: options.requireDurableSignerLedger !== false,
    requireSignerAdminRateLimit: true,
    allowHttp: options.allowHttp,
  });

  assertNoSecretLeak('agent outbound readiness summary', JSON.stringify(agent), secretValues);

  return {
    ok: true,
    read_only: true,
    agent: {
      base_url: agentUrl,
      core,
      health: agent.health,
      discovery,
      tempo_readiness: agent.tempo_readiness,
      outbound_readiness: agent.outbound_readiness,
    },
    signer,
    required: {
      payment_mode: options.expectPaymentMode || 'tempo',
      signer_provider: options.expectSignerProvider || 'turnkey',
      durable_agent_storage: options.requireDurableStorage !== false,
      durable_signer_ledger: options.requireDurableSignerLedger !== false,
      outbound_ready: options.requireOutboundReady !== false,
      signer_ready: options.requireSignerReady !== false,
    },
    note: 'No report POST, signer payment/fetch, signing, or outbound MPP route was called.',
  };
}

async function runAgentCorePreflight(baseUrl, secretValues) {
  const health = await request(baseUrl, 'GET', '/health');
  assertStatus(health, 200, 'agent health');
  assertNoSecretLeak('agent health', health.text, secretValues);

  const tempoReadiness = await request(baseUrl, 'GET', '/v1/runtime/tempo-readiness');
  assertStatus(tempoReadiness, 200, 'agent tempo readiness');
  assertNoSecretLeak('agent tempo readiness', tempoReadiness.text, secretValues);

  return {
    health_status: health.status,
    tempo_readiness_status: tempoReadiness.status,
  };
}

async function runSignerPreflight(options) {
  const health = await request(options.baseUrl, 'GET', '/health');
  assertStatus(health, 200, 'signer health');
  assertNoSecretLeak('signer health', health.text, options.secretValues);

  if (health.body.status !== 'ok') {
    throw new Error(`signer health expected status=ok, got ${JSON.stringify(health.body).slice(0, 500)}`);
  }

  const readiness = await request(options.baseUrl, 'GET', '/v1/readiness');
  assertStatus(readiness, 200, 'signer readiness');
  assertNoSecretLeak('signer readiness', readiness.text, options.secretValues);

  if (readiness.body.provider !== options.expectProvider) {
    throw new Error(`expected signer provider ${options.expectProvider}, got ${readiness.body.provider}`);
  }

  if (options.requireReady && readiness.body.ok !== true) {
    throw new Error(`signer readiness is not ok: ${JSON.stringify(readiness.body).slice(0, 700)}`);
  }

  if (readiness.body.admin_token_configured !== true) {
    throw new Error('signer admin token is not configured.');
  }

  if (options.requireDurableLedger) {
    const ledger = readiness.body.ledger || {};
    if (ledger.backend !== 'upstash_redis' || ledger.durable_configured !== true) {
      throw new Error(`signer ledger is not durable: ${JSON.stringify(ledger).slice(0, 300)}`);
    }
  }
  const adminRateLimit = assertSafeSignerAdminRateLimit(readiness.body.admin_rate_limit || {});

  const unauthorized = await request(options.baseUrl, 'GET', '/v1/agents');
  assertStatus(unauthorized, 401, 'unauthorized signer agent inventory');
  assertNoSecretLeak('unauthorized signer agent inventory', unauthorized.text, options.secretValues);

  const authorized = await request(options.baseUrl, 'GET', '/v1/agents', {
    headers: {
      authorization: `Bearer ${options.adminToken}`,
    },
  });
  assertStatus(authorized, 200, 'authorized signer agent inventory');
  assertNoSecretLeak('authorized signer agent inventory', authorized.text, options.secretValues);

  if (!Array.isArray(authorized.body.agents)) {
    throw new Error('authorized signer agent inventory did not return an agents array.');
  }

  return {
    base_url: options.baseUrl,
    provider: readiness.body.provider,
    readiness_ok: readiness.body.ok,
    admin_token_configured: readiness.body.admin_token_configured,
    ledger_backend: readiness.body.ledger?.backend ?? null,
    ledger_durable_configured: readiness.body.ledger?.durable_configured ?? null,
    admin_rate_limit: adminRateLimit,
    unauthorized_status: unauthorized.status,
    authorized_status: authorized.status,
    authorized_agent_count: authorized.body.agents.length,
  };
}

function assertSafeSignerAdminRateLimit(rateLimit) {
  if (rateLimit.enabled !== true) {
    throw new Error(`signer admin rate limit is not enabled: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  const max = Number(rateLimit.max);
  if (!Number.isInteger(max) || max < 1 || max > 120) {
    throw new Error(`signer admin rate limit max must be between 1 and 120: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  const windowMs = Number(rateLimit.window_ms);
  if (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 3_600_000) {
    throw new Error(`signer admin rate limit window_ms must be between 1000 and 3600000: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  return {
    enabled: true,
    max,
    window_ms: windowMs,
  };
}

async function runAgentDiscoveryPreflight(baseUrl, secretValues) {
  const statuses = {};

  for (const path of DISCOVERY_PATHS) {
    const result = await request(baseUrl, 'GET', path);
    assertStatus(result, 200, `agent discovery ${path}`);
    assertNoSecretLeak(`agent discovery ${path}`, result.text, secretValues);
    statuses[path] = result.status;
  }

  return {
    statuses,
  };
}

async function request(baseUrl, method, path, init = {}) {
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
    signerAdminToken: process.env.SIGNER_ADMIN_TOKEN || '',
    expectPaymentMode: process.env.EXPECT_PAYMENT_MODE || 'tempo',
    expectSignerProvider: process.env.EXPECT_SIGNER_PROVIDER || 'turnkey',
    requireOutboundReady: process.env.REQUIRE_OUTBOUND_READY !== 'false',
    requireDurableStorage: process.env.REQUIRE_DURABLE_STORAGE !== 'false',
    requireDurableSignerLedger: process.env.REQUIRE_DURABLE_SIGNER_LEDGER !== 'false',
    requireSignerReady: process.env.REQUIRE_SIGNER_READY !== 'false',
    allowHttp: false,
  };

  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--')) {
      positional.push(arg);
    } else if (arg === '--agent-url' && next) {
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
    } else if (arg === '--expect-payment-mode' && next) {
      values.expectPaymentMode = next;
      i += 1;
    } else if (arg === '--expect-signer-provider' && next) {
      values.expectSignerProvider = next;
      i += 1;
    } else if (arg === '--no-require-outbound-ready') {
      values.requireOutboundReady = false;
    } else if (arg === '--no-require-durable-storage') {
      values.requireDurableStorage = false;
    } else if (arg === '--no-require-durable-signer-ledger') {
      values.requireDurableSignerLedger = false;
    } else if (arg === '--no-require-signer-ready') {
      values.requireSignerReady = false;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-production-preflight.js --agent-url https://agent.example --signer-url https://signer.example [--agent-admin-token-env OUTBOUND_ADMIN_TOKEN] [--signer-admin-token-env SIGNER_ADMIN_TOKEN]');
      process.exit(0);
    }
  }

  if (positional[0] && !values.agentUrl) {
    values.agentUrl = positional[0];
  }
  if (positional[1] && !values.signerUrl) {
    values.signerUrl = positional[1];
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicProductionPreflight(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
