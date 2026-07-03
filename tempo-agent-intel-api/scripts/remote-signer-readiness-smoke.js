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
import { runPublicOutboundReadinessSmoke } from './public-outbound-readiness-smoke.js';

const tempDir = await mkdtemp(join(tmpdir(), 'agent-remote-signer-readiness-'));
let signerServer;
let agentServer;

try {
  const signerConfig = getSignerConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    SIGNER_PROVIDER: 'mock',
    SIGNER_ADMIN_TOKEN: 'remote-signer-readiness-token',
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
    OUTBOUND_ADMIN_TOKEN: 'agent-outbound-readiness-token',
    OUTBOUND_LIVE_PAYMENTS: 'true',
    OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
    OUTBOUND_SIGNER_BASE_URL: signerBaseUrl,
    OUTBOUND_SIGNER_ADMIN_TOKEN: 'remote-signer-readiness-token',
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

  const summary = await runPublicOutboundReadinessSmoke({
    baseUrl: agentBaseUrl,
    adminToken: 'agent-outbound-readiness-token',
    expectPaymentMode: 'mock',
    requireOutboundReady: true,
    allowHttp: true,
  });

  console.log(JSON.stringify({
    ...summary,
    signer_base_url: signerBaseUrl,
    note: 'Local read-only e2e only. No report, payment, signing, or outbound MPP fetch route was called.',
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
