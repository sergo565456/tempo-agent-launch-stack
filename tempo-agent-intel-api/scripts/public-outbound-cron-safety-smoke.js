import { fileURLToPath } from 'node:url';

export async function runPublicOutboundCronSafetySmoke(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!options.allowHttp && !/^https:\/\//.test(baseUrl)) {
    throw new Error('Public outbound cron safety smoke requires HTTPS. Use --allow-http only for local diagnostics.');
  }

  const mode = options.expectAuthGated ? 'auth_gated' : 'disabled';
  const response = await request(baseUrl, '/api/cron/outbound/browserbase-fetch');

  if (mode === 'disabled') {
    assertStatus(response, 503, 'outbound cron disabled check');
    if (response.body?.error !== 'outbound_cron_disabled') {
      throw new Error(`Expected outbound_cron_disabled, got ${JSON.stringify(response.body).slice(0, 300)}`);
    }
  } else {
    assertStatus(response, 401, 'outbound cron auth-gated check');
    if (response.body?.error !== 'unauthorized') {
      throw new Error(`Expected unauthorized, got ${JSON.stringify(response.body).slice(0, 300)}`);
    }
  }

  return {
    ok: true,
    base_url: baseUrl,
    read_only: true,
    sent_authorization_header: false,
    expected_mode: mode,
    status: response.status,
    error: response.body?.error ?? null,
    note: 'No bearer token was sent, so this smoke cannot trigger an outbound payment.',
  };
}

async function request(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
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
    expectAuthGated: process.env.EXPECT_OUTBOUND_CRON_AUTH_GATED === 'true',
    allowHttp: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--') && !values.baseUrl) {
      values.baseUrl = arg;
    } else if (arg === '--expect-disabled') {
      values.expectAuthGated = false;
    } else if (arg === '--expect-auth-gated') {
      values.expectAuthGated = true;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-cron-safety-smoke.js https://agent.example [--expect-disabled|--expect-auth-gated]');
      process.exit(0);
    } else if (arg === '--base-url' && next) {
      values.baseUrl = next;
      i += 1;
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicOutboundCronSafetySmoke(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
