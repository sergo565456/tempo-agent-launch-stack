import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createAgentApp } from '../src/app.js';
import { getConfig as getAgentConfig } from '../src/config.js';
import { ReportStore } from '../src/storage/reportStore.js';
import { PaymentLedger } from '../src/storage/paymentLedger.js';
import { createApp as createSignerApp } from '../../tempo-outbound-signer/src/app.js';
import { getConfig as getSignerConfig } from '../../tempo-outbound-signer/src/config.js';
import { SignerLedger } from '../../tempo-outbound-signer/src/ledger.js';
import { createSigningProvider } from '../../tempo-outbound-signer/src/providers/index.js';

const tempDir = await mkdtemp(join(tmpdir(), 'agent-remote-signer-e2e-'));
let signerServer;
let agentServer;

try {
  const signerConfig = getSignerConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    SIGNER_PROVIDER: 'mock',
    SIGNER_ADMIN_TOKEN: 'remote-signer-smoke-token',
    SIGNER_LEDGER_PATH: join(tempDir, 'signer-ledger.json'),
  });
  const signerLedger = new SignerLedger(signerConfig.ledgerPath);
  const signerProvider = createSigningProvider(signerConfig);
  signerServer = createServer(createSignerApp({
    config: signerConfig,
    ledger: signerLedger,
    provider: signerProvider,
  }));
  await listen(signerServer);
  const signerBaseUrl = `http://127.0.0.1:${signerServer.address().port}`;

  const agentConfig = getAgentConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    PAYMENT_MODE: 'mock',
    OUTBOUND_LIVE_PAYMENTS: 'true',
    OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
    OUTBOUND_SIGNER_BASE_URL: signerBaseUrl,
    OUTBOUND_SIGNER_ADMIN_TOKEN: 'remote-signer-smoke-token',
    OUTBOUND_SIGNER_AGENT_ID: 'agent-launch-intel',
    OUTBOUND_SIGNER_COMMAND: 'fetch_browserbase_page',
    OUTBOUND_ADMIN_TOKEN: 'agent-outbound-smoke-token',
    OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
    MAX_OUTBOUND_PER_CALL_USD: '0.01',
    MAX_OUTBOUND_DAILY_USD: '0.05',
  });
  const reportStore = new ReportStore(join(tempDir, 'reports.json'));
  const paymentLedger = new PaymentLedger(join(tempDir, 'payment-events.json'));
  agentServer = createServer(createAgentApp({
    config: agentConfig,
    store: reportStore,
    paymentLedger,
  }));
  await listen(agentServer);
  const agentBaseUrl = `http://127.0.0.1:${agentServer.address().port}`;

  const response = await fetch(`${agentBaseUrl}/v1/admin/outbound/browserbase-fetch`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer agent-outbound-smoke-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ confirm: 'run-one-outbound-payment' }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'remote_signer');
  assert.equal(body.signer_response.ok, true);
  assert.equal(body.signer_response.approval.operation, 'mpp_fetch');
  assert.equal(body.signer_response.fetch_result.provider, 'mock');
  assert.equal(body.signer_response.fetch_result.mode, 'mock_mpp_fetch');
  assert.equal(body.signer_response.fetch_result.amount_base_units, '10000');

  await signerLedger.load();
  const approvedRecord = signerLedger.records.find((record) => record.status === 'approved');
  assert.ok(approvedRecord, 'signer ledger did not record approved remote fetch');
  assert.equal(approvedRecord.amount_base_units, '10000');
  assert.equal(approvedRecord.response.approval.operation, 'mpp_fetch');

  console.log(JSON.stringify({
    ok: true,
    agent_base_url: agentBaseUrl,
    signer_base_url: signerBaseUrl,
    provider: body.provider,
    signer_result_mode: body.signer_response.fetch_result.mode,
    approved_amount_base_units: approvedRecord.amount_base_units,
    note: 'Local e2e only. No real payment, no Turnkey credentials, and no outbound MPP call were used.',
  }, null, 2));
} finally {
  if (agentServer) {
    await close(agentServer);
  }
  if (signerServer) {
    await close(signerServer);
  }
  await rm(tempDir, { recursive: true, force: true });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
