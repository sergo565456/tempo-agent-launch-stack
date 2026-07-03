import { fileURLToPath } from 'node:url';
import { runPublicProductionPreflight } from './public-production-preflight.js';
import { runPublicOutboundCronSafetySmoke } from './public-outbound-cron-safety-smoke.js';
import { runPublicOutboundCronReadinessSmoke } from './public-outbound-cron-readiness-smoke.js';

const DEFAULT_EXPECTED_ENDPOINT = 'https://mpp.browserbase.com/fetch';
const DEFAULT_EXPECTED_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const DEFAULT_EXPECTED_CURRENCY = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_EXPECTED_CHAIN_ID = 4217;
const DEFAULT_EXPECTED_AMOUNT_BASE_UNITS = '10000';

export async function runPublicAutonomousReadinessSuite(options) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public autonomous readiness suite.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public autonomous readiness suite.');
  }

  const secretValues = [options.agentAdminToken, options.signerAdminToken].filter(Boolean);
  const productionPreflight = await runPublicProductionPreflight({
    agentUrl,
    signerUrl,
    agentAdminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    expectPaymentMode: options.expectPaymentMode || 'tempo',
    expectSignerProvider: options.expectSignerProvider || 'turnkey',
    requireOutboundReady: true,
    requireDurableStorage: true,
    requireDurableSignerLedger: true,
    requireSignerReady: true,
    allowHttp: options.allowHttp,
  });

  const cronSafety = await runPublicOutboundCronSafetySmoke({
    baseUrl: agentUrl,
    expectAuthGated: options.expectCronAuthGated === true,
    allowHttp: options.allowHttp,
  });
  const cronReadiness = await runPublicOutboundCronReadinessSmoke({
    baseUrl: agentUrl,
    agentAdminToken: options.agentAdminToken,
    expectAuthGated: options.expectCronAuthGated === true,
    expectReadyToEnable: options.expectCronReadyToEnable === true,
    allowHttp: options.allowHttp,
  });

  const preview = await runOutboundPreviewCheck(agentUrl, options, secretValues);
  const paymentEvents = await runPaymentEventsCheck(agentUrl, options, secretValues);

  const summary = {
    ok: true,
    read_only: true,
    agent_url: agentUrl,
    signer_url: signerUrl,
    checks: {
      production_preflight: {
        ok: productionPreflight.ok,
        payment_mode: productionPreflight.agent.health.payment_mode,
        signer_provider: productionPreflight.signer.provider,
        storage_backend: productionPreflight.agent.health.storage_backend,
        signer_ledger_backend: productionPreflight.signer.ledger_backend,
      },
      cron_safety: {
        ok: cronSafety.ok,
        expected_mode: cronSafety.expected_mode,
        status: cronSafety.status,
        sent_authorization_header: cronSafety.sent_authorization_header,
      },
      cron_readiness: {
        ok: cronReadiness.ok,
        expected_mode: cronReadiness.expected_mode,
        ready_to_enable: cronReadiness.ready_to_enable,
        ready_to_run_authorized: cronReadiness.ready_to_run_authorized,
        cron_enabled: cronReadiness.cron_enabled,
        arming_found: cronReadiness.arming_found,
      },
      outbound_preview: preview,
      payment_events: paymentEvents,
    },
    next_live_boundary: 'Manual env upload/deploy confirmation, first live inbound/outbound payment, reconciliation, cron readiness arming, then cron enablement.',
    note: 'Read-only autonomous readiness suite. No report POST, payment, signing, signer MPP fetch, or downstream MPP route was called.',
  };

  assertNoSecretLeak('autonomous readiness suite summary', JSON.stringify(summary), secretValues);
  return summary;
}

