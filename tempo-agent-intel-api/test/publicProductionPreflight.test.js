import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicProductionPreflight } from '../scripts/public-production-preflight.js';

describe('public production preflight', () => {
  it('checks agent and signer public readiness without live payment routes', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler());

    try {
      const summary = await runPublicProductionPreflight({
        agentUrl: agent.url,
        signerUrl: signer.url,
        agentAdminToken: 'agent-admin-token',
        signerAdminToken: 'signer-admin-token',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.signer.provider, 'turnkey');
      assert.equal(summary.signer.ledger_backend, 'upstash_redis');
      assert.deepEqual(summary.signer.admin_rate_limit, {
        enabled: true,
        max: 60,
        window_ms: 60000,
      });
      assert.equal(summary.agent.health.payment_mode, 'tempo');
      assert.equal(summary.agent.outbound_readiness.signer_ledger_backend, 'upstash_redis');
      assert.deepEqual(summary.agent.outbound_readiness.signer_admin_rate_limit, {
        enabled: true,
        max: 60,
        window_ms: 60000,
      });
      assert.equal(agent.calls.some((call) => call.method === 'POST'), false);
      assert.equal(signer.calls.some((call) => call.method === 'POST'), false);
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects a non-durable signer ledger', async () => {
    const signer = await startServer(createSignerHandler({
      ledger: {
        backend: 'file',
        durable_configured: false,
      },
    }));
    const agent = await startServer(createAgentHandler());

    try {
      await assert.rejects(
        () => runPublicProductionPreflight({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /signer ledger is not durable/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects public signer readiness without safe admin rate limiting', async () => {
    const signer = await startServer(createSignerHandler({
      adminRateLimit: {
        enabled: true,
        max: 121,
        window_ms: 60000,
      },
    }));
    const agent = await startServer(createAgentHandler());

    try {
      await assert.rejects(
        () => runPublicProductionPreflight({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /signer admin rate limit max must be between 1 and 120/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects agent-facing signer readiness without safe admin rate limiting', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({
      signerAdminRateLimit: {
        enabled: false,
        max: 60,
        window_ms: 60000,
      },
    }));

    try {
      await assert.rejects(
        () => runPublicProductionPreflight({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /remote signer admin rate limit is not enabled/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects missing agent-facing signer admin rate limiting', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ signerAdminRateLimit: null }));

    try {
      await assert.rejects(
        () => runPublicProductionPreflight({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /remote signer admin rate limit is not exposed by outbound readiness/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects admin token leaks from public readiness responses', async () => {
    const signer = await startServer(createSignerHandler({ leakAuthorizedToken: true }));
    const agent = await startServer(createAgentHandler());

    try {
      await assert.rejects(
        () => runPublicProductionPreflight({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /authorized signer agent inventory leaked an admin token/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });

  it('rejects admin token leaks from agent health responses', async () => {
    const signer = await startServer(createSignerHandler());
    const agent = await startServer(createAgentHandler({ leakHealthToken: true }));

    try {
      await assert.rejects(
        () => runPublicProductionPreflight({
          agentUrl: agent.url,
          signerUrl: signer.url,
          agentAdminToken: 'agent-admin-token',
          signerAdminToken: 'signer-admin-token',
          allowHttp: true,
        }),
        /agent health leaked an admin token/,
      );
    } finally {
      await agent.close();
      await signer.close();
    }
  });
});

function createSignerHandler(options = {}) {
  const ledger = options.ledger || {
    backend: 'upstash_redis',
    durable_configured: true,
  };

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
        ledger,
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
            agent_id: 'agent-launch-intel',
          },
        ],
        ...(options.leakAuthorizedToken ? { leaked: 'signer-admin-token' } : {}),
      });
    }

    return sendJson(res, 404, {
      error: 'not_found',
    });
  };
}

function createAgentHandler(options = {}) {
  const storage = options.storage || {
    backend: 'upstash_redis',
    durable_configured: true,
  };
  const signerLedger = options.signerLedger || {
    backend: 'upstash_redis',
    durable_configured: true,
  };
  const signerAdminRateLimit = options.signerAdminRateLimit === undefined
    ? {
      enabled: true,
      max: 60,
      window_ms: 60000,
    }
    : options.signerAdminRateLimit;

  return (req, res, calls) => {
    calls.push({ method: req.method, url: req.url });
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        payment_mode: 'tempo',
        outbound_live_payments: true,
        storage,
        ...(options.leakHealthToken ? { leaked: 'agent-admin-token' } : {}),
      });
    }

    if (req.method === 'GET' && req.url === '/v1/runtime/tempo-readiness') {
      return sendJson(res, 200, {
        ok: true,
        live_enabled: true,
      });
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
            ledger: signerLedger,
            ...(signerAdminRateLimit ? { admin_rate_limit: signerAdminRateLimit } : {}),
          },
          agent_policy: {
            found: true,
          },
        },
        blockers: [],
        warnings: [],
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
