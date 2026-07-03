import { fileURLToPath } from 'node:url';
import { runPublicAutonomousCompletionVerifier } from './public-autonomous-completion-verifier.js';
import { runPublicAutonomousGoLiveReadiness } from './public-autonomous-go-live-readiness.js';
import { runPublicCronArmingReadiness } from './public-cron-arming-readiness.js';
import { runPublicOutboundCronLiveRun } from './public-outbound-cron-live-run.js';
import { runPublicOutboundLivePayment } from './public-outbound-live-payment.js';

const DEFAULT_OUTBOUND_IDEMPOTENCY_KEY = 'first-live-browserbase-001';
const DEFAULT_INBOUND_AMOUNT_USD = '0.01';

const defaultDeps = {
  runPublicAutonomousGoLiveReadiness,
  runPublicOutboundLivePayment,
  runPublicCronArmingReadiness,
  runPublicAutonomousCompletionVerifier,
  runPublicOutboundCronLiveRun,
};

export async function runPublicLiveLaunchOrchestrator(options, deps = defaultDeps) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public live launch orchestration.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public live launch orchestration.');
  }

  const outboundIdempotencyKey = options.outboundIdempotencyKey || DEFAULT_OUTBOUND_IDEMPOTENCY_KEY;
  const secretValues = [
    options.agentAdminToken,
    options.signerAdminToken,
    options.cronSecret,
  ].filter(Boolean);
  const liveActionFlags = {
    outbound_payment: options.confirmLiveOutboundPayment === true,
    authorized_cron_run: options.confirmLiveCronRun === true,
  };

  const goLiveReadiness = await deps.runPublicAutonomousGoLiveReadiness({
    agentUrl,
    signerUrl,
    agentAdminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    previewIdempotencyKey: options.previewIdempotencyKey || outboundIdempotencyKey,
    expectCronAuthGated: options.expectCronAuthGated === true,
    expectCronReadyToEnable: options.expectCronReadyToEnable === true,
    expectPaymentMode: options.expectPaymentMode || 'tempo',
    expectSignerProvider: options.expectSignerProvider || 'turnkey',
    expectSignerAgentId: options.expectSignerAgentId || 'agent-launch-intel',
    allowHttp: options.allowHttp,
    expectedService: options.expectedService,
    expectedCommand: options.expectedCommand,
    expectedEndpoint: options.expectedEndpoint,
    expectedRecipient: options.expectedRecipient,
    expectedCurrency: options.expectedCurrency,
    expectedChainId: options.expectedChainId,
    expectedAmountBaseUnits: options.expectedAmountBaseUnits,
  });

  const outboundPreview = await deps.runPublicOutboundLivePayment({
    baseUrl: agentUrl,
    adminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    idempotencyKey: outboundIdempotencyKey,
    previewOnly: true,
    allowHttp: options.allowHttp,
    expectedService: options.expectedService || 'mpp.browserbase.com',
    expectedCommand: options.expectedCommand || 'fetch_browserbase_page',
    expectedEndpoint: options.expectedEndpoint,
    expectedRecipient: options.expectedRecipient,
    expectedCurrency: options.expectedCurrency,
    expectedChainId: options.expectedChainId,
    expectedAmountBaseUnits: options.expectedAmountBaseUnits || '1000',
  });

  const outboundExecution = options.confirmLiveOutboundPayment
    ? await deps.runPublicOutboundLivePayment({
      baseUrl: agentUrl,
      adminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      idempotencyKey: outboundIdempotencyKey,
      confirmLivePayment: true,
      verifySignerLedger: options.verifySignerLedger === true,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService || 'mpp.browserbase.com',
      expectedCommand: options.expectedCommand || 'fetch_browserbase_page',
      expectedEndpoint: options.expectedEndpoint,
      expectedRecipient: options.expectedRecipient,
      expectedCurrency: options.expectedCurrency,
      expectedChainId: options.expectedChainId,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits || '1000',
    })
    : null;

  const shouldCheckCronArming = options.checkCronArming === true || Boolean(outboundExecution);
  const cronArmingReadiness = shouldCheckCronArming
    ? await deps.runPublicCronArmingReadiness({
      agentUrl,
      signerUrl,
      agentAdminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      idempotencyKey: outboundIdempotencyKey,
      expectCronAuthGated: options.expectCronAuthGated === true,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService || 'mpp.browserbase.com',
      expectedCommand: options.expectedCommand || 'fetch_browserbase_page',
      expectedEndpoint: options.expectedEndpoint,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits || '1000',
    })
    : null;

  const hasInboundEvidence = Boolean(options.inboundIdempotencyKey || options.inboundReportId || options.inboundReceiptId);
  const completionVerifier = hasInboundEvidence && (options.verifyCompletion === true || Boolean(outboundExecution))
    ? await deps.runPublicAutonomousCompletionVerifier({
      agentUrl,
      signerUrl,
      agentAdminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      inboundIdempotencyKey: options.inboundIdempotencyKey,
      inboundReportId: options.inboundReportId,
      inboundReceiptId: options.inboundReceiptId,
      manualOutboundIdempotencyKey: outboundIdempotencyKey,
      expectCronAuthGated: options.expectCronAuthGated === true,
      expectCronReadyToEnable: options.expectCronReadyToEnable === true,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService || 'mpp.browserbase.com',
      expectedCommand: options.expectedCommand || 'fetch_browserbase_page',
      expectedEndpoint: options.expectedEndpoint,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits || '1000',
    })
    : null;

  const cronLiveRun = options.confirmLiveCronRun
    ? await deps.runPublicOutboundCronLiveRun({
      baseUrl: agentUrl,
      agentAdminToken: options.agentAdminToken,
      cronSecret: options.cronSecret,
      signerAdminToken: options.signerAdminToken,
      expectedIdempotencyKey: options.expectedCronIdempotencyKey,
      confirmLiveCronRun: true,
      verifySignerLedger: options.verifySignerLedger === true,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService || 'mpp.browserbase.com',
      expectedEndpoint: options.expectedEndpoint,
      expectedRecipient: options.expectedRecipient,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits || '1000',
    })
    : null;

  assertNoSecretLeak('public live launch orchestrator composed results', JSON.stringify({
    goLiveReadiness,
    outboundPreview,
    outboundExecution,
    cronArmingReadiness,
    completionVerifier,
    cronLiveRun,
  }), secretValues);

  const summary = {
    ok: true,
    read_only: !liveActionFlags.outbound_payment && !liveActionFlags.authorized_cron_run,
    live_actions: liveActionFlags.outbound_payment || liveActionFlags.authorized_cron_run,
    live_action_flags: liveActionFlags,
    agent_url: agentUrl,
    signer_url: signerUrl,
    idempotency: {
      inbound: options.inboundIdempotencyKey || null,
      outbound_manual: outboundIdempotencyKey,
      cron_expected: options.expectedCronIdempotencyKey || null,
    },
    checks: {
      go_live_readiness: summarizeGoLive(goLiveReadiness),
      outbound_preview: summarizeOutboundPreview(outboundPreview),
      outbound_execution: outboundExecution ? summarizeOutboundExecution(outboundExecution) : null,
      cron_arming_readiness: cronArmingReadiness ? summarizeCronArming(cronArmingReadiness) : null,
      completion_verifier: completionVerifier ? summarizeCompletion(completionVerifier) : null,
      authorized_cron_run: cronLiveRun ? summarizeCronRun(cronLiveRun) : null,
    },
    inbound_payment_command: buildInboundPaymentCommand({
      agentUrl,
      amountUsd: options.inboundAmountUsd || DEFAULT_INBOUND_AMOUNT_USD,
      payerAccessEnv: options.payerAccessEnv || '.secrets/test-payer-access-key.env',
    }),
    next_manual_boundary: buildNextManualBoundary({
      outboundExecution,
      cronArmingReadiness,
      completionVerifier,
      cronLiveRun,
      hasInboundEvidence,
      liveActionFlags,
    }),
    note: 'Guarded public live launch orchestrator. By default it is read-only. It executes outbound payment only with --confirm-live-outbound-payment and executes authorized cron only with --confirm-live-cron-run.',
  };

  assertNoSecretLeak('public live launch orchestrator summary', JSON.stringify(summary), secretValues);
  return summary;
}

