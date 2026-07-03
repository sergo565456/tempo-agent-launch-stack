import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicInboundReconcile } from '../scripts/public-inbound-reconcile.js';

describe('public inbound reconciliation', () => {
  it('matches an inbound payment ledger event with the stored paid report', async () => {
    const agent = await startServer(createAgentHandler());

    try {
      const summary = await runPublicInboundReconcile({
        baseUrl: agent.url,
        agentAdminToken: 'agent-admin-token',
        idempotencyKey: 'public-live-tempo-inbound-001',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.match.report_id, 'rpt_public_inbound_001');
      assert.equal(summary.match.receipt_id, 'receipt_public_inbound_001');
      assert.equal(summary.report.payment_status, 'paid');
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(agent.calls.some((call) => call.url.startsWith('/v1/analyze')), false);
    } finally {
      await agent.close();
    }
  });

  it('rejects a missing inbound payment_verified event', async () => {
    const agent = await startServer(createAgentHandler({
      events: [],
    }));

    try {
      await assert.rejects(
        () => runPublicInboundReconcile({
          baseUrl: agent.url,
          agentAdminToken: 'agent-admin-token',
          idempotencyKey: 'public-live-tempo-inbound-001',
          allowHttp: true,
        }),
        /No matching inbound payment_verified event/,
      );
    } finally {
      await agent.close();
    }
  });

  it('rejects report receipt mismatches', async () => {
    const agent = await startServer(createAgentHandler({
      reportReceiptId: 'wrong_receipt',
    }));

    try {
      await assert.rejects(
        () => runPublicInboundReconcile({
          baseUrl: agent.url,
          agentAdminToken: 'agent-admin-token',
          idempotencyKey: 'public-live-tempo-inbound-001',
          allowHttp: true,
        }),
        /report.metadata.receipt_id expected receipt_public_inbound_001, got wrong_receipt/,
      );
    } finally {
      await agent.close();
    }
  });

  it('rejects admin token leaks from reconciliation responses', async () => {
    const agent = await startServer(createAgentHandler({
      leakAdminToken: true,
    }));

    try {
      await assert.rejects(
        () => runPublicInboundReconcile({
          baseUrl: agent.url,
          agentAdminToken: 'agent-admin-token',
          idempotencyKey: 'public-live-tempo-inbound-001',
          allowHttp: true,
        }),
        /agent payment-events lookup leaked an admin token/,
      );
    } finally {
      await agent.close();
    }
  });
});

function createAgentHandler(options = {}) {
  const events = options.events || [
    {
      event_id: 'payevt_public_inbound_001',
      type: 'payment_verified',
      idempotency_key: 'public-live-tempo-inbound-001',
      request_hash: 'hash_public_inbound_001',
      report_id: 'rpt_public_inbound_001',
      report_type: 'wallet_intel_report',
      payment_mode: 'tempo',
      payment_method: 'tempo_mpp',
      payment_status: 'paid',
      receipt_id: 'receipt_public_inbound_001',
    },
    {
      event_id: 'payevt_challenge_001',
      type: 'challenge_created',
      idempotency_key: 'public-live-tempo-inbound-001',
    },
  ];

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
        limit: 100,
        total_events: events.length,
        events,
        ...(options.leakAdminToken ? { leaked: 'agent-admin-token' } : {}),
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
          receipt_id: options.reportReceiptId || 'receipt_public_inbound_001',
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
