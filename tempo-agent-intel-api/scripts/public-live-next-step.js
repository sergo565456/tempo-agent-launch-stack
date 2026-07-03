import { fileURLToPath } from 'node:url';
import { runPublicAutonomousCompletionVerifier } from './public-autonomous-completion-verifier.js';
import { runPublicCronArmingReadiness } from './public-cron-arming-readiness.js';
import { runPublicInboundReconcile } from './public-inbound-reconcile.js';
import { runPublicLiveLaunchOrchestrator } from './public-live-launch-orchestrator.js';
import { runPublicOutboundReconcile } from './public-outbound-reconcile.js';

const DEFAULT_OUTBOUND_IDEMPOTENCY_KEY = 'first-live-browserbase-001';
const DEFAULT_INBOUND_AMOUNT_USD = '0.01';
const DEFAULT_CRON_IDEMPOTENCY = 'cron-browserbase-fetch-YYYY-MM-DD';

const defaultDeps = {
  runPublicLiveLaunchOrchestrator,
  runPublicInboundReconcile,
  runPublicOutboundReconcile,
  runPublicCronArmingReadiness,
  runPublicAutonomousCompletionVerifier,
};

export async function runPublicLiveNextStep(options, deps = defaultDeps) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public live next-step planning.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public live next-step planning.');
  }

  const outboundIdempotencyKey = options.outboundIdempotencyKey || DEFAULT_OUTBOUND_IDEMPOTENCY_KEY;
  const inboundEvidence = pickInboundEvidence(options);
  const hasInboundEvidence = Object.values(inboundEvidence).some(Boolean);
  const expectManualOutboundComplete = options.expectManualOutboundComplete === true;
  const expectCronAuthGated = options.expectCronAuthGated === true;
  const expectAuthorizedCronComplete = options.expectAuthorizedCronComplete === true;
  const expectedCronIdempotencyKey = options.expectedCronIdempotencyKey || DEFAULT_CRON_IDEMPOTENCY;
  const secretValues = [
    options.agentAdminToken,
    options.signerAdminToken,
    options.cronSecret,
  ].filter(Boolean);

  if (expectManualOutboundComplete && !hasInboundEvidence) {
    throw new Error('Inbound evidence is required before expecting manual outbound completion.');
  }
  if (expectAuthorizedCronComplete && !expectCronAuthGated) {
    throw new Error('--expect-authorized-cron-complete requires --expect-cron-auth-gated.');
  }
  if (expectAuthorizedCronComplete && expectedCronIdempotencyKey === DEFAULT_CRON_IDEMPOTENCY) {
    throw new Error('--expect-authorized-cron-complete requires --expected-cron-idempotency-key.');
  }

  const launchReadiness = await deps.runPublicLiveLaunchOrchestrator({
    agentUrl,
    signerUrl,
    agentAdminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    outboundIdempotencyKey,
    inboundAmountUsd: options.inboundAmountUsd || DEFAULT_INBOUND_AMOUNT_USD,
    payerAccessEnv: options.payerAccessEnv || '.secrets/test-payer-access-key.env',
    expectCronAuthGated,
    expectCronReadyToEnable: expectManualOutboundComplete && !expectCronAuthGated,
    allowHttp: options.allowHttp,
    expectedService: options.expectedService,
    expectedCommand: options.expectedCommand,
    expectedEndpoint: options.expectedEndpoint,
    expectedRecipient: options.expectedRecipient,
    expectedCurrency: options.expectedCurrency,
    expectedChainId: options.expectedChainId,
    expectedAmountBaseUnits: options.expectedAmountBaseUnits,
  });

  const inboundReconciliation = hasInboundEvidence
    ? await deps.runPublicInboundReconcile({
      agentUrl,
      baseUrl: agentUrl,
      agentAdminToken: options.agentAdminToken,
      ...inboundEvidence,
      allowHttp: options.allowHttp,
    })
    : null;

  const manualOutboundReconciliation = expectManualOutboundComplete
    ? await deps.runPublicOutboundReconcile({
      agentUrl,
      signerUrl,
      agentAdminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      idempotencyKey: outboundIdempotencyKey,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService,
      expectedCommand: options.expectedCommand,
      expectedEndpoint: options.expectedEndpoint,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits,
    })
    : null;

  const cronArmingReadiness = expectManualOutboundComplete
    ? await deps.runPublicCronArmingReadiness({
      agentUrl,
      signerUrl,
      agentAdminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      idempotencyKey: outboundIdempotencyKey,
      expectCronAuthGated,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService,
      expectedCommand: options.expectedCommand,
      expectedEndpoint: options.expectedEndpoint,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits,
    })
    : null;

  const completionVerifier = expectManualOutboundComplete
    ? await deps.runPublicAutonomousCompletionVerifier({
      agentUrl,
      signerUrl,
      agentAdminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      inboundIdempotencyKey: inboundEvidence.idempotencyKey,
      inboundReportId: inboundEvidence.reportId,
      inboundReceiptId: inboundEvidence.receiptId,
      manualOutboundIdempotencyKey: outboundIdempotencyKey,
      expectCronAuthGated,
      expectCronReadyToEnable: !expectCronAuthGated,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService,
      expectedCommand: options.expectedCommand,
      expectedEndpoint: options.expectedEndpoint,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits,
    })
    : null;

  const authorizedCronReconciliation = expectAuthorizedCronComplete
    ? await deps.runPublicOutboundReconcile({
      agentUrl,
      signerUrl,
      agentAdminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      idempotencyKey: expectedCronIdempotencyKey,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService,
      expectedCommand: options.expectedCommand,
      expectedEndpoint: options.expectedEndpoint,
      expectedAmountBaseUnits: options.expectedAmountBaseUnits,
    })
    : null;

  const stage = determineStage({
    hasInboundEvidence,
    expectManualOutboundComplete,
    expectCronAuthGated,
    expectAuthorizedCronComplete,
  });
  const summary = {
    ok: true,
    read_only: true,
    stage,
    agent_url: agentUrl,
    signer_url: signerUrl,
    expected_cron_mode: expectCronAuthGated
      ? 'auth_gated'
      : expectManualOutboundComplete
        ? 'ready_to_enable'
        : 'disabled',
    idempotency: {
      inbound: inboundEvidence.idempotencyKey || null,
      outbound_manual: outboundIdempotencyKey,
      cron_expected: expectCronAuthGated ? expectedCronIdempotencyKey : null,
    },
    checks: {
      launch_readiness: summarizeLaunch(launchReadiness),
      inbound_reconciliation: inboundReconciliation ? summarizeInbound(inboundReconciliation) : null,
      manual_outbound_reconciliation: manualOutboundReconciliation ? summarizeOutbound(manualOutboundReconciliation) : null,
      cron_arming_readiness: cronArmingReadiness ? summarizeCronArming(cronArmingReadiness) : null,
      completion_verifier: completionVerifier ? summarizeCompletion(completionVerifier) : null,
      authorized_cron_reconciliation: authorizedCronReconciliation ? summarizeOutbound(authorizedCronReconciliation) : null,
    },
    next_actions: buildNextActions({
      stage,
      agentUrl,
      signerUrl,
      outboundIdempotencyKey,
      inboundEvidence,
      inboundAmountUsd: options.inboundAmountUsd || DEFAULT_INBOUND_AMOUNT_USD,
      payerAccessEnv: options.payerAccessEnv || '.secrets/test-payer-access-key.env',
      expectedCronIdempotencyKey,
    }),
    required_local_env: buildRequiredEnv(stage),
    note: 'Read-only public live next-step planner. It composes existing read-only gates and never sends payment confirmation, signer fetch, env upload, deploy, cron bearer, or authorized cron itself.',
  };

  assertNoSecretLeak('public live next-step planner composed results', JSON.stringify({
    launchReadiness,
    inboundReconciliation,
    manualOutboundReconciliation,
    cronArmingReadiness,
    completionVerifier,
    authorizedCronReconciliation,
  }), secretValues);
  assertNoSecretLeak('public live next-step planner summary', JSON.stringify(summary), secretValues);
  return summary;
}

