import { fileURLToPath } from 'node:url';
import { runPublicOutboundCronSafetySmoke } from './public-outbound-cron-safety-smoke.js';
import { runPublicOutboundReconcile } from './public-outbound-reconcile.js';

const DEFAULT_EXPECTED_AMOUNT_BASE_UNITS = '10000';

export async function runPublicCronArmingReadiness(options) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for cron arming readiness.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for cron arming readiness.');
  }
  if (!options.idempotencyKey) {
    throw new Error('--idempotency-key is required for cron arming readiness.');
  }

  const secretValues = [options.agentAdminToken, options.signerAdminToken].filter(Boolean);
  const reconciliation = await runPublicOutboundReconcile({
    agentUrl,
    signerUrl,
    agentAdminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    idempotencyKey: options.idempotencyKey,
    agentId: options.agentId,
    eventLimit: options.eventLimit,
    allowHttp: options.allowHttp,
    expectedService: options.expectedService || 'mpp.browserbase.com',
    expectedCommand: options.expectedCommand || 'fetch_browserbase_page',
    expectedEndpoint: options.expectedEndpoint || 'https://mpp.browserbase.com/fetch',
    expectedAmountBaseUnits: options.expectedAmountBaseUnits || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
  });

  if (reconciliation.agent.event_type !== 'outbound_admin_payment_succeeded') {
    throw new Error(`Cron arming requires outbound_admin_payment_succeeded, got ${reconciliation.agent.event_type}.`);
  }
  if (reconciliation.agent.trigger !== 'admin_manual') {
    throw new Error(`Cron arming requires trigger=admin_manual, got ${reconciliation.agent.trigger}.`);
  }

  const cronSafety = await runPublicOutboundCronSafetySmoke({
    baseUrl: agentUrl,
    expectAuthGated: options.expectCronAuthGated === true,
    allowHttp: options.allowHttp,
  });

  const summary = {
    ok: true,
    read_only: true,
    agent_url: agentUrl,
    signer_url: signerUrl,
    idempotency_key: options.idempotencyKey,
    checks: {
      manual_outbound_reconciliation: {
        ok: reconciliation.ok,
        agent_event_id: reconciliation.agent.event_id,
        agent_event_type: reconciliation.agent.event_type,
        trigger: reconciliation.agent.trigger,
        signer_status: reconciliation.signer.status,
        service: reconciliation.agent.service,
        endpoint: reconciliation.agent.endpoint,
        amount_base_units: reconciliation.agent.amount_base_units,
      },
      cron_safety: {
        ok: cronSafety.ok,
        expected_mode: cronSafety.expected_mode,
        status: cronSafety.status,
        sent_authorization_header: cronSafety.sent_authorization_header,
      },
    },
    arming_env: {
      OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT: 'true',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: options.idempotencyKey,
    },
    next_manual_boundary: 'Set the arming env and enable cron only after this read-only check passes and the wallet/balance reconciliation is approved.',
    note: 'Read-only cron arming readiness. No bearer cron token, payment, signing, signer MPP fetch, or downstream MPP route was called.',
  };

  assertNoSecretLeak('cron arming readiness summary', JSON.stringify(summary), secretValues);
  return summary;
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
    idempotencyKey: process.env.OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY || process.env.OUTBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    agentId: process.env.OUTBOUND_SIGNER_AGENT_ID || 'agent-launch-intel',
    eventLimit: Number(process.env.OUTBOUND_RECONCILE_EVENT_LIMIT || 100),
    expectCronAuthGated: process.env.EXPECT_OUTBOUND_CRON_AUTH_GATED === 'true',
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || 'fetch_browserbase_page',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || 'https://mpp.browserbase.com/fetch',
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
    allowHttp: false,
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
    } else if (arg === '--expect-cron-auth-gated') {
      values.expectCronAuthGated = true;
    } else if (arg === '--expect-cron-disabled') {
      values.expectCronAuthGated = false;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-cron-arming-readiness.js --agent-url https://agent.example --signer-url https://signer.example --idempotency-key first-live-browserbase-001 [--expect-cron-disabled|--expect-cron-auth-gated]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicCronArmingReadiness(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
