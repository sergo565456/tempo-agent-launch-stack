import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicAutonomousReadinessSuite } from '../scripts/public-autonomous-readiness-suite.js';

describe('public autonomous readiness suite', () => {
  it('runs public read-only readiness checks in one suite', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler());

    try {
      const summary = await runPublicAutonomousReadinessSuite({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.checks.production_preflight.payment_mode, 'tempo');
      assert.equal(summary.checks.cron_safety.expected_mode, 'disabled');
      assert.equal(summary.checks.cron_readiness.expected_mode, 'read_only_probe');
      assert.equal(summary.checks.cron_readiness.ready_to_run_authorized, false);
      assert.equal(summary.checks.outbound_preview.amount_base_units, '10000');
      assert.equal(summary.checks.payment_events.unauthorized_status, 401);
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('accepts an enabled cron route only when it is bearer-gated', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ cronAuthGated: true }));

    try {
      const summary = await runPublicAutonomousReadinessSuite({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        expectCronAuthGated: true,
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.checks.cron_safety.expected_mode, 'auth_gated');
      assert.equal(summary.checks.cron_safety.status, 401);
      assert.equal(summary.checks.cron_safety.sent_authorization_header, false);
      assert.equal(summary.checks.cron_readiness.expected_mode, 'ready_to_run_authorized');
      assert.equal(summary.checks.cron_readiness.ready_to_run_authorized, true);
      assert.equal(summary.checks.cron_readiness.arming_found, true);
      assert.equal(agent.calls.some((call) => call.url === '/api/cron/outbound/browserbase-fetch' && call.authorization), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('fails when preview amount differs from the expected launch amount', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ previewAmountBaseUnits: '2000' }));

    try {
      await assert.rejects(
        () => runPublicAutonomousReadinessSuite({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /preview.amount_base_units expected 10000, got 2000/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects admin token leaks from any suite check response', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ leakPaymentEventsToken: true }));

    try {
      await assert.rejects(
        () => runPublicAutonomousReadinessSuite({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /authorized payment events leaked an admin token/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });
});

function createSignerHandler() {
  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url });
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
      });
    }
    if (req.method === 'GET' && req.url === '/v1/readiness') {
      return sendJson(res, 200, {
        ok: true,
        provider: 'turnkey',
        admin_token_configured: true,
        ledger: {
          backend: 'upstash_redis',
          durable_configured: true,
        },
        admin_rate_limit: {
          enabled: true,
          max: 60,
          window_ms: 60000,
        },
      });
    }
    if (req.method === 'GET' && req.url === '/v1/agents') {
      if (req.headers.authorization !== 'Bearer signer-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        agents: [
          {
            agent_id: 'agent-launch-intel',
            enabled: true,
          },
        ],
      });
    }
    return sendJson(res, 404, {
      error: 'not_found',
    });
  };
}

function createAgentHandler(options = {}) {
  const previewAmountBaseUnits = options.previewAmountBaseUnits || '10000';

  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        payment_mode: 'tempo',
        outbound_live_payments: true,
        storage: {
          backend: 'upstash_redis',
          durable_configured: true,
        },
      });
    }
    if (req.method === 'GET' && req.url === '/v1/runtime/tempo-readiness') {
      return sendJson(res, 200, {
        ok: true,
        live_enabled: true,
      });
    }
    if (req.method === 'GET' && req.url === '/openapi.json') {
      return sendJson(res, 200, {
        openapi: '3.1.0',
      });
    }
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      return sendJson(res, 200, {
        name: 'Agent Launch Intel API',
      });
    }
    if (req.method === 'GET' && req.url === '/.well-known/x402') {
      return sendJson(res, 200, {
        payment: 'tempo',
      });
    }
    if (req.method === 'GET' && req.url === '/llms.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
      });
      return res.end('Agent Launch Intel API');
    }
    if (req.method === 'GET' && req.url === '/v1/admin/outbound/readiness') {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        payment_provider: 'remote_signer',
        remote_signer: {
          readiness: {
            ok: true,
            provider: 'turnkey',
            ledger: {
              backend: 'upstash_redis',
              durable_configured: true,
            },
            admin_rate_limit: {
              enabled: true,
              max: 60,
              window_ms: 60000,
            },
          },
          agent_policy: {
            found: true,
          },
        },
        blockers: [],
        warnings: [],
      });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/admin/outbound/browserbase-fetch/preview')) {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      return sendJson(res, 200, {
        ok: true,
        read_only: true,
        request: {
          method: 'POST',
          body: {
            confirm: 'fetch-one-mpp-endpoint',
            idempotency_key: url.searchParams.get('idempotency_key'),
            command: 'fetch_browserbase_page',
            service: 'mpp.browserbase.com',
            endpoint: 'https://mpp.browserbase.com/fetch',
            recipient: '0x9d27dc344b981264208583a6fc88b8c137d9e4b3',
            currency: '0x20c000000000000000000000b9537d11c60e8b50',
            chain_id: 4217,
            amount_base_units: previewAmountBaseUnits,
          },
        },
        limits: {},
        blockers: [],
        warnings: [],
      });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/admin/payment-events')) {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        ok: true,
        read_only: true,
        limit: 1,
        total_events: 0,
        events: [],
        ...(options.leakPaymentEventsToken ? { leaked: 'agent-admin-token' } : {}),
      });
    }
    if (req.method === 'GET' && req.url === '/v1/admin/outbound/cron/readiness') {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        ok: options.cronAuthGated === true,
        read_only: true,
        ready_to_enable: options.cronAuthGated === true,
        ready_to_run_authorized: options.cronAuthGated === true,
        cron: {
          enabled: options.cronAuthGated === true,
          secret_configured: options.cronAuthGated === true,
          strong_secret_configured: options.cronAuthGated === true,
          idempotency_prefix: 'cron-browserbase-fetch',
          next_idempotency_key: 'cron-browserbase-fetch-2026-06-07',
        },
        arming: {
          found: options.cronAuthGated === true,
          expected_idempotency_key: 'first-live-browserbase-001',
        },
        blockers: options.cronAuthGated ? [] : ['cron disabled'],
        warnings: [],
        note: 'Read-only readiness only. No cron bearer token, signer request, payment, or downstream MPP fetch was executed.',
      });
    }
    if (req.method === 'GET' && req.url === '/api/cron/outbound/browserbase-fetch') {
      if (options.cronAuthGated) {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 503, {
        error: 'outbound_cron_disabled',
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