function pickInboundEvidence(options) {
  return {
    idempotencyKey: options.inboundIdempotencyKey || '',
    reportId: options.inboundReportId || '',
    receiptId: options.inboundReceiptId || '',
  };
}

function determineStage({ hasInboundEvidence, expectManualOutboundComplete, expectCronAuthGated, expectAuthorizedCronComplete }) {
  if (!hasInboundEvidence) {
    return 'awaiting_inbound_payment';
  }
  if (!expectManualOutboundComplete) {
    return 'awaiting_manual_outbound_payment';
  }
  if (!expectCronAuthGated) {
    return 'awaiting_cron_enablement';
  }
  if (!expectAuthorizedCronComplete) {
    return 'awaiting_authorized_cron_verification';
  }
  return 'ready_for_listing_review';
}

function buildNextActions({ stage, agentUrl, signerUrl, outboundIdempotencyKey, inboundEvidence, inboundAmountUsd, payerAccessEnv, expectedCronIdempotencyKey }) {
  const baseLaunch = `npm run launch:public-live -- --agent-url ${agentUrl} --signer-url ${signerUrl}`;
  if (stage === 'awaiting_inbound_payment') {
    return [
      {
        name: 'dry_run_public_inbound_payment',
        live_action: false,
        requires_manual_approval: false,
        command: `npm run tempo:public-live-inbound-payment -- --base-url ${agentUrl} --amount-usd ${inboundAmountUsd} --payer-access-env ${payerAccessEnv}`,
      },
      {
        name: 'confirm_public_inbound_payment',
        live_action: true,
        requires_manual_approval: true,
        command: `npm run tempo:public-live-inbound-payment -- --base-url ${agentUrl} --amount-usd ${inboundAmountUsd} --payer-access-env ${payerAccessEnv} --confirm-live-payment`,
      },
    ];
  }
  if (stage === 'awaiting_manual_outbound_payment') {
    return [
      {
        name: 'reconcile_public_inbound_payment',
        live_action: false,
        requires_manual_approval: false,
        command: buildInboundReconcileCommand(agentUrl, inboundEvidence),
      },
      {
        name: 'confirm_first_manual_outbound_payment',
        live_action: true,
        requires_manual_approval: true,
        command: `${baseLaunch} --outbound-idempotency-key ${outboundIdempotencyKey} --confirm-live-outbound-payment --verify-signer-ledger`,
      },
    ];
  }
  if (stage === 'awaiting_cron_enablement') {
    return [
      {
        name: 'set_public_agent_cron_env',
        live_action: false,
        requires_manual_approval: true,
        command: `Set ENABLE_OUTBOUND_CRON=true, OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY=${outboundIdempotencyKey}, OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT=true, and a strong CRON_SECRET in the public agent env; then redeploy.`,
      },
      {
        name: 'verify_auth_gated_cron_state',
        live_action: false,
        requires_manual_approval: false,
        command: `${baseLaunch} --expect-cron-auth-gated --check-cron-arming --verify-completion ${buildInboundEvidenceArgs(inboundEvidence)}`,
      },
    ];
  }
  if (stage === 'awaiting_authorized_cron_verification') {
    return [
      {
        name: 'confirm_one_authorized_cron_payment',
        live_action: true,
        requires_manual_approval: true,
        command: `${baseLaunch} --expect-cron-auth-gated --expected-cron-idempotency-key ${expectedCronIdempotencyKey} --confirm-live-cron-run --verify-signer-ledger`,
      },
    ];
  }
  return [
    {
      name: 'prepare_public_listing_review',
      live_action: false,
      requires_manual_approval: true,
      command: 'Review docs/PUBLIC_LISTING_PROFILE.md and submit the MPP directory/listing only after owner approval.',
    },
  ];
}

