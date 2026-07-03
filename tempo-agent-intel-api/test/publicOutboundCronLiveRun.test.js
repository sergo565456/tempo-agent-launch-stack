import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicOutboundCronLiveRun } from '../scripts/public-outbound-cron-live-run.js';

const CRON_IDEMPOTENCY_KEY = 'cron-browserbase-fetch-2026-06-07';

describe('public outbound cron live run', () => {
  it('refuses to execute the authorized cron route without explicit confirmation', async () => {
    const agent = await startServer(createAgentHandler());

    try {
      await assert.rejects(
        () => runPublicOutboundCronLiveRun({
          baseUrl: agent.url,
          agentAdminToken: 'agent-admin-token',
          cronSecret: 'cron-secret-token',
          allowHttp: true,
        }),
        /Refusing to execute outbound cron without --confirm-live-cron-run/,
      );

      assert.equal(agent.calls.some((call) => call.url === '/api/cron/outbound/browserbase-fetch'), false);
      assert.equal(agent.calls.filter((call) => call.url === '/v1/admin/outbound/cron/readiness').length, 2);
    } finally {
      await agent.close();
    }
  });

  it('executes exactly one authorized cron run after readiness and confirmation', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({
      signerUrl: signer.url,
    }));

    try {
      const summary = await runPublicOutboundCronLiveRun({
        baseUrl: agent.url,
        agentAdminToken: 'agent-admin-token',
        cronSecret: 'cron-secret-token',
        signerAdminToken: 'signer-admin-token',
        expectedIdempotencyKey: CRON_IDEMPOTENCY_KEY,
        confirmLiveCronRun: true,
        verifySignerLedger: true,
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.idempotency_key, CRON_IDEMPOTENCY_KEY);
      assert.equal(summary.execution.trigger, 'vercel_cron');
      assert.equal(summary.execution.requested_amount_base_units, '10000');
      assert.equal(summary.agent_ledger.type, 'outbound_cron_payment_succeeded');
      assert.equal(summary.signer_ledger.status, 'approved');

      const cronCalls = agent.calls.filter((call) => call.url === '/api/cron/outbound/browserbase-fetch');
      assert.equal(cronCalls.length, 1);
      assert.equal(cronCalls[0].authorization, 'Bearer cron-secret-token');
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects a readiness idempotency key mismatch before cron execution', async () => {
    const agent = await startServer(createAgentHandler());

    try {
      await assert.rejects(
        () => runPublicOutboundCronLiveRun({
          baseUrl: agent.url,
          agentAdminToken: 'agent-admin-token',
          cronSecret: 'cron-secret-token',
          expectedIdempotencyKey: 'cron-browserbase-fetch-2099-01-01',
          confirmLiveCronRun: true,
          allowHttp: true,
        }),
        /Expected cron idempotency key cron-browserbase-fetch-2099-01-01/,
      );

      assert.equal(agent.calls.some((call) => call.url === '/api/cron/outbound/browserbase-fetch'), false);
    } finally {
      await agent.close();
    }
  });

  it('rejects token leaks from authorized cron responses', async () => {
    const agent = await startServer(createAgentHandler({
      leakCronSecret: true,
    }));

    try {
      await assert.rejects(
        () => runPublicOutboundCronLiveRun({
          baseUrl: agent.url,
          agentAdminToken: 'agent-admin-token',
          cronSecret: 'cron-secret-token',
          confirmLiveCronRun: true,
          allowHttp: true,
        }),
        /authorized outbound cron run leaked an admin or cron token/,
      );
    } finally {
      await agent.close();
    }
  });
});

function createAgentHandler(options = {}) {
  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });

    if (req.method === 'GET' && req.url === '/v1/admin/outbound/cron/readiness') {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        read_only: true,
        ready_to_enable: true,
        ready_to_run_authorized: true,
        cron: {
          enabled: true,
          secret_configured: true,
          strong_secret_configured: true,
          idempotency_prefix: 'cron-browserbase-fetch',
          next_idempotency_key: CRON_IDEMPOTENCY_KEY,
        },
        arming: {
          found: true,
          expected_idempotency_key: 'first-live-browserbase-001',
        },
        blockers: [],
        warnings: [],
        note: 'Read-only readiness only. No cron bearer token, signer request, payment, or downstream MPP fetch was executed.',
      });
    }

    if (req.method === 'GET' && req.url === '/api/cron/outbound/browserbase-fetch') {
      if (req.headers.authorization !== 'Bearer cron-secret-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        trigger: 'vercel_cron',
        read_only: false,
        idempotency_key: CRON_IDEMPOTENCY_KEY,
        ledger_event_id: 'payevt_cron_001',
        result: buildCronResult(options.signerUrl || 'https://signer.example', {
          leakCronSecret: options.leakCronSecret,
        }),
      });
    }

    if (req.method === 'GET' && req.url === '/v1/admin/payment-events?limit=20') {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        read_only: true,
        total_events: 1,
        events: [
          {
            event_id: 'payevt_cron_001',
            type: 'outbound_cron_payment_succeeded',
            trigger: 'vercel_cron',
            idempotency_key: CRON_IDEMPOTENCY_KEY,
            amount_base_units: '10000',
            receipt_reference: 'tx_fake_cron',
          },
        ],
      });
    }

    return sendJson(res, 404, {
      error: 'not_found',
    });
  };
}

function createSignerHandler() {
  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });

    if (req.method === 'GET' && req.url === `/v1/agents/agent-launch-intel/ledger/${CRON_IDEMPOTENCY_KEY}`) {
      if (req.headers.authorization !== 'Bearer signer-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        record: {
          status: 'approved',
          agent_id: 'agent-launch-intel',
          idempotency_key: CRON_IDEMPOTENCY_KEY,
          amount_base_units: '10000',
          response: {
            approval: {
              operation: 'mpp_fetch',
            },
          },
          created_at: '2026-06-07T00:00:00.000Z',
        },
      });
    }

    return sendJson(res, 404, {
      error: 'not_found',
    });
  };
}

function buildCronResult(signerBaseUrl, options = {}) {
  return {
    ok: true,
    provider: 'remote_signer',
    signer_url: `${signerBaseUrl}/v1/agents/agent-launch-intel/mpp/fetch`,
    signer_agent_id: 'agent-launch-intel',
    signer_command: 'fetch_browserbase_page',
    service: 'mpp.browserbase.com',
    endpoint: 'https://mpp.browserbase.com/fetch',
    requested_amount_base_units: '10000',
    recipient: '0x9d27dc344b981264208583a6fc88b8c137d9e4b3',
    signer_response: {
      approval: {
        operation: 'mpp_fetch',
        idempotency_key: CRON_IDEMPOTENCY_KEY,
        endpoint: 'https://mpp.browserbase.com/fetch',
        amount_base_units: '10000',
      },
      fetch_result: {
        receipt: {
          reference: 'tx_fake_cron',
        },
      },
    },
    ...(options.leakCronSecret ? { leaked: 'cron-secret-token' } : {}),
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
  res.writeHead(status, {
    'content-type': 'application/json',
  });
  res.end(JSON.stringify(body));
}
