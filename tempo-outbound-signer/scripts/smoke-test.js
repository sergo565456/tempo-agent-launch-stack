import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../src/config.js';
import { SignerLedger } from '../src/ledger.js';
import { createApp } from '../src/app.js';
import { createSigningProvider } from '../src/providers/index.js';

const tempDir = await mkdtemp(join(tmpdir(), 'tempo-outbound-signer-smoke-'));
const config = getConfig({
  HOST: '127.0.0.1',
  PORT: '0',
  SIGNER_ADMIN_TOKEN: 'smoke-token',
  SIGNER_LEDGER_PATH: join(tempDir, 'ledger.json'),
});
const ledger = new SignerLedger(config.ledgerPath);
const provider = createSigningProvider(config);
const server = createServer(createApp({ config, ledger, provider }));

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetchJson(`${baseUrl}/health`);
  const readiness = await fetchJson(`${baseUrl}/v1/readiness`);
  const unauthorized = await fetchJson(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validRequest('smoke-unauthorized')),
  });
  const approved = await fetchJson(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer smoke-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(validRequest('smoke-approved')),
  });
  const replay = await fetch(`${baseUrl}/v1/agents/agent-launch-intel/payments/mpp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer smoke-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(validRequest('smoke-approved')),
  });

  if (health.status !== 200 || readiness.status !== 200 || unauthorized.status !== 401 || approved.status !== 200 || replay.status !== 200) {
    throw new Error('Smoke status check failed');
  }

  console.log(JSON.stringify({
    ok: true,
    health: {
      provider: health.body.provider,
      agent_count: health.body.agent_count,
    },
    readiness: {
      ok: readiness.body.ok,
      admin_token_configured: readiness.body.admin_token_configured,
    },
    unauthorized_status: unauthorized.status,
    approved_status: approved.status,
    approved_provider: approved.body.signer_result.provider,
    replay_status: replay.status,
    replay_cache: replay.headers.get('x-signer-cache'),
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}

async function fetchJson(url, options = undefined) {
  const response = await fetch(url, options);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

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
    amount_base_units: '1000',
  };
}