function buildRequiredEnv(stage) {
  const required = ['OUTBOUND_ADMIN_TOKEN', 'SIGNER_ADMIN_TOKEN'];
  if (stage === 'awaiting_authorized_cron_verification') {
    required.push('CRON_SECRET');
  }
  return required;
}

function buildInboundReconcileCommand(agentUrl, inboundEvidence) {
  return `npm run reconcile:public-inbound -- --agent-url ${agentUrl} ${buildInboundEvidenceArgs(inboundEvidence)}`.trim();
}

function buildInboundEvidenceArgs(inboundEvidence) {
  const args = [];
  if (inboundEvidence.idempotencyKey) {
    args.push(`--idempotency-key ${inboundEvidence.idempotencyKey}`);
  }
  if (inboundEvidence.reportId) {
    args.push(`--report-id ${inboundEvidence.reportId}`);
  }
  if (inboundEvidence.receiptId) {
    args.push(`--receipt-id ${inboundEvidence.receiptId}`);
  }
  return args.join(' ');
}

function summarizeLaunch(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    signer_provider: result.checks?.go_live_readiness?.signer_provider ?? null,
    outbound_preview_amount_base_units: result.checks?.outbound_preview?.amount_base_units ?? null,
  };
}

function summarizeInbound(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    idempotency_key: result.match?.idempotency_key ?? null,
    report_id: result.match?.report_id ?? null,
    receipt_id: result.match?.receipt_id ?? null,
  };
}

