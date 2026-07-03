import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicOutboundCronReadinessSmoke } from '../scripts/public-outbound-cron-readiness-smoke.js';

describe('public outbound cron readiness smoke', () => {
  it('probes the admin cron readiness endpoint without cron auth or payment routes', async () => {
    const agent = await startServer(createAgentHandler());

    try {
      const summary = await runPublicOutboundCronReadinessSmoke({
        baseUrl: agent.url,
        agentAdminToken: 'agent-admin-token',
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.expected_mode, 'read_only_probe');
      assert.equal(summary.ready_to_run_authorized, false);
      assert.equal(summary.cron_enabled, false);
      assert.equal(summary.arming_found, false);
      assert.equal(agent.calls.length, 2);
      assert.equal(agent.calls.every((call) => call.method === 'GET'), true);
      assert.equal(agent.calls.every((call) => call.url === '/v1/admin/outbound/cron/readiness'), true);
      assert.equal(agent.calls.some((call) => call.authorization === 'Bearer agent-admin-token'), true);
      assert.equal(agent.calls.some((call) => call.url === '/api/cron/outbound/browserbase-fetch'), false);
    } finally {
      await agent.close();
    }
  });

  it('accepts ready-to-enable before cron is enabled', async () => {
    const agent = await startServer(createAgentHandler({
      readyToEnable: true,
      armingFound: true,
    }));

    try {
      const summary = await runPublicOutboundCronReadinessSmoke({
        baseUrl: agent.url,
        agentAdminToken: 'agent-admin-token',
        expectReadyToEnable: true,
        allowHttp: true,
      });

      assert.equal(summary.expected_mode, 'ready_to_enable');
      assert.equal(summary.ready_to_enable, true);
      assert.equal(summary.ready_to_run_authorized, false);
      assert.equal(summary.cron_enabled, false);
      assert.equal(summary.arming_found, true);
    } finally {
      await agent.close();
    }
  });

  it('accepts auth-gated cron readiness only when the authorized runtime is armed', async () => {
    const agent = await startServer(createAgentHandler({
      cronEnabled: true,
      readyToEnable: true,
      readyToRunAuthorized: true,
      armingFound: true,
    }));

    try {
      const summary = await runPublicOutboundCronReadinessSmoke({
        baseUrl: agent.url,
        agentAdminToken: 'agent-admin-token',
        expectAuthGated: true,
        allowHttp: true,
      });

      assert.equal(summary.expected_mode, 'ready_to_run_authorized');
      assert.equal(summary.ready_to_enable, true);
      assert.equal(summary.ready_to_run_authorized, true);
      assert.equal(summary.cron_enabled, true);
      assert.equal(summary.arming_found, true);
    } finally {
      await agent.close();
    }
  });

  it('rejects admin token leaks from cron readiness responses', async () => {
    const agent = await startServer(createAgentHandler({
      leakAdminToken: true,
    }));

    try {
      await assert.rejects(
        () => runPublicOutboundCronReadinessSmoke({
          baseUrl: agent.url,
          agentAdminToken: 'agent-admin-token',
          allowHttp: true,
        }),
        /authorized outbound cron readiness leaked an admin token/,
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
        ok: options.readyToRunAuthorized === true,
        read_only: true,
        ready_to_enable: options.readyToEnable === true,
        ready_to_run_authorized: options.readyToRunAuthorized === true,
        cron: {
          enabled: options.cronEnabled === true,
          secret_configured: options.cronEnabled === true,
          strong_secret_configured: options.cronEnabled === true,
          idempotency_prefix: 'cron-browserbase-fetch',
          next_idempotency_key: 'cron-browserbase-fetch-2026-06-07',
        },
        arming: {
          found: options.armingFound === true,
          expected_idempotency_key: 'first-live-browserbase-001',
          idempotency_key: options.armingFound ? 'first-live-browserbase-001' : undefined,
        },
        blockers: options.readyToRunAuthorized ? [] : ['not ready'],
        warnings: [],
        note: 'Read-only readiness only. No cron bearer token, signer request, payment, or downstream MPP fetch was executed.',
        ...(options.leakAdminToken ? { leaked: 'agent-admin-token' } : {}),
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
