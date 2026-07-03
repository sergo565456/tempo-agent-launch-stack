import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicAutonomousCompletionVerifier } from '../scripts/public-autonomous-completion-verifier.js';

describe('public autonomous completion verifier', () => {
  it('verifies inbound, outbound, and cron readiness without live routes', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler());

    try {
      const summary = await runPublicAutonomousCompletionVerifier({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        inboundIdempotencyKey: 'public-live-tempo-inbound-001',
        manualOutboundIdempotencyKey: 'first-live-browserbase-001',
        expectCronReadyToEnable: true,
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.checks.inbound_payment.payment_status, 'paid');
      assert.equal(summary.checks.manual_outbound_payment.signer_status, 'approved');
      assert.equal(summary.checks.cron_safety.expected_mode, 'disabled');
      assert.equal(summary.checks.cron_readiness.ready_to_enable, true);
      assert.equal(summary.checks.cron_readiness.ready_to_run_authorized, false);
      assert.equal(summary.checks.authorized_cron_payment, null);
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(agent.calls.some((call) => call.url === '/api/cron/outbound/browserbase-fetch' && call.authorization), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('verifies authorized cron completion without executing the cron route', async () => {
    const signer = await startServer(createSignerHandler({ includeCronLedger: true }));
    const agent = await startServer(createAgentHandler({ cronAuthGated: true, includeCronEvent: true }));

    try {
      const summary = await runPublicAutonomousCompletionVerifier({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        inboundIdempotencyKey: 'public-live-tempo-inbound-001',
        manualOutboundIdempotencyKey: 'first-live-browserbase-001',
        expectCronAuthGated: true,
        expectAuthorizedCronComplete: true,
        expectedCronIdempotencyKey: 'cron-browserbase-fetch-2026-06-07',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.checks.cron_safety.expected_mode, 'auth_gated');
      assert.equal(summary.checks.cron_readiness.ready_to_run_authorized, true);
      assert.equal(summary.checks.authorized_cron_payment.idempotency_key, 'cron-browserbase-fetch-2026-06-07');
      assert.equal(summary.checks.authorized_cron_payment.agent_event_type, 'outbound_cron_payment_succeeded');
      assert.equal(summary.checks.authorized_cron_payment.trigger, 'vercel_cron');
      assert.equal(summary.checks.authorized_cron_payment.signer_status, 'approved');
      assert.match(summary.remaining_manual_boundary, /evidence is complete/);
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(agent.calls.some((call) => call.url === '/api/cron/outbound/browserbase-fetch' && call.authorization), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects missing inbound evidence', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ omitInboundEvent: true }));

    try {
      await assert.rejects(
        () => runPublicAutonomousCompletionVerifier({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          inboundIdempotencyKey: 'public-live-tempo-inbound-001',
          manualOutboundIdempotencyKey: 'first-live-browserbase-001',
          expectCronReadyToEnable: true,
          allowHttp: true,
        }),
        /No matching inbound payment_verified event/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects admin token leaks from composed checks', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ leakAgentToken: true }));

    try {
      await assert.rejects(
        () => runPublicAutonomousCompletionVerifier({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          inboundIdempotencyKey: 'public-live-tempo-inbound-001',
          manualOutboundIdempotencyKey: 'first-live-browserbase-001',
          expectCronReadyToEnable: true,
          allowHttp: true,
        }),
        /agent payment-events lookup leaked an admin token/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects unsafe cron completion expectations', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ cronReadyToEnable: false }));

    try {
      await assert.rejects(
        () => runPublicAutonomousCompletionVerifier({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          inboundIdempotencyKey: 'public-live-tempo-inbound-001',
          manualOutboundIdempotencyKey: 'first-live-browserbase-001',
          expectCronReadyToEnable: true,
          allowHttp: true,
        }),
        /Expected cron readiness ready_to_enable=true/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }

    await assert.rejects(
      () => runPublicAutonomousCompletionVerifier({
        agentUrl: 'http://agent.local',
        signerUrl: 'http://signer.local',
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        inboundIdempotencyKey: 'public-live-tempo-inbound-001',
        manualOutboundIdempotencyKey: 'first-live-browserbase-001',
        expectAuthorizedCronComplete: true,
        expectedCronIdempotencyKey: 'cron-browserbase-fetch-2026-06-07',
        allowHttp: true,
      }),
      /requires --expect-cron-auth-gated/,
    );

    await assert.rejects(
      () => runPublicAutonomousCompletionVerifier({
        agentUrl: 'http://agent.local',
        signerUrl: 'http://signer.local',
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        inboundIdempotencyKey: 'public-live-tempo-inbound-001',
        manualOutboundIdempotencyKey: 'first-live-browserbase-001',
        expectCronAuthGated: true,
        expectAuthorizedCronComplete: true,
        allowHttp: true,
      }),
      /requires --expected-cron-idempotency-key/,
    );
  });

  it('rejects manual outbound events masquerading as authorized cron proof', async () => {
    const signer = await startServer(createSignerHandler({ includeCronLedger: true }));
    const agent = await startServer(createAgentHandler({
      cronAuthGated: true,
      includeCronEvent: true,
      cronEventType: 'outbound_admin_payment_succeeded',
      cronTrigger: 'admin_manual',
    }));

    try {
      await assert.rejects(
        () => runPublicAutonomousCompletionVerifier({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          inboundIdempotencyKey: 'public-live-tempo-inbound-001',
          manualOutboundIdempotencyKey: 'first-live-browserbase-001',
          expectCronAuthGated: true,
          expectAuthorizedCronComplete: true,
          expectedCronIdempotencyKey: 'cron-browserbase-fetch-2026-06-07',
          allowHttp: true,
        }),
        /Agent event type expected outbound_cron_payment_succeeded/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });
});

function createAgentHandler(options = {}) {
  const inboundEvent = {
    event_id: 'payevt_public_inbound_001',
    type: 'payment_verified',
    idempotency_key: 'public-live-tempo-inbound-001',
    report_id: 'rpt_public_inbound_001',
    report_type: 'wallet_intel_report',
    payment_mode: 'tempo',
    payment_method: 'tempo_mpp',
    payment_status: 'paid',
    receipt_id: 'receipt_public_inbound_001',
  };
  const outboundEvent = {
    event_id: 'payevt_manual_outbound_001',
    type: 'outbound_admin_payment_succeeded',
    trigger: 'admin_manual',
    idempotency_key: 'first-live-browserbase-001',
    payment_provider: 'remote_signer',
    signer_agent_id: 'agent-launch-intel',
    signer_command: 'fetch_browserbase_page',
    service: 'mpp.browserbase.com',
    endpoint: 'https://mpp.browserbase.com/fetch',
    amount_base_units: '10000',
    receipt_reference: 'tx_fake_manual_outbound',
  };
  const cronEvent = {
    event_id: 'payevt_cron_outbound_001',
    type: options.cronEventType || 'outbound_cron_payment_succeeded',
    trigger: options.cronTrigger || 'vercel_cron',
    idempotency_key: 'cron-browserbase-fetch-2026-06-07',
    payment_provider: 'remote_signer',
    signer_agent_id: 'agent-launch-intel',
    signer_command: 'fetch_browserbase_page',
    service: 'mpp.browserbase.com',
    endpoint: 'https://mpp.browserbase.com/fetch',
    amount_base_units: '10000',
    receipt_reference: 'tx_fake_cron_outbound',
  };
  const events = [
    ...(options.omitInboundEvent ? [] : [inboundEvent]),
    outboundEvent,
    ...(options.includeCronEvent ? [cronEvent] : []),
  ];

  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });

    if (req.method === 'GET' && req.url.startsWith('/v1/admin/payment-events')) {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      return sendJson(res, 200, {
        ok: true,
        read_only: true,
        total_events: events.length,
        events,
        ...(options.leakAgentToken ? { leaked: 'agent-admin-token' } : {}),
      });
    }

    if (req.method === 'GET' && req.url === '/v1/reports/rpt_public_inbound_001') {
      return sendJson(res, 200, {
        report: {
          report_id: 'rpt_public_inbound_001',
          report_type: 'wallet_intel_report',
        },
        metadata: {
          payment_mode: 'tempo',
          payment_method: 'tempo_mpp',
          payment_status: 'paid',
          receipt_id: 'receipt_public_inbound_001',
        },
      });
    }

    if (req.method === 'GET' && req.url === '/api/cron/outbound/browserbase-fetch') {
      if (options.cronAuthGated) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      return sendJson(res, 503, { error: 'outbound_cron_disabled' });
    }

    if (req.method === 'GET' && req.url === '/v1/admin/outbound/cron/readiness') {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      const readyToEnable = options.cronAuthGated ? false : options.cronReadyToEnable !== false;
      return sendJson(res, 200, {
        ok: options.cronAuthGated === true,
        read_only: true,
        ready_to_enable: readyToEnable,
        ready_to_run_authorized: options.cronAuthGated === true,
        cron: {
          enabled: options.cronAuthGated === true,
          secret_configured: true,
          strong_secret_configured: true,
          idempotency_prefix: 'cron-browserbase-fetch',
          next_idempotency_key: 'cron-browserbase-fetch-2026-06-07',
        },
        arming: {
          found: readyToEnable || options.cronAuthGated === true,
          expected_idempotency_key: 'first-live-browserbase-001',
        },
        blockers: options.cronAuthGated
          ? []
          : readyToEnable ? ['ENABLE_OUTBOUND_CRON is false; authorized cron route cannot run yet.'] : ['not armed'],
        warnings: [],
        note: 'Read-only readiness only. No cron bearer token, signer request, payment, or downstream MPP fetch was executed.',
      });
    }

    return sendJson(res, 404, { error: 'not_found' });
  };
}

function createSignerHandler(options = {}) {
  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });

    if (req.method === 'GET' && req.url === '/v1/agents/agent-launch-intel/ledger/first-live-browserbase-001') {
      if (req.headers.authorization !== 'Bearer signer-admin-token') {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      return sendJson(res, 200, {
        record: {
          status: 'approved',
          agent_id: 'agent-launch-intel',
          idempotency_key: 'first-live-browserbase-001',
          amount_base_units: '10000',
          response: {
            approval: {
              operation: 'mpp_fetch',
              command: 'fetch_browserbase_page',
              service: 'mpp.browserbase.com',
              endpoint: 'https://mpp.browserbase.com/fetch',
              amount_base_units: '10000',
            },
          },
        },
      });
    }

    if (options.includeCronLedger && req.method === 'GET' && req.url === '/v1/agents/agent-launch-intel/ledger/cron-browserbase-fetch-2026-06-07') {
      if (req.headers.authorization !== 'Bearer signer-admin-token') {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      return sendJson(res, 200, {
        record: {
          status: 'approved',
          agent_id: 'agent-launch-intel',
          idempotency_key: 'cron-browserbase-fetch-2026-06-07',
          amount_base_units: '10000',
          response: {
            approval: {
              operation: 'mpp_fetch',
              command: 'fetch_browserbase_page',
              service: 'mpp.browserbase.com',
              endpoint: 'https://mpp.browserbase.com/fetch',
              amount_base_units: '10000',
            },
          },
        },
      });
    }

    return sendJson(res, 404, { error: 'not_found' });
  };
}

function startServer(handler) {
  const calls = [];
  const server = createServer((req, res) => handler(req, res, calls));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