async function runOutboundPreviewCheck(agentUrl, options, secretValues) {
  const idempotencyKey = options.previewIdempotencyKey || 'readiness-preview-no-payment';
  const url = new URL('/v1/admin/outbound/browserbase-fetch/preview', agentUrl);
  url.searchParams.set('idempotency_key', idempotencyKey);
  const preview = await request(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.agentAdminToken}`,
    },
  });
  assertStatus(preview, 200, 'outbound preview');
  assertNoSecretLeak('outbound preview', preview.text, secretValues);
  if (preview.body.read_only !== true) {
    throw new Error('outbound preview must declare read_only=true.');
  }
  if (preview.body.ok !== true) {
    throw new Error(`outbound preview is not ready: ${JSON.stringify(preview.body).slice(0, 700)}`);
  }

  const payload = preview.body.request?.body || {};
  assertEqual(payload.confirm, 'fetch-one-mpp-endpoint', 'preview.confirm');
  assertEqual(payload.idempotency_key, idempotencyKey, 'preview.idempotency_key');
  assertEqual(payload.command, options.expectedCommand || 'fetch_browserbase_page', 'preview.command');
  assertEqual(payload.service, options.expectedService || 'mpp.browserbase.com', 'preview.service');
  assertEqual(payload.endpoint, options.expectedEndpoint || DEFAULT_EXPECTED_ENDPOINT, 'preview.endpoint');
  assertEqual(payload.recipient?.toLowerCase(), (options.expectedRecipient || DEFAULT_EXPECTED_RECIPIENT).toLowerCase(), 'preview.recipient');
  assertEqual(payload.currency?.toLowerCase(), (options.expectedCurrency || DEFAULT_EXPECTED_CURRENCY).toLowerCase(), 'preview.currency');
  assertEqual(Number(payload.chain_id), Number(options.expectedChainId || DEFAULT_EXPECTED_CHAIN_ID), 'preview.chain_id');
  assertEqual(String(payload.amount_base_units), String(options.expectedAmountBaseUnits || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS), 'preview.amount_base_units');

  return {
    ok: true,
    read_only: true,
    idempotency_key: idempotencyKey,
    service: payload.service,
    endpoint: payload.endpoint,
    amount_base_units: payload.amount_base_units,
    blockers: preview.body.blockers || [],
    warnings: preview.body.warnings || [],
  };
}

async function runPaymentEventsCheck(agentUrl, options, secretValues) {
  const unauthorized = await request(new URL('/v1/admin/payment-events?limit=1', agentUrl), {
    method: 'GET',
  });
  assertStatus(unauthorized, 401, 'unauthorized payment events');
  assertNoSecretLeak('unauthorized payment events', unauthorized.text, secretValues);

  const authorized = await request(new URL('/v1/admin/payment-events?limit=1', agentUrl), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.agentAdminToken}`,
    },
  });
  assertStatus(authorized, 200, 'authorized payment events');
  assertNoSecretLeak('authorized payment events', authorized.text, secretValues);
  if (authorized.body.read_only !== true) {
    throw new Error('payment events response must declare read_only=true.');
  }
  if (!Array.isArray(authorized.body.events)) {
    throw new Error('payment events response must include an events array.');
  }

  return {
    ok: true,
    read_only: true,
    unauthorized_status: unauthorized.status,
    authorized_status: authorized.status,
    total_events: authorized.body.total_events,
    returned_events: authorized.body.events.length,
  };
}

async function request(url, init = {}) {
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
    previewIdempotencyKey: process.env.OUTBOUND_PREVIEW_IDEMPOTENCY_KEY || 'readiness-preview-no-payment',
    expectPaymentMode: process.env.EXPECT_PAYMENT_MODE || 'tempo',
    expectSignerProvider: process.env.EXPECT_SIGNER_PROVIDER || 'turnkey',
    expectCronAuthGated: process.env.EXPECT_OUTBOUND_CRON_AUTH_GATED === 'true',
    expectCronReadyToEnable: process.env.EXPECT_OUTBOUND_CRON_READY_TO_ENABLE === 'true',
    allowHttp: false,
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || 'fetch_browserbase_page',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || DEFAULT_EXPECTED_ENDPOINT,
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || DEFAULT_EXPECTED_RECIPIENT,
    expectedCurrency: process.env.EXPECTED_OUTBOUND_CURRENCY || DEFAULT_EXPECTED_CURRENCY,
    expectedChainId: Number(process.env.EXPECTED_OUTBOUND_CHAIN_ID || DEFAULT_EXPECTED_CHAIN_ID),
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
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
    } else if (arg === '--preview-idempotency-key' && next) {
      values.previewIdempotencyKey = next;
      i += 1;
    } else if (arg === '--expect-cron-auth-gated') {
      values.expectCronAuthGated = true;
      values.expectCronReadyToEnable = false;
    } else if (arg === '--expect-cron-ready-to-enable') {
      values.expectCronReadyToEnable = true;
      values.expectCronAuthGated = false;
    } else if (arg === '--expect-cron-disabled') {
      values.expectCronAuthGated = false;
      values.expectCronReadyToEnable = false;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-autonomous-readiness-suite.js --agent-url https://agent.example --signer-url https://signer.example [--expect-cron-disabled|--expect-cron-auth-gated]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicAutonomousReadinessSuite(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
