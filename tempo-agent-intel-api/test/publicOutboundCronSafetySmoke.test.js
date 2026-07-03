import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicOutboundCronSafetySmoke } from '../scripts/public-outbound-cron-safety-smoke.js';

describe('public outbound cron safety smoke', () => {
  it('passes when the public cron route is disabled', async () => {
    const server = await startServer((req, res, calls) => {
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
      sendJson(res, 503, {
        error: 'outbound_cron_disabled',
      });
    });

    try {
      const summary = await runPublicOutboundCronSafetySmoke({
        baseUrl: server.url,
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.expected_mode, 'disabled');
      assert.equal(summary.sent_authorization_header, false);
      assert.equal(server.calls.length, 1);
      assert.equal(server.calls[0].authorization, null);
    } finally {
      await server.close();
    }
  });

  it('passes when the public cron route is enabled but auth-gated', async () => {
    const server = await startServer((req, res, calls) => {
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
      sendJson(res, 401, {
        error: 'unauthorized',
      });
    });

    try {
      const summary = await runPublicOutboundCronSafetySmoke({
        baseUrl: server.url,
        expectAuthGated: true,
        allowHttp: true,
      });

      assert.equal(summary.ok, true);
      assert.equal(summary.expected_mode, 'auth_gated');
      assert.equal(summary.sent_authorization_header, false);
      assert.equal(server.calls.length, 1);
      assert.equal(server.calls[0].authorization, null);
    } finally {
      await server.close();
    }
  });

  it('rejects an unexpectedly executable cron route', async () => {
    const server = await startServer((_req, res) => {
      sendJson(res, 200, {
        ok: true,
      });
    });

    try {
      await assert.rejects(
        () => runPublicOutboundCronSafetySmoke({
          baseUrl: server.url,
          allowHttp: true,
        }),
        /expected HTTP 503/,
      );
    } finally {
      await server.close();
    }
  });
});

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
