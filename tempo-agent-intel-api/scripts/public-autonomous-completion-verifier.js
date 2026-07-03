import { fileURLToPath } from 'node:url';
import { runPublicInboundReconcile } from './public-inbound-reconcile.js';
import { runPublicOutboundReconcile } from './public-outbound-reconcile.js';
import { runPublicOutboundCronReadinessSmoke } from './public-outbound-cron-readiness-smoke.js';
import { runPublicOutboundCronSafetySmoke } from './public-outbound-cron-safety-smoke.js';

export async function runPublicAutonomousCompletionVerifier(options) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public autonomous completion verification.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public autonomous completion verification.');
  }
  if (!options.inboundIdempotencyKey && !options.inboundReportId && !options.inboundReceiptId) {
    throw new Error('Provide inbound idempotency, report, or receipt id for completion verification.');
  }
  if (!options.manualOutboundIdempotencyKey) {
    throw new Error('--manual-outbound-idempotency-key is required for completion verification.');
  }
  if (options.expectAuthorizedCronComplete === true && options.expectCronAuthGated !== true) {
    throw new Error('--expect-authorized-cron-complete requires --expect-cron-auth-gated.');
  }
  if (options.expectAuthorizedCronComplete === true && !options.expectedCronIdempotencyKey) {
    throw new Error('--expect-authorized-cron-complete requires --expected-cron-idempotency-key.');
  }

  const secretValues = [options.agentAdminToken, options.signerAdminToken].filter(Boolean);
  const inbound = await runPublicInboundReconcile({
    baseUrl: agentUrl,
    agentAdminToken: options.agentAdminToken,
    idempotencyKey: options.inboundIdempotencyKey,
    reportId: options.inboundReportId,
    receiptId: options.inboundReceiptId,
    eventLimit: options.eventLimit,
    expectedPaymentMode: options.expectedInboundPaymentMode || 'tempo',
    expectedPaymentMethod: options.expectedInboundPaymentMethod || 'tempo_mpp',
    allowHttp: options.allowHttp,
  });

  const manualOutbound = await runPublicOutboundReconcile({
    agentUrl,
    signerUrl,
    agentAdminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    idempotencyKey: options.manualOutboundIdempotencyKey,
    agentId: options.agentId,
    eventLimit: options.eventLimit,
    allowHttp: options.allowHttp,
    expectedService: options.expectedService || 'mpp.browserbase.com',
    expectedCommand: options.expectedCommand || 'fetch_browserbase_page',
    expectedEndpoint: options.expectedEndpoint || 'https://mpp.browserbase.com/fetch',
    expectedAmountBaseUnits: options.expectedAmountBaseUnits || '10000',
    expectedEventType: 'outbound_admin_payment_succeeded',
    expectedTrigger: 'admin_manual',
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

  if (options.expectCronAuthGated === true && cronReadiness.ready_to_run_authorized !== true) {
    throw new Error('Completion verification expected cron ready_to_run_authorized=true.');
  }
  if (options.expectCronReadyToEnable === true && cronReadiness.ready_to_enable !== true) {
    throw new Error('Completion verification expected cron ready_to_enable=true.');
  }

  const authorizedCron = options.expectAuthorizedCronComplete === true
    ? await runPublicOutboundReconcile({
      agentUrl,
      signerUrl,
      agentAdminToken: options.agentAdminToken,
      signerAdminToken: options.signerAdminToken,
      idempotencyKey: options.expectedCronIdempotencyKey,
      agentId: options.agentId,
      eventLimit: options.eventLimit,
      allowHttp: options.allowHttp,
      expectedService: options.expectedService || 'mpp.browserbase.com',
      expectedCommand: options.expectedCommand || 'fetch_browserbase_page',
      expectedEndpoint: options.expectedEndpoint || 'https://mpp.browserbase.com/fetch',
      expectedAmountBaseUnits: options.expectedAmountBaseUnits || '10000',
      expectedEventType: 'outbound_cron_payment_succeeded',
      expectedTrigger: 'vercel_cron',
    })
    : null;

  const summary = {
    ok: true,
    read_only: true,
    agent_url: agentUrl,
    signer_url: signerUrl,
    checks: {
      inbound_payment: {
        ok: inbound.ok,
        report_id: inbound.match.report_id,
        receipt_id: inbound.match.receipt_id,
        payment_mode: inbound.match.payment_mode,
        payment_method: inbound.match.payment_method,
        payment_status: inbound.match.payment_status,
      },
      manual_outbound_payment: {
        ok: manualOutbound.ok,
        idempotency_key: manualOutbound.idempotency_key,
        agent_event_type: manualOutbound.agent.event_type,
        trigger: manualOutbound.agent.trigger,
        signer_status: manualOutbound.signer.status,
        service: manualOutbound.agent.service,
        endpoint: manualOutbound.agent.endpoint,
        amount_base_units: manualOutbound.agent.amount_base_units,
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
        next_idempotency_key: cronReadiness.next_idempotency_key,
      },
      authorized_cron_payment: authorizedCron
        ? {
          ok: authorizedCron.ok,
          idempotency_key: authorizedCron.idempotency_key,
          agent_event_type: authorizedCron.agent.event_type,
          trigger: authorizedCron.agent.trigger,
          signer_status: authorizedCron.signer.status,
          service: authorizedCron.agent.service,
          endpoint: authorizedCron.agent.endpoint,
          amount_base_units: authorizedCron.agent.amount_base_units,
        }
        : null,
    },
    remaining_manual_boundary: options.expectCronAuthGated
      ? options.expectAuthorizedCronComplete
        ? 'Autonomous payment evidence is complete. Run listing readiness and submit directories manually only after owner review.'
        : 'Only the manually approved first authorized cron run remains if it has not already been executed and reconciled.'
      : 'Enable cron only after manual approval, then repeat this verifier with --expect-cron-auth-gated.',
    note: 'Read-only autonomous completion verifier. No report POST, payment, signing, signer MPP fetch, cron bearer, authorized cron route, or downstream MPP route was called.',
  };

  assertNoSecretLeak('autonomous completion verifier summary', JSON.stringify(summary), secretValues);
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
    inboundIdempotencyKey: process.env.INBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    inboundReportId: process.env.INBOUND_RECONCILE_REPORT_ID || '',
    inboundReceiptId: process.env.INBOUND_RECONCILE_RECEIPT_ID || '',
    manualOutboundIdempotencyKey: process.env.OUTBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    agentId: process.env.OUTBOUND_SIGNER_AGENT_ID || 'agent-launch-intel',
    eventLimit: Number(process.env.AUTONOMOUS_COMPLETION_EVENT_LIMIT || 100),
    expectCronAuthGated: process.env.EXPECT_OUTBOUND_CRON_AUTH_GATED === 'true',
    expectCronReadyToEnable: process.env.EXPECT_OUTBOUND_CRON_READY_TO_ENABLE === 'true',
    expectAuthorizedCronComplete: process.env.EXPECT_AUTHORIZED_CRON_COMPLETE === 'true',
    expectedCronIdempotencyKey: process.env.OUTBOUND_CRON_EXPECTED_IDEMPOTENCY_KEY || '',
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || 'fetch_browserbase_page',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || 'https://mpp.browserbase.com/fetch',
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || '10000',
    expectedInboundPaymentMode: process.env.EXPECTED_INBOUND_PAYMENT_MODE || 'tempo',
    expectedInboundPaymentMethod: process.env.EXPECTED_INBOUND_PAYMENT_METHOD || 'tempo_mpp',
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
    } else if (arg === '--inbound-idempotency-key' && next) {
      values.inboundIdempotencyKey = next;
      i += 1;
    } else if (arg === '--inbound-report-id' && next) {
      values.inboundReportId = next;
      i += 1;
    } else if (arg === '--inbound-receipt-id' && next) {
      values.inboundReceiptId = next;
      i += 1;
    } else if (arg === '--manual-outbound-idempotency-key' && next) {
      values.manualOutboundIdempotencyKey = next;
      i += 1;
    } else if (arg === '--expect-cron-auth-gated') {
      values.expectCronAuthGated = true;
      values.expectCronReadyToEnable = false;
    } else if (arg === '--expect-cron-ready-to-enable') {
      values.expectCronReadyToEnable = true;
      values.expectCronAuthGated = false;
    } else if (arg === '--expect-cron-disabled') {
      values.expectCronReadyToEnable = false;
      values.expectCronAuthGated = false;
    } else if (arg === '--expect-authorized-cron-complete') {
      values.expectAuthorizedCronComplete = true;
    } else if (arg === '--expected-cron-idempotency-key' && next) {
      values.expectedCronIdempotencyKey = next;
      i += 1;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-autonomous-completion-verifier.js --agent-url https://agent.example --signer-url https://signer.example --inbound-idempotency-key ... --manual-outbound-idempotency-key ... [--expect-cron-ready-to-enable|--expect-cron-auth-gated] [--expect-authorized-cron-complete --expected-cron-idempotency-key cron-browserbase-fetch-YYYY-MM-DD]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicAutonomousCompletionVerifier(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
