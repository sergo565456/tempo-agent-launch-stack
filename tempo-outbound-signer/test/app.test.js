import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../src/config.js';
import { SignerLedger } from '../src/ledger.js';
import { createApp } from '../src/app.js';
import { createSigningProvider } from '../src/providers/index.js';

describe('signer app', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tempo-outbound-signer-'));
    const config = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      SIGNER_ADMIN_TOKEN: 'local-dev-token',
      SIGNER_LEDGER_PATH: join(tempDir, 'ledger.json'),
    });
    const ledger = new SignerLedger(config.ledgerPath);
    const provider = createSigningProvider(config);
    server = createServer(createApp({ config, ledger, provider }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it('serves health and readiness', async () => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.provider, 'mock');

    const readiness = await fetch(`${baseUrl}/v1/readiness`);
    assert.equal(readiness.status, 200);
    const readinessBody = await readiness.json();
    assert.equal(readinessBody.admin_token_configured, true);
  });

  it('requires authorization', async () => {
    const response = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest('auth-test')),
    });

    assert.equal(response.status, 401);
  });

  it('keeps agent policy inventory behind admin auth', async () => {
    const unauthorized = await fetch(`${baseUrl}/v1/agents`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/v1/agents`, {
      headers: {
        authorization: 'Bearer local-dev-token',
      },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json();
    assert.equal(body.agents[0].agent_id, 'agent-launch-intel');
  });

  it('rate limits admin routes by client before policy or provider work', async () => {
    const rateLimitDir = await mkdtemp(join(tmpdir(), 'tempo-outbound-signer-rate-limit-'));
    const rateLimitConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      SIGNER_ADMIN_TOKEN: 'local-dev-token',
      SIGNER_LEDGER_PATH: join(rateLimitDir, 'ledger.json'),
      SIGNER_ADMIN_RATE_LIMIT_ENABLED: 'true',
      SIGNER_ADMIN_RATE_LIMIT_MAX: '2',
      SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS: '60000',
      SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
    });
    const rateLimitLedger = new SignerLedger(rateLimitConfig.ledgerPath);
    let providerCalled = false;
    const rateLimitProvider = {
      signPayment: async () => {
        providerCalled = true;
        return {};
      },
      fetchMpp: async () => {
        providerCalled = true;
        return {};
      },
    };
    const rateLimitServer = createServer(createApp({
      config: rateLimitConfig,
      ledger: rateLimitLedger,
      provider: rateLimitProvider,
    }));
    await new Promise((resolve) => rateLimitServer.listen(0, '127.0.0.1', resolve));
    const rateLimitBaseUrl = `http://127.0.0.1:${rateLimitServer.address().port}`;

    const request = (clientIp) => fetch(`${rateLimitBaseUrl}/v1/agents/agent-launch-intel/mpp/fetch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': clientIp,
      },
      body: JSON.stringify(validRequest('rate-limit-test')),
    });

    try {
      const first = await request('203.0.113.20');
      const second = await request('203.0.113.20');
      const third = await request('203.0.113.20');
      const otherClient = await request('203.0.113.21');

      assert.equal(first.status, 401);
      assert.equal(second.status, 401);
      assert.equal(third.status, 429);
      assert.equal(third.headers.get('retry-after'), '60');
      assert.equal((await third.json()).error, 'rate_limited');
      assert.equal(otherClient.status, 401);
      assert.equal(providerCalled, false);
    } finally {
      await new Promise((resolve) => rateLimitServer.close(resolve));
      await rm(rateLimitDir, { recursive: true, force: true });
    }
  });

  it('approves a valid mock signing request and replays idempotently', async () => {
    const first = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(validRequest('idem-test')),
    });

    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.signer_result.provider, 'mock');

    const replay = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(validRequest('idem-test')),
    });

    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-signer-cache'), 'idempotent-replay');
    const replayBody = await replay.json();
    assert.equal(replayBody.approval.idempotency_key, 'idem-test');
  });

  it('rejects idempotency key reuse with a different body', async () => {
    const response = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...validRequest('idem-test'),
        amount_base_units: '2000',
      }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'idempotency_conflict');
  });

  it('denies payments outside policy', async () => {
    const response = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...validRequest('deny-test'),
        amount_base_units: '10001',
      }),
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, 'per_call_limit_exceeded');
  });

  it('approves a mock guarded MPP fetch with separate confirmation', async () => {
    const response = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/mpp/fetch`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...validRequest('mpp-fetch-test'),
        confirm: 'fetch-one-mpp-endpoint',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.approval.operation, 'mpp_fetch');
    assert.equal(body.fetch_result.provider, 'mock');
    assert.equal(body.fetch_result.mode, 'mock_mpp_fetch');
  });

  it('reports paid-on-chain provider failures without marking the action approved', async () => {
    const paidFailureDir = await mkdtemp(join(tmpdir(), 'tempo-outbound-signer-paid-failure-'));
    const paidFailureConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      SIGNER_ADMIN_TOKEN: 'local-dev-token',
      SIGNER_LEDGER_PATH: join(paidFailureDir, 'ledger.json'),
    });
    const paidFailureLedger = new SignerLedger(paidFailureConfig.ledgerPath);
    const provider = {
      signPayment: async () => {
        throw new Error('signPayment is not used in this test');
      },
      fetchMpp: async () => {
        const error = new Error('receipt missing');
        error.providerContext = {
          credential: {
            type: 'transaction',
            transaction_hash: `0x${'12'.repeat(32)}`,
          },
          onchain_recovery: {
            checked: true,
            paid_onchain: true,
            transfer_verified: true,
            amount_base_units: '10000',
          },
        };
        throw error;
      },
    };
    const paidFailureServer = createServer(createApp({
      config: paidFailureConfig,
      ledger: paidFailureLedger,
      provider,
    }));
    await new Promise((resolve) => paidFailureServer.listen(0, '127.0.0.1', resolve));
    const paidFailureBaseUrl = `http://127.0.0.1:${paidFailureServer.address().port}`;

    try {
      const response = await fetch(`${paidFailureBaseUrl}/v1/agents/agent-launch-intel/mpp/fetch`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-dev-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...validRequest('paid-onchain-response-failed-test'),
          confirm: 'fetch-one-mpp-endpoint',
        }),
      });

      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error, 'provider_paid_onchain_response_failed');
      assert.equal(body.provider_context.onchain_recovery.paid_onchain, true);
      assert.equal(JSON.stringify(body).includes('local-dev-token'), false);

      const ledgerResponse = await fetch(`${paidFailureBaseUrl}/v1/agents/agent-launch-intel/ledger/paid-onchain-response-failed-test`, {
        headers: {
          authorization: 'Bearer local-dev-token',
        },
      });
      assert.equal(ledgerResponse.status, 200);
      const ledgerBody = await ledgerResponse.json();
      assert.equal(ledgerBody.record.status, 'failed');
      assert.equal(ledgerBody.record.response.error, 'provider_paid_onchain_response_failed');
    } finally {
      await new Promise((resolve) => paidFailureServer.close(resolve));
      await rm(paidFailureDir, { recursive: true, force: true });
    }
  });

  it('exposes signer ledger records by idempotency key behind admin auth', async () => {
    const create = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/mpp/fetch`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...validRequest('ledger-lookup-test'),
        confirm: 'fetch-one-mpp-endpoint',
      }),
    });
    assert.equal(create.status, 200);

    const unauthorized = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/ledger/ledger-lookup-test`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/ledger/ledger-lookup-test`, {
      headers: {
        authorization: 'Bearer local-dev-token',
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.record.status, 'approved');
    assert.equal(body.record.agent_id, 'agent-launch-intel');
    assert.equal(body.record.idempotency_key, 'ledger-lookup-test');
    assert.equal(body.record.amount_base_units, '10000');
    assert.equal(body.record.response.approval.operation, 'mpp_fetch');
    assert.equal(JSON.stringify(body).includes('local-dev-token'), false);
  });

  it('rejects guarded MPP fetch without fetch confirmation', async () => {
    const response = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/mpp/fetch`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(validRequest('mpp-fetch-bad-confirm')),
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, 'confirmation_required');
  });

  it('replays denied requests with the original denied status', async () => {
    const replay = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...validRequest('deny-test'),
        amount_base_units: '10001',
      }),
    });

    assert.equal(replay.status, 403);
    assert.equal(replay.headers.get('x-signer-cache'), 'idempotent-replay');
    const body = await replay.json();
    assert.equal(body.error, 'per_call_limit_exceeded');
  });

  it('reserves idempotency before provider execution', async () => {
    const raceDir = await mkdtemp(join(tmpdir(), 'tempo-outbound-signer-race-'));
    let raceServer;
    let resolveStarted;
    let releaseProvider;
    let providerCalls = 0;
    const providerStarted = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const providerRelease = new Promise((resolve) => {
      releaseProvider = resolve;
    });

    try {
      const raceConfig = getConfig({
        HOST: '127.0.0.1',
        PORT: '0',
        SIGNER_ADMIN_TOKEN: 'local-dev-token',
        SIGNER_LEDGER_PATH: join(raceDir, 'ledger.json'),
      });
      const raceLedger = new SignerLedger(raceConfig.ledgerPath);
      const delayedProvider = {
        signPayment: async (approval) => {
          providerCalls += 1;
          resolveStarted();
          await providerRelease;
          return {
            provider: 'mock',
            approval_id: approval.approval_id,
          };
        },
        fetchMpp: async () => {
          throw new Error('fetchMpp is not used in this test');
        },
      };

      raceServer = createServer(createApp({ config: raceConfig, ledger: raceLedger, provider: delayedProvider }));
      await new Promise((resolve) => raceServer.listen(0, '127.0.0.1', resolve));
      const raceBaseUrl = `http://127.0.0.1:${raceServer.address().port}`;

      const firstPromise = fetch(`${raceBaseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-dev-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(validRequest('pending-race-test')),
      });

      await providerStarted;

      const second = await fetch(`${raceBaseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-dev-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(validRequest('pending-race-test')),
      });

      assert.equal(second.status, 409);
      assert.equal(second.headers.get('x-signer-cache'), 'pending-reservation');
      const secondBody = await second.json();
      assert.equal(secondBody.error, 'payment_in_progress');
      assert.equal(providerCalls, 1);

      releaseProvider();
      const first = await firstPromise;
      assert.equal(first.status, 200);

      const replay = await fetch(`${raceBaseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-dev-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(validRequest('pending-race-test')),
      });

      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get('x-signer-cache'), 'idempotent-replay');
      assert.equal(providerCalls, 1);
    } finally {
      if (raceServer) {
        await new Promise((resolve) => raceServer.close(resolve));
      }
      await rm(raceDir, { recursive: true, force: true });
    }
  });
});

function validRequest(idempotencyKey) {
  return {
    confirm: 'sign-one-payment',
    idempotency_key: idempotencyKey,
    command: 'fetch_browserbase_page',
    service: 'mpp.browserbase.com',
    endpoint: 'https://mpp.browserbase.com/fetch',
    recipient: '0x9d27dc344b981264208583a6fc88b8c137d9e4b3',
    currency: '0x20c000000000000000000000b9537d11c60e8b50',
    chain_id: 4217,
    amount_base_units: '10000',
    browserbase_fetch_url: 'https://mpp.dev/services',
  };
}