function summarizeOutbound(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    idempotency_key: result.idempotency_key,
    event_type: result.agent?.event_type,
    trigger: result.agent?.trigger,
    signer_status: result.signer?.status,
    amount_base_units: result.agent?.amount_base_units,
  };
}

function summarizeCronArming(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    idempotency_key: result.idempotency_key,
    arming_event_type: result.arming_event?.type ?? null,
    cron_status: result.cron_safety?.status ?? null,
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
    inboundIdempotencyKey: process.env.INBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    inboundReportId: process.env.INBOUND_RECONCILE_REPORT_ID || '',
    inboundReceiptId: process.env.INBOUND_RECONCILE_RECEIPT_ID || '',
    outboundIdempotencyKey: process.env.OUTBOUND_LIVE_IDEMPOTENCY_KEY || DEFAULT_OUTBOUND_IDEMPOTENCY_KEY,
    expectedCronIdempotencyKey: process.env.OUTBOUND_CRON_EXPECTED_IDEMPOTENCY_KEY || '',
    inboundAmountUsd: process.env.PUBLIC_INBOUND_AMOUNT_USD || DEFAULT_INBOUND_AMOUNT_USD,
    payerAccessEnv: process.env.PUBLIC_INBOUND_PAYER_ACCESS_ENV || '.secrets/test-payer-access-key.env',
    expectManualOutboundComplete: false,
    expectCronAuthGated: false,
    expectAuthorizedCronComplete: false,
    allowHttp: false,
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || 'fetch_browserbase_page',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || undefined,
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || undefined,
    expectedCurrency: process.env.EXPECTED_OUTBOUND_CURRENCY || undefined,
    expectedChainId: process.env.EXPECTED_OUTBOUND_CHAIN_ID ? Number(process.env.EXPECTED_OUTBOUND_CHAIN_ID) : undefined,
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || '10000',
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
    } else if (arg === '--inbound-idempotency-key' && next) {
      values.inboundIdempotencyKey = next;
      i += 1;
    } else if (arg === '--inbound-report-id' && next) {
      values.inboundReportId = next;
      i += 1;
    } else if (arg === '--inbound-receipt-id' && next) {
      values.inboundReceiptId = next;
      i += 1;
    } else if (arg === '--outbound-idempotency-key' && next) {
      values.outboundIdempotencyKey = next;
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
    } else if (arg === '--expect-manual-outbound-complete') {
      values.expectManualOutboundComplete = true;
    } else if (arg === '--expect-cron-auth-gated') {
      values.expectCronAuthGated = true;
    } else if (arg === '--expect-authorized-cron-complete') {
      values.expectAuthorizedCronComplete = true;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-live-next-step.js --agent-url https://agent.example --signer-url https://signer.example [--inbound-idempotency-key ...] [--expect-manual-outbound-complete] [--expect-cron-auth-gated]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicLiveNextStep(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
