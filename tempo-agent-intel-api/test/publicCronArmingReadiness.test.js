import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicCronArmingReadiness } from '../scripts/public-cron-arming-readiness.js';

describe('public cron arming readiness', () => {
  it('accepts a reconciled manual outbound payment as the cron arming key', async () => {
    const agent = await startServer(createAgentHandler());
    const signer = await startServer(createSignerHandler());

    try {
      const summary = await runPublicCronArmingReadiness({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        idempotencyKey: 'first-live-browserbase-001',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.checks.manual_outbound_reconciliation.agent_event_type, 'outbound_admin_payment_succeeded');
      assert.equal(summary.checks.manual_outbound_reconciliation.trigger, 'admin_manual');
      assert.equal(summary.checks.cron_safety.expected_mode, 'disabled');
      assert.equal(summary.arming_env.OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY, 'first-live-browserbase-001');
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(agent.calls.some((call) => call.url === '/api/cron/outbound/browserbase-fetch' && call.authorization), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects a cron success event as a cron arming source', async () => {
    const agent = await startServer(createAgentHandler({ eventType: 'outbound_cron_payment_succeeded', trigger: 'vercel_cron' }));
    const signer = await startServer(createSignerHandler());

    try {
      await assert.rejects(
        () => runPublicCronArmingReadiness({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          idempotencyKey: 'first-live-browserbase-001',
          allowHttp: true,
        }),
        /Cron arming requires outbound_admin_payment_succeeded/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects admin token leaks from reconciliation responses', async () => {
    const agent = await startServer(createAgentHandler({ leakAgentToken: true }));
    const signer = await startServer(createSignerHandler());

    try {
      await assert.rejects(
        () => runPublicCronArmingReadiness({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          idempotencyKey: 'first-live-browserbase-001',
          allowHttp: true,
        }),
        /agent payment events leaked an admin token/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });
});

function createAgentHandler(options = {}) {
  const eventType = options.eventType || 'outbound_admin_payment_succeeded';
  const trigger = options.trigger || 'admin_manual';

  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
    if (req.method === 'GET' && req.url.startsWith('/v1/admin/payment-events')) {
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
            event_id: 'payevt_manual',
            type: eventType,
            trigger,
            idempotency_key: 'first-live-browserbase-001',
            payment_provider: 'remote_signer',
            signer_agent_id: 'agent-launch-intel',
            signer_command: 'fetch_browserbase_page',
            service: 'mpp.browserbase.com',
            endpoint: 'https://mpp.browserbase.com/fetch',
            amount_base_units: '10000',
            receipt_reference: 'tx_fake_manual',
            created_at: '2026-06-07T00:00:00.000Z',
          },
        ],
        ...(options.leakAgentToken ? { leaked: 'agent-admin-token' } : {}),
      });
    }
    if (req.method === 'GET' && req.url === '/api/cron/outbound/browserbase-fetch') {
      return sendJson(res, 503, {
        error: 'outbound_cron_disabled',
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
    if (req.method === 'GET' && req.url === '/v1/agents/agent-launch-intel/ledger/first-live-browserbase-001') {
      if (req.headers.authorization !== 'Bearer signer-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }

      return sendJson(res, 200, {
        ok: true,
        record: {
          status: 'approved',
          agent_id: 'agent-launch-intel',
          idempotency_key: 'first-live-browserbase-001',
          amount_base_units: '10000',
          created_at: '2026-06-07T00:00:01.000Z',
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

    return sendJson(res, 404, {
      error: 'not_found',
    });
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
