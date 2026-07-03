import { fileURLToPath } from 'node:url';

export async function runPublicOutboundCronReadinessSmoke(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || options.agentUrl);
  if (!options.allowHttp && !/^https:\/\//.test(baseUrl)) {
    throw new Error('Public outbound cron readiness smoke requires HTTPS. Use --allow-http only for local diagnostics.');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public outbound cron readiness smoke.');
  }

  const secretValues = [options.agentAdminToken].filter(Boolean);
  const unauthorized = await request(baseUrl, {
    method: 'GET',
  });
  assertStatus(unauthorized, 401, 'unauthorized outbound cron readiness');
  assertNoSecretLeak('unauthorized outbound cron readiness', unauthorized.text, secretValues);

  const authorized = await request(baseUrl, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.agentAdminToken}`,
    },
  });
  assertStatus(authorized, 200, 'authorized outbound cron readiness');
  assertNoSecretLeak('authorized outbound cron readiness', authorized.text, secretValues);

  const body = authorized.body;
  if (body.read_only !== true) {
    throw new Error('outbound cron readiness response must declare read_only=true.');
  }
  if (!body.cron || typeof body.cron !== 'object') {
    throw new Error('outbound cron readiness response must include cron details.');
  }
  if (!body.arming || typeof body.arming !== 'object') {
    throw new Error('outbound cron readiness response must include arming details.');
  }
  if (body.cron.secret_configured !== true && body.cron.secret_configured !== false) {
    throw new Error('outbound cron readiness must expose only cron secret booleans, not secret values.');
  }
  if (String(body.note || '').includes('No cron bearer token') !== true) {
    throw new Error('outbound cron readiness note must state that no cron bearer token was sent.');
  }

  const expectedMode = options.expectAuthGated ? 'ready_to_run_authorized'
    : options.expectReadyToEnable ? 'ready_to_enable'
      : 'read_only_probe';

  if (options.expectAuthGated) {
    if (body.ok !== true || body.ready_to_run_authorized !== true) {
      throw new Error(`Expected cron readiness ready_to_run_authorized=true, got ${JSON.stringify(body).slice(0, 700)}`);
    }
    if (body.cron.enabled !== true) {
      throw new Error('Expected cron.enabled=true for an auth-gated cron runtime.');
    }
    if (body.arming.found !== true) {
      throw new Error('Expected arming.found=true for an auth-gated cron runtime.');
    }
  } else if (options.expectReadyToEnable) {
    if (body.ready_to_enable !== true) {
      throw new Error(`Expected cron readiness ready_to_enable=true, got ${JSON.stringify(body).slice(0, 700)}`);
    }
    if (body.ready_to_run_authorized !== false) {
      throw new Error('Expected ready_to_run_authorized=false before ENABLE_OUTBOUND_CRON=true.');
    }
    if (body.cron.enabled !== false) {
      throw new Error('Expected cron.enabled=false before cron is explicitly enabled.');
    }
    if (body.arming.found !== true) {
      throw new Error('Expected arming.found=true when checking ready_to_enable.');
    }
  } else if (body.ready_to_run_authorized === true) {
    throw new Error('Cron readiness unexpectedly reports ready_to_run_authorized=true. Use --expect-auth-gated only after cron was intentionally enabled.');
  }

  return {
    ok: true,
    base_url: baseUrl,
    read_only: true,
    expected_mode: expectedMode,
    unauthorized_status: unauthorized.status,
    authorized_status: authorized.status,
    ready_to_enable: body.ready_to_enable,
    ready_to_run_authorized: body.ready_to_run_authorized,
    cron_enabled: body.cron.enabled,
    cron_secret_configured: body.cron.secret_configured,
    cron_strong_secret_configured: body.cron.strong_secret_configured,
    next_idempotency_key: body.cron.next_idempotency_key,
    arming_found: body.arming.found,
    arming_idempotency_key: body.arming.expected_idempotency_key || body.arming.idempotency_key || null,
    blockers_count: Array.isArray(body.blockers) ? body.blockers.length : null,
    warnings_count: Array.isArray(body.warnings) ? body.warnings.length : null,
    note: 'Read-only outbound cron readiness smoke. No cron bearer token, signer request, payment, signing, or downstream MPP route was called.',
  };
}

async function request(baseUrl, init = {}) {
  const response = await fetch(`${baseUrl}/v1/admin/outbound/cron/readiness`, init);
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
    expectAuthGated: process.env.EXPECT_OUTBOUND_CRON_AUTH_GATED === 'true',
    expectReadyToEnable: process.env.EXPECT_OUTBOUND_CRON_READY_TO_ENABLE === 'true',
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
    } else if (arg === '--expect-auth-gated') {
      values.expectAuthGated = true;
      values.expectReadyToEnable = false;
    } else if (arg === '--expect-ready-to-enable') {
      values.expectReadyToEnable = true;
      values.expectAuthGated = false;
    } else if (arg === '--expect-disabled') {
      values.expectAuthGated = false;
      values.expectReadyToEnable = false;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-cron-readiness-smoke.js https://agent.example [--expect-disabled|--expect-ready-to-enable|--expect-auth-gated]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicOutboundCronReadinessSmoke(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
