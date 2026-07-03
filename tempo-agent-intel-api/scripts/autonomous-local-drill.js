import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createAgentApp } from '../src/app.js';
import { getConfig as getAgentConfig } from '../src/config.js';
import { ReportStore } from '../src/storage/reportStore.js';
import { PaymentLedger } from '../src/storage/paymentLedger.js';
import { createApp as createSignerApp } from '../../tempo-outbound-signer/src/app.js';
import { getConfig as getSignerConfig } from '../../tempo-outbound-signer/src/config.js';
import { SignerLedger } from '../../tempo-outbound-signer/src/ledger.js';
import { createSigningProvider } from '../../tempo-outbound-signer/src/providers/index.js';

const AGENT_ADMIN_TOKEN = 'local-autonomous-agent-admin-token';
const SIGNER_ADMIN_TOKEN = 'local-autonomous-signer-admin-token';
const CRON_SECRET = 'local-autonomous-cron-secret-32chars';
const MANUAL_OUTBOUND_IDEMPOTENCY_KEY = 'local-drill-manual-outbound-001';
const INBOUND_IDEMPOTENCY_KEY = 'local-drill-inbound-001';

export async function runAutonomousLocalDrill() {
  const tempDir = await mkdtemp(join(tmpdir(), 'tempo-autonomous-drill-'));
  let signerServer;
  let agentServer;

  try {
    const signerConfig = getSignerConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      SIGNER_PROVIDER: 'mock',
      SIGNER_ADMIN_TOKEN,
      SIGNER_LEDGER_PATH: join(tempDir, 'signer-ledger.json'),
    });
    const signerLedger = new SignerLedger(signerConfig.ledgerPath);
    signerServer = createServer(createSignerApp({
      config: signerConfig,
      ledger: signerLedger,
      provider: createSigningProvider(signerConfig),
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
      OUTBOUND_SIGNER_ADMIN_TOKEN: SIGNER_ADMIN_TOKEN,
      OUTBOUND_SIGNER_AGENT_ID: 'agent-launch-intel',
      OUTBOUND_SIGNER_COMMAND: 'fetch_browserbase_page',
      OUTBOUND_ADMIN_TOKEN: AGENT_ADMIN_TOKEN,
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      MAX_OUTBOUND_DAILY_USD: '0.05',
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET,
      OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT: 'true',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: MANUAL_OUTBOUND_IDEMPOTENCY_KEY,
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

    const unpaidInbound = await postJson(`${agentBaseUrl}/v1/analyze`, {
      headers: {
        'idempotency-key': INBOUND_IDEMPOTENCY_KEY,
      },
      body: reportRequest(),
    });
    assert.equal(unpaidInbound.status, 402);
    assert.equal(unpaidInbound.body.error, 'payment_required');

    const paidInbound = await postJson(`${agentBaseUrl}/v1/analyze`, {
      headers: {
        'x-mock-payment': 'paid',
        'idempotency-key': INBOUND_IDEMPOTENCY_KEY,
      },
      body: reportRequest(),
    });
    assert.equal(paidInbound.status, 200);
    assert.equal(paidInbound.body.payment.status, 'paid');

    const preArmCron = await getJson(`${agentBaseUrl}/api/cron/outbound/browserbase-fetch`, {
      authorization: `Bearer ${CRON_SECRET}`,
    });
    assert.equal(preArmCron.status, 503);
    assert.equal(preArmCron.body.error, 'outbound_cron_not_armed');

    const preview = await getJson(`${agentBaseUrl}/v1/admin/outbound/browserbase-fetch/preview?idempotency_key=${MANUAL_OUTBOUND_IDEMPOTENCY_KEY}`, {
      authorization: `Bearer ${AGENT_ADMIN_TOKEN}`,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.ok, true);
    assert.equal(preview.body.limits.requested_amount_base_units, '10000');

    const manualOutbound = await postJson(`${agentBaseUrl}/v1/admin/outbound/browserbase-fetch`, {
      headers: {
        authorization: `Bearer ${AGENT_ADMIN_TOKEN}`,
      },
      body: {
        confirm: 'run-one-outbound-payment',
        idempotency_key: MANUAL_OUTBOUND_IDEMPOTENCY_KEY,
      },
    });
    assert.equal(manualOutbound.status, 200);
    assert.equal(manualOutbound.body.ok, true);
    assert.equal(manualOutbound.body.signer_response.fetch_result.mode, 'mock_mpp_fetch');

    const cronReadiness = await getJson(`${agentBaseUrl}/v1/admin/outbound/cron/readiness`, {
      authorization: `Bearer ${AGENT_ADMIN_TOKEN}`,
    });
    assert.equal(cronReadiness.status, 200);
    assert.equal(cronReadiness.body.ready_to_enable, true);
    assert.equal(cronReadiness.body.ready_to_run_authorized, true);
    assert.equal(cronReadiness.body.arming.found, true);

    const cronRun = await getJson(`${agentBaseUrl}/api/cron/outbound/browserbase-fetch`, {
      authorization: `Bearer ${CRON_SECRET}`,
    });
    assert.equal(cronRun.status, 200);
    assert.equal(cronRun.body.trigger, 'vercel_cron');
    assert.equal(cronRun.body.result.signer_response.fetch_result.mode, 'mock_mpp_fetch');

    const agentEvents = await paymentLedger.list();
    await signerLedger.load();
    const signerApproved = signerLedger.records.filter((record) => record.status === 'approved');

    assert(agentEvents.some((event) => event.type === 'payment_verified' && event.idempotency_key === INBOUND_IDEMPOTENCY_KEY));
    assert(agentEvents.some((event) => event.type === 'outbound_admin_payment_succeeded' && event.idempotency_key === MANUAL_OUTBOUND_IDEMPOTENCY_KEY));
    assert(agentEvents.some((event) => event.type === 'outbound_cron_payment_succeeded' && event.idempotency_key === cronRun.body.idempotency_key));
    assert.equal(signerApproved.length, 2);
    assert.equal(JSON.stringify(agentEvents).includes(AGENT_ADMIN_TOKEN), false);
    assert.equal(JSON.stringify(agentEvents).includes(SIGNER_ADMIN_TOKEN), false);
    assert.equal(JSON.stringify(agentEvents).includes(CRON_SECRET), false);

    return {
      ok: true,
      live_actions: false,
      payment_mode: 'mock',
      signer_provider: 'mock',
      inbound: {
        unpaid_status: unpaidInbound.status,
        paid_status: paidInbound.status,
        idempotency_key: INBOUND_IDEMPOTENCY_KEY,
        report_id: paidInbound.body.report_id,
      },
      outbound_manual: {
        status: manualOutbound.status,
        idempotency_key: MANUAL_OUTBOUND_IDEMPOTENCY_KEY,
        amount_base_units: manualOutbound.body.requested_amount_base_units,
        signer_mode: manualOutbound.body.signer_response.fetch_result.mode,
      },
      cron: {
        pre_arm_status: preArmCron.status,
        readiness_ready_to_run_authorized: cronReadiness.body.ready_to_run_authorized,
        run_status: cronRun.status,
        idempotency_key: cronRun.body.idempotency_key,
      },
      ledger: {
        agent_events: agentEvents.length,
        signer_approved_records: signerApproved.length,
      },
      note: 'Local autonomous drill only. No real payment, no Turnkey credentials, no public HTTP request, no Vercel env upload, no deploy, and no outbound MPP network call were used.',
    };
  } finally {
    if (agentServer) {
      await close(agentServer);
    }
    if (signerServer) {
      await close(signerServer);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

function reportRequest() {
  return {
    target: 'Agent Launch Intel API',
    question: 'Can the agent accept a paid request and safely buy an external MPP signal?',
    depth: 'standard',
  };
}

async function postJson(url, { headers = {}, body }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runAutonomousLocalDrill();
  console.log(JSON.stringify(result, null, 2));
}