function summarizeGoLive(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    signer_provider: result.checks?.signer_production_preflight?.provider ?? null,
    signer_ledger_backend: result.checks?.signer_production_preflight?.ledger_backend ?? null,
    autonomous_readiness_ok: result.checks?.autonomous_readiness?.ok ?? null,
    cron_ready_to_enable: result.checks?.autonomous_readiness?.cron_ready_to_enable ?? null,
    cron_ready_to_run_authorized: result.checks?.autonomous_readiness?.cron_ready_to_run_authorized ?? null,
  };
}

function summarizeOutboundPreview(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    amount_base_units: result.preview?.request?.body?.amount_base_units ?? result.preview?.limits?.requested_amount_base_units ?? null,
    endpoint: result.preview?.request?.body?.endpoint ?? null,
    recipient: result.preview?.request?.body?.recipient ?? null,
    blockers: result.preview?.blockers || [],
  };
}

function summarizeOutboundExecution(result) {
  return {
    ok: result.ok,
    idempotency_key: result.idempotency_key,
    service: result.execution?.service,
    endpoint: result.execution?.endpoint,
    amount_base_units: result.execution?.requested_amount_base_units,
    signer_ledger_status: result.signer_ledger?.status ?? null,
  };
}

function summarizeCronArming(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    idempotency_key: result.idempotency_key,
    trigger: result.checks?.manual_outbound_reconciliation?.trigger,
    signer_status: result.checks?.manual_outbound_reconciliation?.signer_status,
    cron_status: result.checks?.cron_safety?.status,
  };
}

