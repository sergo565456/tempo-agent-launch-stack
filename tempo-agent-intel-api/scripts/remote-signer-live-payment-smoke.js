import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createAgentApp } from '../src/app.js';
import { getConfig as getAgentConfig } from '../src/config.js';
import { ReportStore } from '../src/storage/reportStore.js';
import { createApp as createSignerApp } from '../../tempo-outbound-signer/src/app.js';
import { getConfig as getSignerConfig } from '../../tempo-outbound-signer/src/config.js';
import { SignerLedger } from '../../tempo-outbound-signer/src/ledger.js';
import { createSigningProvider } from '../../tempo-outbound-signer/src/providers/index.js';
import { runPublicOutboundLivePayment } from './public-outbound-live-payment.js';

const tempDir = await mkdtemp(join(tmpdir(), 'agent-remote-signer-live-payment-'));
let signerServer;
let agentServer;

try {
  const signerConfig = getSignerConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    SIGNER_PROVIDER: 'mock',
    SIGNER_ADMIN_TOKEN: 'remote-signer-live-smoke-token',
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
    OUTBOUND_ADMIN_TOKEN: 'agent-outbound-live-smoke-token',
    OUTBOUND_LIVE_PAYMENTS: 'true',
    OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
    OUTBOUND_SIGNER_BASE_URL: signerBaseUrl,
    OUTBOUND_SIGNER_ADMIN_TOKEN: 'remote-signer-live-smoke-token',
    OUTBOUND_SIGNER_AGENT_ID: 'agent-launch-intel',
    OUTBOUND_SIGNER_COMMAND: 'fetch_browserbase_page',
    OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
    MAX_OUTBOUND_PER_CALL_USD: '0.01',
    MAX_OUTBOUND_DAILY_USD: '0.05',
  });
  const reportStore = new ReportStore(join(tempDir, 'reports.json'));
  agentServer = createServer(createAgentApp({
    config: agentConfig,
    store: reportStore,
  }));
  await listen(agentServer);
  const agentBaseUrl = `http://127.0.0.1:${agentServer.address().port}`;

  const summary = await runPublicOutboundLivePayment({
    baseUrl: agentBaseUrl,
    adminToken: 'agent-outbound-live-smoke-token',
    signerAdminToken: 'remote-signer-live-smoke-token',
    idempotencyKey: 'local-live-payment-smoke-001',
    confirmLivePayment: true,
    verifySignerLedger: true,
    allowHttp: true,
    expectedService: 'mpp.browserbase.com',
    expectedCommand: 'fetch_browserbase_page',
    expectedEndpoint: 'https://mpp.browserbase.com/fetch',
    expectedRecipient: '0x9d27dc344b981264208583a6fc88b8c137d9e4b3',
    expectedCurrency: '0x20c000000000000000000000b9537d11c60e8b50',
    expectedChainId: 4217,
    expectedAmountBaseUnits: '1000',
  });

  await signerLedger.load();
  const approvedRecord = signerLedger.records.find((record) => record.status === 'approved');
  if (!approvedRecord) {
    throw new Error('signer ledger did not record approved mock fetch');
  }

  console.log(JSON.stringify({
    ...summary,
    signer_base_url: signerBaseUrl,
    signer_ledger_amount_base_units: approvedRecord.amount_base_units,
    note: 'Local mock execution only. No real payment, no Turnkey credentials, and no outbound MPP network payment were used.',
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
