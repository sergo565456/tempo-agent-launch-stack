import { fileURLToPath } from 'node:url';
import { runPublicSignerProductionPreflight } from '../../tempo-outbound-signer/scripts/public-production-preflight.js';
import { runPublicAutonomousReadinessSuite } from './public-autonomous-readiness-suite.js';

export async function runPublicAutonomousGoLiveReadiness(options) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public autonomous go-live readiness.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public autonomous go-live readiness.');
  }

  const secretValues = [options.agentAdminToken, options.signerAdminToken].filter(Boolean);
  const signerProduction = await runPublicSignerProductionPreflight({
    baseUrl: signerUrl,
    adminToken: options.signerAdminToken,
    expectProvider: options.expectSignerProvider || 'turnkey',
    expectAgentId: options.expectSignerAgentId || 'agent-launch-intel',
    ledgerProbeIdempotencyKey: options.signerLedgerProbeIdempotencyKey,
    allowHttp: options.allowHttp,
    expectedService: options.expectedService,
    expectedEndpoint: options.expectedEndpoint,
    expectedCommand: options.expectedCommand,
    expectedRecipient: options.expectedRecipient,
  });

  const autonomousReadiness = await runPublicAutonomousReadinessSuite({
    agentUrl,
    signerUrl,
    agentAdminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    previewIdempotencyKey: options.previewIdempotencyKey,
    expectPaymentMode: options.expectPaymentMode || 'tempo',
    expectSignerProvider: options.expectSignerProvider || 'turnkey',
    expectCronAuthGated: options.expectCronAuthGated === true,
    expectCronReadyToEnable: options.expectCronReadyToEnable === true,
    allowHttp: options.allowHttp,
    expectedService: options.expectedService,
    expectedCommand: options.expectedCommand,
    expectedEndpoint: options.expectedEndpoint,
    expectedRecipient: options.expectedRecipient,
    expectedCurrency: options.expectedCurrency,
    expectedChainId: options.expectedChainId,
    expectedAmountBaseUnits: options.expectedAmountBaseUnits,
  });

  const summary = {
    ok: true,
    read_only: true,
    agent_url: agentUrl,
    signer_url: signerUrl,
    checks: {
      signer_production_preflight: {
        ok: signerProduction.ok,
        provider: signerProduction.provider,
        ledger_backend: signerProduction.ledger_backend,
        ledger_durable_configured: signerProduction.ledger_durable_configured,
        expected_agent_id: signerProduction.expected_agent_id,
        expected_agent_found: signerProduction.expected_agent_found,
        unauthorized_ledger_status: signerProduction.unauthorized_ledger_status,
        authorized_empty_ledger_status: signerProduction.authorized_empty_ledger_status,
      },
      autonomous_readiness: {
        ok: autonomousReadiness.ok,
        production_preflight_ok: autonomousReadiness.checks.production_preflight.ok,
        cron_expected_mode: autonomousReadiness.checks.cron_safety.expected_mode,
        cron_status: autonomousReadiness.checks.cron_safety.status,
        cron_readiness_expected_mode: autonomousReadiness.checks.cron_readiness.expected_mode,
        cron_ready_to_enable: autonomousReadiness.checks.cron_readiness.ready_to_enable,
        cron_ready_to_run_authorized: autonomousReadiness.checks.cron_readiness.ready_to_run_authorized,
        outbound_preview_amount_base_units: autonomousReadiness.checks.outbound_preview.amount_base_units,
        payment_events_authorized_status: autonomousReadiness.checks.payment_events.authorized_status,
      },
    },
    next_manual_boundary: 'Upload real env, deploy public signer/agent, approve first inbound/outbound live payment, reconcile, then enable cron.',
    note: 'Read-only go-live readiness orchestrator. It calls signer production preflight and agent autonomous readiness only. No deploy, report POST, payment, signing, signer MPP fetch, or downstream MPP route was called.',
  };

  assertNoSecretLeak('autonomous go-live readiness summary', JSON.stringify(summary), secretValues);
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
    previewIdempotencyKey: process.env.OUTBOUND_PREVIEW_IDEMPOTENCY_KEY || 'readiness-preview-no-payment',
    signerLedgerProbeIdempotencyKey: process.env.SIGNER_LEDGER_PROBE_IDEMPOTENCY_KEY || 'signer-public-preflight-no-record',
    expectPaymentMode: process.env.EXPECT_PAYMENT_MODE || 'tempo',
    expectSignerProvider: process.env.EXPECT_SIGNER_PROVIDER || 'turnkey',
    expectSignerAgentId: process.env.EXPECT_SIGNER_AGENT_ID || 'agent-launch-intel',
    expectCronAuthGated: process.env.EXPECT_OUTBOUND_CRON_AUTH_GATED === 'true',
    expectCronReadyToEnable: process.env.EXPECT_OUTBOUND_CRON_READY_TO_ENABLE === 'true',
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || undefined,
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || undefined,
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || undefined,
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || undefined,
    expectedCurrency: process.env.EXPECTED_OUTBOUND_CURRENCY || undefined,
    expectedChainId: process.env.EXPECTED_OUTBOUND_CHAIN_ID ? Number(process.env.EXPECTED_OUTBOUND_CHAIN_ID) : undefined,
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || undefined,
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
    } else if (arg === '--preview-idempotency-key' && next) {
      values.previewIdempotencyKey = next;
      i += 1;
    } else if (arg === '--signer-ledger-probe-idempotency-key' && next) {
      values.signerLedgerProbeIdempotencyKey = next;
      i += 1;
    } else if (arg === '--expect-payment-mode' && next) {
      values.expectPaymentMode = next;
      i += 1;
    } else if (arg === '--expect-signer-provider' && next) {
      values.expectSignerProvider = next;
      i += 1;
    } else if (arg === '--expect-signer-agent-id' && next) {
      values.expectSignerAgentId = next;
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
      console.log('Usage: node scripts/public-autonomous-go-live-readiness.js --agent-url https://agent.example --signer-url https://signer.example [--expect-cron-disabled|--expect-cron-auth-gated]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicAutonomousGoLiveReadiness(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
