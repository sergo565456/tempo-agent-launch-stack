import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicAutonomousGoLiveReadiness } from '../scripts/public-autonomous-go-live-readiness.js';

describe('public autonomous go-live readiness', () => {
  it('runs signer production and autonomous readiness checks without live routes', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler());

    try {
      const summary = await runPublicAutonomousGoLiveReadiness({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.checks.signer_production_preflight.ok, true);
      assert.equal(summary.checks.signer_production_preflight.unauthorized_ledger_status, 401);
      assert.equal(summary.checks.autonomous_readiness.ok, true);
      assert.equal(summary.checks.autonomous_readiness.cron_expected_mode, 'disabled');
      assert.equal(summary.checks.autonomous_readiness.cron_readiness_expected_mode, 'read_only_probe');
      assert.equal(summary.checks.autonomous_readiness.cron_ready_to_run_authorized, false);
      assert.equal(summary.checks.autonomous_readiness.outbound_preview_amount_base_units, '10000');
      assert.equal(agent.calls.some((call) => call.method !== 'GET'), false);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects a signer ledger lookup that is not admin-gated', async () => {
    const signer = await startServer(createSignerHandler({ publicLedgerLookup: true }));
    const agent = await startServer(createAgentHandler());

    try {
      await assert.rejects(
        () => runPublicAutonomousGoLiveReadiness({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /unauthorized signer ledger lookup expected HTTP 401/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects admin token leaks from either public service', async () => {
    const signer = await startServer(createSignerHandler({ leakAuthorizedLedgerToken: true }));
    const agent = await startServer(createAgentHandler());

    try {
      await assert.rejects(
        () => runPublicAutonomousGoLiveReadiness({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /authorized signer empty-ledger lookup leaked an admin token/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });
});

function createSignerHandler(options = {}) {
  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'tempo-outbound-signer',
        provider: 'turnkey',
        agent_count: 1,
      });
    }
    if (req.method === 'GET' && req.url === '/v1/readiness') {
      return sendJson(res, 200, {
        ok: true,
        provider: 'turnkey',
        admin_token_configured: true,
        agent_count: 1,
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
            wallet_address: '0x3333333333333333333333333333333333333333',
            tempo_access_key_address: '0x4444444444444444444444444444444444444444',
            turnkey_sign_with_configured: true,
            enabled: true,
            per_call_limit_base_units: '10000',
            daily_limit_base_units: '50000',
            allowed_services: ['mpp.browserbase.com'],
            allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
            allowed_recipients: ['0x9d27dc344b981264208583a6fc88b8c137d9e4b3'],
            allowed_commands: ['fetch_browserbase_page'],
          },
        ],
      });
    }
    if (req.method === 'GET' && req.url === '/v1/agents/agent-launch-intel/ledger/signer-public-preflight-no-record') {
      if (req.headers.authorization !== 'Bearer signer-admin-token') {
        return sendJson(res, options.publicLedgerLookup ? 200 : 401, {
          error: options.publicLedgerLookup ? 'public_ledger_not_allowed' : 'unauthorized',
        });
      }
      return sendJson(res, 404, {
        ok: false,
        error: 'ledger_record_not_found',
        agent_id: 'agent-launch-intel',
        idempotency_key: 'signer-public-preflight-no-record',
        ...(options.leakAuthorizedLedgerToken ? { leaked: 'signer-admin-token' } : {}),
      });
    }
    return sendJson(res, 404, {
      error: 'not_found',
    });
  };
}

function createAgentHandler() {
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
            amount_base_units: '10000',
          },
        },
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
        total_events: 0,
        events: [],
      });
    }
    if (req.method === 'GET' && req.url === '/v1/admin/outbound/cron/readiness') {
      if (req.headers.authorization !== 'Bearer agent-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 200, {
        ok: false,
        read_only: true,
        ready_to_enable: false,
        ready_to_run_authorized: false,
        cron: {
          enabled: false,
          secret_configured: false,
          strong_secret_configured: false,
          idempotency_prefix: 'cron-browserbase-fetch',
          next_idempotency_key: 'cron-browserbase-fetch-2026-06-07',
        },
        arming: {
          found: false,
          expected_idempotency_key: null,
        },
        blockers: ['cron disabled'],
        warnings: [],
        note: 'Read-only readiness only. No cron bearer token, signer request, payment, or downstream MPP fetch was executed.',
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
