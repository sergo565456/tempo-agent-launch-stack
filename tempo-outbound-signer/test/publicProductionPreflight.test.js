import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicSignerProductionPreflight } from '../scripts/public-production-preflight.js';

describe('public signer production preflight', () => {
  it('checks signer public readiness and auth gates without live routes', async () => {
    const signer = await startServer(createSignerHandler());

    try {
      const summary = await runPublicSignerProductionPreflight({
        baseUrl: signer.url,
        adminToken: 'signer-admin-token',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.provider, 'turnkey');
      assert.equal(summary.ledger_backend, 'upstash_redis');
      assert.equal(summary.ledger_durable_configured, true);
      assert.deepEqual(summary.admin_rate_limit, {
        enabled: true,
        max: 60,
        window_ms: 60000,
      });
      assert.equal(summary.unauthorized_agents_status, 401);
      assert.equal(summary.authorized_agents_status, 200);
      assert.equal(summary.expected_agent_found, true);
      assert.equal(summary.agent_policy_safety.wallet_access_key_distinct, true);
      assert.equal(summary.agent_policy_safety.service, 'mpp.browserbase.com');
      assert.equal(summary.agent_policy_safety.per_call_limit_base_units, '10000');
      assert.equal(summary.unauthorized_ledger_status, 401);
      assert.equal(summary.authorized_empty_ledger_status, 404);
      assert.equal(signer.calls.some((call) => call.method !== 'GET'), false);
    } finally {
      await signer.close();
    }
  });

  it('checks a Codex GraphQL signer policy when expected target values are supplied', async () => {
    const signer = await startServer(createSignerHandler({
      agentOverrides: {
        per_call_limit_base_units: '1000',
        daily_limit_base_units: '1000',
        allowed_services: ['graph.codex.io'],
        allowed_endpoints: ['https://graph.codex.io/graphql'],
        allowed_recipients: ['0xc12B5D802Da90d14a8b35dEc1cFb6fd5ceeDE60B'],
        allowed_commands: ['codex_graphql_query'],
      },
    }));

    try {
      const summary = await runPublicSignerProductionPreflight({
        baseUrl: signer.url,
        adminToken: 'signer-admin-token',
        allowHttp: true,
        expectedService: 'graph.codex.io',
        expectedEndpoint: 'https://graph.codex.io/graphql',
        expectedCommand: 'codex_graphql_query',
        expectedRecipient: '0xc12B5D802Da90d14a8b35dEc1cFb6fd5ceeDE60B',
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.agent_policy_safety.service, 'graph.codex.io');
      assert.equal(summary.agent_policy_safety.endpoint, 'https://graph.codex.io/graphql');
      assert.equal(summary.agent_policy_safety.command, 'codex_graphql_query');
      assert.equal(summary.agent_policy_safety.per_call_limit_base_units, '1000');
    } finally {
      await signer.close();
    }
  });

  it('rejects admin token leaks from signer responses', async () => {
    const signer = await startServer(createSignerHandler({ leakAuthorizedAgentsToken: true }));

    try {
      await assert.rejects(
        () => runPublicSignerProductionPreflight({
          baseUrl: signer.url,
          adminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /authorized signer agent inventory leaked an admin token/,
      );
    } finally {
      await signer.close();
    }
  });

  it('rejects missing expected signer agent policy', async () => {
    const signer = await startServer(createSignerHandler({ agentId: 'other-agent' }));

    try {
      await assert.rejects(
        () => runPublicSignerProductionPreflight({
          baseUrl: signer.url,
          adminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /expected signer agent policy agent-launch-intel was not found/,
      );
    } finally {
      await signer.close();
    }
  });

  it('rejects unsafe public signer admin rate limiting', async () => {
    const signer = await startServer(createSignerHandler({
      adminRateLimit: {
        enabled: false,
        max: 60,
        window_ms: 60000,
      },
    }));

    try {
      await assert.rejects(
        () => runPublicSignerProductionPreflight({
          baseUrl: signer.url,
          adminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /signer admin rate limit is not enabled/,
      );
    } finally {
      await signer.close();
    }
  });

  it('rejects unsafe public signer agent policy before live payment', async () => {
    const signer = await startServer(createSignerHandler({
      agentOverrides: {
        tempo_access_key_address: '0x3333333333333333333333333333333333333333',
        per_call_limit_base_units: '50000',
      },
    }));

    try {
      await assert.rejects(
        () => runPublicSignerProductionPreflight({
          baseUrl: signer.url,
          adminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /wallet_address and tempo_access_key_address must be different keys/,
      );
    } finally {
      await signer.close();
    }
  });
});

function createSignerHandler(options = {}) {
  const agentId = options.agentId || 'agent-launch-intel';

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
        admin_rate_limit: options.adminRateLimit || {
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
            agent_id: agentId,
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
            ...(options.agentOverrides || {}),
          },
        ],
        ...(options.leakAuthorizedAgentsToken ? { leaked: 'signer-admin-token' } : {}),
      });
    }
    if (req.method === 'GET' && req.url === '/v1/agents/agent-launch-intel/ledger/signer-public-preflight-no-record') {
      if (req.headers.authorization !== 'Bearer signer-admin-token') {
        return sendJson(res, 401, {
          error: 'unauthorized',
        });
      }
      return sendJson(res, 404, {
        ok: false,
        error: 'ledger_record_not_found',
        agent_id: 'agent-launch-intel',
        idempotency_key: 'signer-public-preflight-no-record',
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
