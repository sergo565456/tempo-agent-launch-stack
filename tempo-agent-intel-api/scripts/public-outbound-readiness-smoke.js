import { fileURLToPath } from 'node:url';

export async function runPublicOutboundReadinessSmoke(options) {
  const baseUrl = (options.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error('baseUrl is required.');
  }
  if (!options.allowHttp && !/^https:\/\//.test(baseUrl)) {
    throw new Error('Public outbound readiness smoke requires HTTPS. Use allowHttp only for local diagnostics.');
  }
  if (!options.adminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required to run the outbound readiness smoke.');
  }

  const health = await request(baseUrl, 'GET', '/health');
  assertStatus(health, 200, 'health');

  if (options.expectPaymentMode && health.body.payment_mode !== options.expectPaymentMode) {
    throw new Error(`expected payment_mode ${options.expectPaymentMode}, got ${health.body.payment_mode}`);
  }

  if (options.requireDurableStorage) {
    const storage = health.body.storage || {};
    if (storage.backend !== 'upstash_redis' || storage.durable_configured !== true) {
      throw new Error(`agent storage is not durable: ${JSON.stringify(storage).slice(0, 300)}`);
    }
  }

  const tempoReadiness = await request(baseUrl, 'GET', '/v1/runtime/tempo-readiness');
  assertStatus(tempoReadiness, 200, 'tempo readiness');

  const unauthorized = await request(baseUrl, 'GET', '/v1/admin/outbound/readiness');
  assertStatus(unauthorized, 401, 'unauthorized outbound readiness');

  const outbound = await request(baseUrl, 'GET', '/v1/admin/outbound/readiness', {
    headers: {
      authorization: `Bearer ${options.adminToken}`,
    },
  });
  assertStatus(outbound, 200, 'authorized outbound readiness');

  const serializedOutbound = JSON.stringify(outbound.body);
  if (serializedOutbound.includes(options.adminToken)) {
    throw new Error('outbound readiness response leaked OUTBOUND_ADMIN_TOKEN');
  }

  if (options.requireOutboundReady && outbound.body.ok !== true) {
    throw new Error(`outbound readiness is not ok: ${serializedOutbound.slice(0, 700)}`);
  }

  if (options.requireDurableSignerLedger) {
    const ledger = outbound.body.remote_signer?.readiness?.ledger || {};
    if (ledger.backend !== 'upstash_redis' || ledger.durable_configured !== true) {
      throw new Error(`remote signer ledger is not durable: ${JSON.stringify(ledger).slice(0, 300)}`);
    }
  }

  const signerAdminRateLimit = normalizeSignerAdminRateLimit(
    outbound.body.remote_signer?.readiness?.admin_rate_limit,
    options.requireSignerAdminRateLimit,
  );

  return {
    ok: true,
    base_url: baseUrl,
    read_only: true,
    health: {
      payment_mode: health.body.payment_mode,
      outbound_live_payments: health.body.outbound_live_payments,
      storage_backend: health.body.storage?.backend ?? null,
      storage_durable_configured: health.body.storage?.durable_configured ?? null,
    },
    tempo_readiness: {
      ok: tempoReadiness.body.ok,
      live_enabled: tempoReadiness.body.live_enabled,
    },
    outbound_readiness: {
      ok: outbound.body.ok,
      provider: outbound.body.payment_provider,
      signer_provider: outbound.body.remote_signer?.readiness?.provider ?? null,
      signer_readiness_ok: outbound.body.remote_signer?.readiness?.ok ?? null,
      signer_ledger_backend: outbound.body.remote_signer?.readiness?.ledger?.backend ?? null,
      signer_ledger_durable_configured: outbound.body.remote_signer?.readiness?.ledger?.durable_configured ?? null,
      signer_admin_rate_limit: signerAdminRateLimit,
      signer_agent_policy_found: outbound.body.remote_signer?.agent_policy?.found ?? null,
      blockers: outbound.body.blockers,
      warnings: outbound.body.warnings,
    },
    unauthorized_status: unauthorized.status,
    authorized_status: outbound.status,
    note: 'No report, payment, signing, or outbound MPP fetch route was called.',
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
  };
}

function normalizeSignerAdminRateLimit(rateLimit, required) {
  if (!rateLimit || Object.keys(rateLimit).length === 0) {
    if (required) {
      throw new Error('remote signer admin rate limit is not exposed by outbound readiness.');
    }
    return null;
  }

  const max = Number(rateLimit.max);
  const windowMs = Number(rateLimit.window_ms);
  const normalized = {
    enabled: rateLimit.enabled === true,
    max,
    window_ms: windowMs,
  };

  if (required && normalized.enabled !== true) {
    throw new Error(`remote signer admin rate limit is not enabled: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  if (required && (!Number.isInteger(max) || max < 1 || max > 120)) {
    throw new Error(`remote signer admin rate limit max must be between 1 and 120: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  if (required && (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 3_600_000)) {
    throw new Error(`remote signer admin rate limit window_ms must be between 1000 and 3600000: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  return normalized;
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
  }
}

function parseArgs(args) {
  const values = {
    baseUrl: process.env.PUBLIC_AGENT_BASE_URL || '',
    adminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    expectPaymentMode: process.env.EXPECT_PAYMENT_MODE || '',
    requireOutboundReady: process.env.REQUIRE_OUTBOUND_READY === 'true',
    requireDurableStorage: process.env.REQUIRE_DURABLE_STORAGE === 'true',
    requireDurableSignerLedger: process.env.REQUIRE_DURABLE_SIGNER_LEDGER === 'true',
    requireSignerAdminRateLimit: process.env.REQUIRE_SIGNER_ADMIN_RATE_LIMIT === 'true',
    allowHttp: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--') && !values.baseUrl) {
      values.baseUrl = arg;
    } else if (arg === '--admin-token-env' && next) {
      values.adminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--expect-payment-mode' && next) {
      values.expectPaymentMode = next;
      i += 1;
    } else if (arg === '--require-outbound-ready') {
      values.requireOutboundReady = true;
    } else if (arg === '--require-durable-storage') {
      values.requireDurableStorage = true;
    } else if (arg === '--require-durable-signer-ledger') {
      values.requireDurableSignerLedger = true;
    } else if (arg === '--require-signer-admin-rate-limit') {
      values.requireSignerAdminRateLimit = true;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-readiness-smoke.js https://agent.example [--admin-token-env OUTBOUND_ADMIN_TOKEN] [--expect-payment-mode tempo] [--require-outbound-ready] [--require-durable-storage] [--require-durable-signer-ledger] [--require-signer-admin-rate-limit]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicOutboundReadinessSmoke(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