function summarizeCompletion(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    inbound_report_id: result.checks?.inbound_payment?.report_id,
    manual_outbound_idempotency_key: result.checks?.manual_outbound_payment?.idempotency_key,
    cron_ready_to_enable: result.checks?.cron_readiness?.ready_to_enable,
    cron_ready_to_run_authorized: result.checks?.cron_readiness?.ready_to_run_authorized,
  };
}

function summarizeCronRun(result) {
  return {
    ok: result.ok,
    idempotency_key: result.idempotency_key,
    trigger: result.execution?.trigger,
    amount_base_units: result.execution?.requested_amount_base_units,
    agent_ledger_type: result.agent_ledger?.type,
    signer_ledger_status: result.signer_ledger?.status ?? null,
  };
}

function buildInboundPaymentCommand({ agentUrl, amountUsd, payerAccessEnv }) {
  return `node scripts\\tempo-mpp-public-inbound-payment.js --base-url ${agentUrl} --amount-usd ${amountUsd} --payer-access-env ${payerAccessEnv}`;
}

function buildNextManualBoundary({ outboundExecution, cronArmingReadiness, completionVerifier, cronLiveRun, hasInboundEvidence, liveActionFlags }) {
  if (!liveActionFlags.outbound_payment) {
    return 'Review go-live readiness and outbound preview. Then run the inbound payment dry-run/confirm flow and approve --confirm-live-outbound-payment separately.';
  }
  if (!hasInboundEvidence) {
    return 'Outbound payment executed. Provide inbound reconciliation evidence before completion verification and cron enablement.';
  }
  if (!cronArmingReadiness) {
    return 'Run cron arming readiness before setting OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY or enabling cron.';
  }
  if (!completionVerifier) {
    return 'Run autonomous completion verifier before enabling cron.';
  }
  if (!liveActionFlags.authorized_cron_run) {
    return 'After enabling cron env and public auth-gated readiness passes, approve --confirm-live-cron-run separately.';
  }
  if (cronLiveRun) {
    return 'Authorized cron run executed and verified. Continue with read-only reconciliation and listing/registration review.';
  }
  return 'Continue with the next guarded public launch step.';
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

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin or cron token.`);
    }
  }
}

function parseArgs(args) {
  const values = {
    agentUrl: process.env.PUBLIC_AGENT_BASE_URL || '',
    signerUrl: process.env.PUBLIC_SIGNER_BASE_URL || '',
    agentAdminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    signerAdminToken: process.env.SIGNER_ADMIN_TOKEN || process.env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
    cronSecret: process.env.CRON_SECRET || '',
    outboundIdempotencyKey: process.env.OUTBOUND_LIVE_IDEMPOTENCY_KEY || DEFAULT_OUTBOUND_IDEMPOTENCY_KEY,
    inboundIdempotencyKey: process.env.INBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    inboundReportId: process.env.INBOUND_RECONCILE_REPORT_ID || '',
    inboundReceiptId: process.env.INBOUND_RECONCILE_RECEIPT_ID || '',
    expectedCronIdempotencyKey: process.env.OUTBOUND_CRON_EXPECTED_IDEMPOTENCY_KEY || '',
    inboundAmountUsd: process.env.PUBLIC_INBOUND_AMOUNT_USD || DEFAULT_INBOUND_AMOUNT_USD,
    payerAccessEnv: process.env.PUBLIC_INBOUND_PAYER_ACCESS_ENV || '.secrets/test-payer-access-key.env',
    confirmLiveOutboundPayment: false,
    confirmLiveCronRun: false,
    checkCronArming: false,
    verifyCompletion: false,
    verifySignerLedger: process.env.VERIFY_SIGNER_LEDGER === 'true',
    expectCronAuthGated: process.env.EXPECT_OUTBOUND_CRON_AUTH_GATED === 'true',
    expectCronReadyToEnable: process.env.EXPECT_OUTBOUND_CRON_READY_TO_ENABLE === 'true',
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || undefined,
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || undefined,
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || undefined,
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || '10000',
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || undefined,
    expectedCurrency: process.env.EXPECTED_OUTBOUND_CURRENCY || undefined,
    expectedChainId: process.env.EXPECTED_OUTBOUND_CHAIN_ID ? Number(process.env.EXPECTED_OUTBOUND_CHAIN_ID) : undefined,
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
    } else if (arg === '--cron-secret-env' && next) {
      values.cronSecret = process.env[next] || '';
      i += 1;
    } else if (arg === '--outbound-idempotency-key' && next) {
      values.outboundIdempotencyKey = next;
      i += 1;
    } else if (arg === '--inbound-idempotency-key' && next) {
      values.inboundIdempotencyKey = next;
      i += 1;
    } else if (arg === '--inbound-report-id' && next) {
      values.inboundReportId = next;
      i += 1;
    } else if (arg === '--inbound-receipt-id' && next) {
      values.inboundReceiptId = next;
      i += 1;
    } else if (arg === '--expected-cron-idempotency-key' && next) {
      values.expectedCronIdempotencyKey = next;
      i += 1;
    } else if (arg === '--payer-access-env' && next) {
      values.payerAccessEnv = next;
      i += 1;
    } else if (arg === '--inbound-amount-usd' && next) {
      values.inboundAmountUsd = next;
      i += 1;
    } else if (arg === '--confirm-live-outbound-payment') {
      values.confirmLiveOutboundPayment = true;
    } else if (arg === '--confirm-live-cron-run') {
      values.confirmLiveCronRun = true;
    } else if (arg === '--check-cron-arming') {
      values.checkCronArming = true;
    } else if (arg === '--verify-completion') {
      values.verifyCompletion = true;
    } else if (arg === '--verify-signer-ledger') {
      values.verifySignerLedger = true;
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
      console.log('Usage: node scripts/public-live-launch-orchestrator.js --agent-url https://agent.example --signer-url https://signer.example [--confirm-live-outbound-payment] [--confirm-live-cron-run]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicLiveLaunchOrchestrator(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
