import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicOutboundReconcile } from '../scripts/public-outbound-reconcile.js';

describe('public outbound reconciliation', () => {
  it('matches an agent payment event with the signer ledger record', async () => {
    const agent = await startServer(createAgentHandler());
    const signer = await startServer(createSignerHandler());

    try {
      const summary = await runPublicOutboundReconcile({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        idempotencyKey: 'first-live-browserbase-001',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.agent.event_type, 'outbound_admin_payment_succeeded');
      assert.equal(summary.signer.status, 'approved');
      assert.equal(summary.signer.amount_base_units, '10000');
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects amount mismatches between agent and signer ledgers', async () => {
    const agent = await startServer(createAgentHandler());
    const signer = await startServer(createSignerHandler({ amountBaseUnits: '2000' }));

    try {
      await assert.rejects(
        () => runPublicOutboundReconcile({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          idempotencyKey: 'first-live-browserbase-001',
          allowHttp: true,
        }),
        /does not match agent event amount/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects admin token leaks in reconciliation responses', async () => {
    const agent = await startServer(createAgentHandler({ leakAgentToken: true }));
    const signer = await startServer(createSignerHandler());

    try {
      await assert.rejects(
        () => runPublicOutboundReconcile({
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
  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url });
    if (req.method === 'GET' && req.url.startsWith('/v1/admin/payment-events')) {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }

      return sendJson(res, 200, {
        ok: true,
        read_only: true,
        total_events: 2,
        events: [
          {
            event_id: 'payevt_new',
            type: 'outbound_admin_payment_succeeded',
            trigger: 'admin_manual',
            idempotency_key: 'first-live-browserbase-001',
            signer_agent_id: 'agent-launch-intel',
            signer_command: 'fetch_browserbase_page',
            service: 'mpp.browserbase.com',
            endpoint: 'https://mpp.browserbase.com/fetch',
            amount_base_units: '10000',
            receipt_reference: 'tx_fake_reconcile',
            created_at: '2026-06-07T00:00:00.000Z',
          },
          {
            event_id: 'payevt_old',
            type: 'payment_verified',
            idempotency_key: 'other-key',
          },
        ],
        ...(options.leakAgentToken ? { leaked: 'agent-admin-token' } : {}),
      });
    }

    return sendJson(res, 404, {
      error: 'not_found',
    });
  };
}

function createSignerHandler(options = {}) {
  const amountBaseUnits = options.amountBaseUnits || '10000';
  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url });
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
          amount_base_units: amountBaseUnits,
          created_at: '2026-06-07T00:00:01.000Z',
          response: {
            approval: {
              operation: 'mpp_fetch',
              command: 'fetch_browserbase_page',
              service: 'mpp.browserbase.com',
              endpoint: 'https://mpp.browserbase.com/fetch',
              amount_base_units: amountBaseUnits,
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
