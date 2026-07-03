import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, shouldIssuePreValidationPaymentChallenge } from '../src/app.js';
import { ReportStore } from '../src/storage/reportStore.js';
import { PaymentLedger } from '../src/storage/paymentLedger.js';
import { getConfig } from '../src/config.js';
import { buildOpenApi } from '../src/openapi.js';
import { runPublicOutboundReadinessSmoke } from '../scripts/public-outbound-readiness-smoke.js';

describe('Agent Launch Intel API', () => {
  let server;
  let baseUrl;
  let tempDir;
  let paymentLedger;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tempo-agent-intel-api-'));
    const config = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
    });
    const store = new ReportStore(join(tempDir, 'reports.json'));
    paymentLedger = new PaymentLedger(join(tempDir, 'payment-events.json'));
    server = createServer(createApp({ config, store, paymentLedger }));

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  it('serves a human-readable root page for public listings', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /Agent Launch Intel API/);
    assert.match(html, /Launch intelligence for paid agent services/);
    assert.match(html, /View OpenAPI/);
    assert.match(html, /POST \/v1\/analyze/);
    assert.match(html, /\$0\.01/);
  });

  it('serves root service index as JSON when requested by agents', async () => {
    const response = await fetch(`${baseUrl}/`, {
      headers: {
        accept: 'application/json',
      },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.name, 'Agent Launch Intel API');
    assert.equal(body.price.amount_usd, '0.01');
    assert.equal(body.discovery.openapi_json, 'http://127.0.0.1/openapi.json');
    assert.ok(body.paid_endpoints.some((endpoint) => endpoint.path === '/v1/analyze'));
  });

  it('serves HEAD checks for public listing routes', async () => {
    const routes = new Map([
      ['/', /text\/html/],
      ['/health', /application\/json/],
      ['/openapi.json', /application\/json/],
      ['/llms.txt', /text\/plain/],
      ['/.well-known/agent-card.json', /application\/json/],
      ['/.well-known/x402', /application\/json/],
    ]);

    for (const [path, contentTypePattern] of routes) {
      const response = await fetch(`${baseUrl}${path}`, { method: 'HEAD' });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), contentTypePattern);
      assert.equal(await response.text(), '');
    }
  });

  it('serves health', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'agent-launch-intel-api');
    assert.equal(body.payment_mode, 'mock');
    assert.deepEqual(body.payment_rails, ['mock']);
  });

  it('serves OpenAPI with payment discovery', async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(response.status, 200);
    const spec = await response.json();
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.info.title, 'Agent Launch Intel API');
    const paymentInfo = spec.paths['/v1/analyze'].post['x-payment-info'];
    assert.ok(paymentInfo.offers.length > 0);
    assert.equal(paymentInfo.price.mode, 'fixed');
    assert.ok(paymentInfo.protocols.length > 0);
    assert.ok(spec.paths['/v1/launch-readiness'].post['x-payment-info'].offers.length > 0);
    assert.ok(spec.paths['/v1/service-diligence'].post['x-payment-info'].offers.length > 0);
    assert.ok(spec.paths['/v1/ecosystem-fit'].post['x-payment-info'].offers.length > 0);
    assert.ok(spec.paths['/v1/analyze'].post.responses['402']);
  });

  it('serves agent discovery documents', async () => {
    const llms = await fetch(`${baseUrl}/llms.txt`);
    assert.equal(llms.status, 200);
    assert.match(await llms.text(), /Agent Launch Intel API/);

    const card = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    assert.equal(card.status, 200);
    const cardBody = await card.json();
    assert.equal(cardBody.name, 'Agent Launch Intel API');
    assert.ok(cardBody.endpoints.some((endpoint) => endpoint.path === '/v1/ecosystem-fit'));

    const x402 = await fetch(`${baseUrl}/.well-known/x402`);
    assert.equal(x402.status, 200);
    const x402Body = await x402.json();
    assert.ok(x402Body.payment.offers.length > 0);
  });

  it('builds multi-rail OpenAPI offers without enabling live payments', () => {
    const multiConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'multi',
      ENABLED_PAYMENT_RAILS: 'tempo,x402',
    });
    const spec = buildOpenApi(multiConfig);
    const methods = spec.paths['/v1/analyze'].post['x-payment-info'].offers.map((offer) => offer.method);

    assert.deepEqual(methods, ['tempo', 'x402']);
  });

  it('uses runtime temp storage by default on Vercel', () => {
    const vercelConfig = getConfig({
      VERCEL: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'https://example.vercel.app',
      PAYMENT_MODE: 'mock',
    });

    assert.match(vercelConfig.reportStorePath, /agent-launch-intel-api[\\/]+reports\.json$/);
    assert.match(vercelConfig.paymentLedgerPath, /agent-launch-intel-api[\\/]+payment-events\.json$/);
  });

  it('derives public base URL from Vercel runtime URL', () => {
    const vercelConfig = getConfig({
      VERCEL: '1',
      VERCEL_URL: 'agent-launch-intel-api-preview.vercel.app',
      HOST: '127.0.0.1',
      PORT: '0',
      PAYMENT_MODE: 'mock',
    });

    assert.equal(vercelConfig.publicBaseUrl, 'https://agent-launch-intel-api-preview.vercel.app');
  });

  it('rejects invalid analyze requests', async () => {
    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-payment': 'paid' },
      body: JSON.stringify({ target: 'Tempo', question: 'test', depth: 'invalid' }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'invalid_request');
  });

  it('returns 400 for malformed JSON instead of leaking async handler errors', async () => {
    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-payment': 'paid' },
      body: '{"target":',
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'request_error');
    assert.equal(body.message, 'Request body must be valid JSON');
  });

  it('requires mock payment before report generation', async () => {
    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'Tempo MPP',
        question: 'Should we build a paid analytical agent?',
        depth: 'standard',
      }),
    });

    assert.equal(response.status, 402);
    assert.match(response.headers.get('www-authenticate'), /Payment/);
    const body = await response.json();
    assert.equal(body.error, 'payment_required');
  });

  it('rate limits paid report routes by client before expensive payment work', async () => {
    const rateLimitConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      REPORT_RATE_LIMIT_ENABLED: 'true',
      REPORT_RATE_LIMIT_MAX: '2',
      REPORT_RATE_LIMIT_WINDOW_MS: '60000',
      REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
    });
    const rateLimitStore = new ReportStore(join(tempDir, 'rate-limit-reports.json'));
    const rateLimitServer = createServer(createApp({ config: rateLimitConfig, store: rateLimitStore }));
    await new Promise((resolve) => rateLimitServer.listen(0, '127.0.0.1', resolve));
    const rateLimitBaseUrl = `http://127.0.0.1:${rateLimitServer.address().port}`;

    const request = (clientIp) => fetch(`${rateLimitBaseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': clientIp,
      },
      body: JSON.stringify({
        target: 'Tempo MPP',
        question: 'Should we build a paid analytical agent?',
        depth: 'quick',
      }),
    });

    try {
      const first = await request('203.0.113.10');
      const second = await request('203.0.113.10');
      const third = await request('203.0.113.10');
      const otherClient = await request('203.0.113.11');

      assert.equal(first.status, 402);
      assert.equal(second.status, 402);
      assert.equal(third.status, 429);
      assert.equal(third.headers.get('retry-after'), '60');
      assert.equal((await third.json()).error, 'rate_limited');
      assert.equal(otherClient.status, 402);
    } finally {
      await new Promise((resolve) => rateLimitServer.close(resolve));
    }
  });

  it('generates and stores a mock-paid report', async () => {
    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-payment': 'paid',
        'idempotency-key': 'test-report-1',
      },
      body: JSON.stringify({
        target: 'MPPScan',
        question: 'Where is the best near-term paid agent opportunity?',
        depth: 'standard',
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('payment-receipt'), /^mock_receipt_/);
    const report = await response.json();
    assert.equal(report.payment.status, 'paid');
    assert.equal(report.report_type, 'opportunity_report');
    assert.ok(report.opportunities.length >= 2);
    assert.equal(report.outbound_spend_plan.mode, 'dry_run');

    const stored = await fetch(`${baseUrl}/v1/reports/${report.report_id}`);
    assert.equal(stored.status, 200);
    const storedBody = await stored.json();
    assert.equal(storedBody.report.report_id, report.report_id);
  });

  it('requires idempotency or receipt proof before returning live paid reports', async () => {
    const liveConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'tempo',
    });
    const liveStore = new ReportStore(join(tempDir, 'live-report-proof-reports.json'));
    await liveStore.insert({
      idempotency_key: 'live-report-proof-1',
      request_hash: 'request-hash',
      report: {
        report_id: 'rpt_live_report_proof_1',
        report_type: 'opportunity_report',
        target: 'Tempo MPP',
        question: 'Can this run live?',
        summary: 'Stored live paid report.',
        confidence: 'medium',
        generated_at: '2026-07-02T00:00:00.000Z',
      },
      metadata: {
        created_at: '2026-07-02T00:00:00.000Z',
        payment_mode: 'tempo',
        payment_method: 'tempo_mpp',
        payment_status: 'paid',
        receipt_id: 'live_receipt_1',
      },
    });
    const liveServer = createServer(createApp({ config: liveConfig, store: liveStore }));
    await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
    const liveBaseUrl = `http://127.0.0.1:${liveServer.address().port}`;

    try {
      const noProof = await fetch(`${liveBaseUrl}/v1/reports/rpt_live_report_proof_1`);
      assert.equal(noProof.status, 401);
      assert.equal((await noProof.json()).error, 'report_access_proof_required');

      const withIdempotency = await fetch(`${liveBaseUrl}/v1/reports/rpt_live_report_proof_1`, {
        headers: { 'idempotency-key': 'live-report-proof-1' },
      });
      assert.equal(withIdempotency.status, 200);
      assert.equal((await withIdempotency.json()).report.report_id, 'rpt_live_report_proof_1');

      const withReceipt = await fetch(`${liveBaseUrl}/v1/reports/rpt_live_report_proof_1?receipt_id=live_receipt_1`);
      assert.equal(withReceipt.status, 200);
    } finally {
      await new Promise((resolve) => liveServer.close(resolve));
    }
  });

  it('defaults dynamic MPP recipients to disabled unless explicitly enabled', () => {
    assert.equal(getConfig({ PAYMENT_MODE: 'mock' }).outboundSpendPolicy.allowDynamicMppRecipient, false);
    assert.equal(getConfig({
      PAYMENT_MODE: 'mock',
      OUTBOUND_ALLOW_DYNAMIC_MPP_RECIPIENT: 'true',
    }).outboundSpendPolicy.allowDynamicMppRecipient, true);
  });

  it('generates a launch readiness report through its typed endpoint', async () => {
    const response = await fetch(`${baseUrl}/v1/launch-readiness`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-payment': 'paid',
        'idempotency-key': 'launch-readiness-1',
      },
      body: JSON.stringify({
        target: 'Agent Launch Intel API',
        question: 'Is this service ready to list as an MPP/x402 paid API?',
        depth: 'standard',
      }),
    });

    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.report_type, 'launch_readiness_report');
    assert.ok(Array.isArray(report.readiness_checks));
    assert.ok(report.readiness_checks.length >= 3);
  });

  it('records payment ledger events without storing secret values', async () => {
    const events = await paymentLedger.list();

    assert.ok(events.some((event) => event.type === 'challenge_created' && event.status_code === 402));
    assert.ok(events.some((event) => event.type === 'payment_verified' && event.receipt_id?.startsWith('mock_receipt_')));
    assert.ok(!events.some((event) => JSON.stringify(event).includes('PRIVATE_KEY')));
  });

  it('serves recent payment ledger events behind admin auth', async () => {
    const ledgerConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
    });
    const ledgerStore = new ReportStore(join(tempDir, 'admin-ledger-reports.json'));
    const adminLedger = new PaymentLedger(join(tempDir, 'admin-payment-events.json'));
    await adminLedger.insert({
      type: 'payment_verified',
      report_id: 'rpt_old',
    });
    await adminLedger.insert({
      type: 'outbound_cron_payment_succeeded',
      idempotency_key: 'cron-browserbase-fetch-2026-06-07',
      amount_base_units: '10000',
    });
    const ledgerServer = createServer(createApp({
      config: ledgerConfig,
      store: ledgerStore,
      paymentLedger: adminLedger,
    }));
    await new Promise((resolve) => ledgerServer.listen(0, '127.0.0.1', resolve));
    const ledgerBaseUrl = `http://127.0.0.1:${ledgerServer.address().port}`;

    try {
      const unauthorized = await fetch(`${ledgerBaseUrl}/v1/admin/payment-events`);
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(`${ledgerBaseUrl}/v1/admin/payment-events?limit=1`, {
        headers: {
          authorization: 'Bearer test-admin-token',
        },
      });
      assert.equal(authorized.status, 200);
      const body = await authorized.json();
      assert.equal(body.ok, true);
      assert.equal(body.read_only, true);
      assert.equal(body.total_events, 2);
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].type, 'outbound_cron_payment_succeeded');
      assert.equal(JSON.stringify(body).includes('test-admin-token'), false);
    } finally {
      await new Promise((resolve) => ledgerServer.close(resolve));
    }
  });

  it('blocks scaffolded live payment modes until configured', async () => {
    const liveConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'tempo',
    });
    const liveStore = new ReportStore(join(tempDir, 'live-blocked-reports.json'));
    const liveServer = createServer(createApp({ config: liveConfig, store: liveStore }));
    await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
    const address = liveServer.address();
    const liveBaseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const response = await fetch(`${liveBaseUrl}/v1/analyze`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'live-mode-blocked-1',
        },
        body: JSON.stringify({
          target: 'Tempo MPP',
          question: 'Can this run live?',
          depth: 'quick',
        }),
      });

      assert.equal(response.status, 501);
      const body = await response.json();
      assert.equal(body.error, 'tempo_mpp_not_configured');
    } finally {
      await new Promise((resolve) => liveServer.close(resolve));
    }
  });

  it('requires idempotency keys for live paid report routes', async () => {
    const liveConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'tempo',
    });
    const liveStore = new ReportStore(join(tempDir, 'live-idempotency-reports.json'));
    const liveServer = createServer(createApp({ config: liveConfig, store: liveStore }));
    await new Promise((resolve) => liveServer.listen(0, '127.0.0.1', resolve));
    const liveBaseUrl = `http://127.0.0.1:${liveServer.address().port}`;

    try {
      const response = await fetch(`${liveBaseUrl}/v1/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: 'Tempo MPP',
          question: 'Can this run live?',
          depth: 'quick',
        }),
      });

      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'idempotency_key_required');
    } finally {
      await new Promise((resolve) => liveServer.close(resolve));
    }
  });

  it('issues a Tempo challenge before request validation only for unpaid live discovery probes', () => {
    const liveTempoConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'tempo',
      TEMPO_MPP_LIVE_ENABLED: 'true',
    });

    assert.equal(
      shouldIssuePreValidationPaymentChallenge({ headers: {} }, liveTempoConfig),
      true,
    );
    assert.equal(
      shouldIssuePreValidationPaymentChallenge({ headers: { authorization: 'Payment abc' } }, liveTempoConfig),
      false,
    );

    const mockConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
    });

    assert.equal(
      shouldIssuePreValidationPaymentChallenge({ headers: {} }, mockConfig),
      false,
    );
  });

  it('keeps outbound admin endpoint disabled without an admin token', async () => {
    const response = await fetch(`${baseUrl}/v1/admin/outbound/browserbase-fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'run-one-outbound-payment' }),
    });

    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'outbound_admin_not_configured');

    const readiness = await fetch(`${baseUrl}/v1/admin/outbound/readiness`);
    assert.equal(readiness.status, 503);
  });

  it('requires admin auth and explicit confirmation before outbound spending', async () => {
    const outboundConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
      OUTBOUND_LIVE_PAYMENTS: 'false',
    });
    const outboundStore = new ReportStore(join(tempDir, 'outbound-admin-reports.json'));
    const outboundServer = createServer(createApp({ config: outboundConfig, store: outboundStore }));
    await new Promise((resolve) => outboundServer.listen(0, '127.0.0.1', resolve));
    const address = outboundServer.address();
    const outboundBaseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const unauthorized = await fetch(`${outboundBaseUrl}/v1/admin/outbound/browserbase-fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'run-one-outbound-payment' }),
      });
      assert.equal(unauthorized.status, 401);

      const missingConfirm = await fetch(`${outboundBaseUrl}/v1/admin/outbound/browserbase-fetch`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert.equal(missingConfirm.status, 400);

      const disabled = await fetch(`${outboundBaseUrl}/v1/admin/outbound/browserbase-fetch`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ confirm: 'run-one-outbound-payment' }),
      });
      assert.equal(disabled.status, 501);
    } finally {
      await new Promise((resolve) => outboundServer.close(resolve));
    }
  });

  it('keeps outbound cron disabled by default and requires cron auth', async () => {
    const cronDisabledConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
    });
    const cronDisabledStore = new ReportStore(join(tempDir, 'cron-disabled-reports.json'));
    const cronDisabledServer = createServer(createApp({ config: cronDisabledConfig, store: cronDisabledStore }));
    await new Promise((resolve) => cronDisabledServer.listen(0, '127.0.0.1', resolve));
    const cronDisabledBaseUrl = `http://127.0.0.1:${cronDisabledServer.address().port}`;

    try {
      const disabled = await fetch(`${cronDisabledBaseUrl}/api/cron/outbound/browserbase-fetch`, {
        headers: {
          authorization: 'Bearer strong-cron-secret-with-32-chars',
        },
      });
      assert.equal(disabled.status, 503);
      assert.equal((await disabled.json()).error, 'outbound_cron_disabled');
    } finally {
      await new Promise((resolve) => cronDisabledServer.close(resolve));
    }

    const cronAuthConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      ENABLE_OUTBOUND_CRON: 'true',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
    });
    const cronAuthStore = new ReportStore(join(tempDir, 'cron-auth-reports.json'));
    const cronAuthServer = createServer(createApp({ config: cronAuthConfig, store: cronAuthStore }));
    await new Promise((resolve) => cronAuthServer.listen(0, '127.0.0.1', resolve));
    const cronAuthBaseUrl = `http://127.0.0.1:${cronAuthServer.address().port}`;

    try {
      const unauthorized = await fetch(`${cronAuthBaseUrl}/api/cron/outbound/browserbase-fetch`);
      assert.equal(unauthorized.status, 401);
      assert.equal((await unauthorized.json()).error, 'unauthorized');
    } finally {
      await new Promise((resolve) => cronAuthServer.close(resolve));
    }
  });

  it('refuses outbound cron spend until a verified manual outbound payment arms it', async () => {
    let signerCalled = false;
    const signerServer = createServer(async (_req, res) => {
      signerCalled = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const cronConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: 'first-live-browserbase-001',
    });
    const cronStore = new ReportStore(join(tempDir, 'cron-not-armed-reports.json'));
    const cronPaymentLedger = new PaymentLedger(join(tempDir, 'cron-not-armed-payment-events.json'));
    const cronServer = createServer(createApp({
      config: cronConfig,
      store: cronStore,
      paymentLedger: cronPaymentLedger,
    }));
    await new Promise((resolve) => cronServer.listen(0, '127.0.0.1', resolve));
    const cronBaseUrl = `http://127.0.0.1:${cronServer.address().port}`;

    try {
      const response = await fetch(`${cronBaseUrl}/api/cron/outbound/browserbase-fetch`, {
        headers: {
          authorization: 'Bearer strong-cron-secret-with-32-chars',
        },
      });

      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error, 'outbound_cron_not_armed');
      assert.equal(body.required_idempotency_key, 'first-live-browserbase-001');
      assert.equal(signerCalled, false);
      assert.equal((await cronPaymentLedger.list()).length, 0);
    } finally {
      await new Promise((resolve) => cronServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('serves outbound cron readiness behind admin auth without calling signer', async () => {
    let signerCalled = false;
    const signerServer = createServer(async (_req, res) => {
      signerCalled = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const cronConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: 'first-live-browserbase-001',
    });
    const cronStore = new ReportStore(join(tempDir, 'cron-readiness-reports.json'));
    const cronPaymentLedger = new PaymentLedger(join(tempDir, 'cron-readiness-payment-events.json'));
    await cronPaymentLedger.insert(verifiedManualOutboundEvent('first-live-browserbase-001'));
    const cronServer = createServer(createApp({
      config: cronConfig,
      store: cronStore,
      paymentLedger: cronPaymentLedger,
    }));
    await new Promise((resolve) => cronServer.listen(0, '127.0.0.1', resolve));
    const cronBaseUrl = `http://127.0.0.1:${cronServer.address().port}`;

    try {
      const unauthorized = await fetch(`${cronBaseUrl}/v1/admin/outbound/cron/readiness`);
      assert.equal(unauthorized.status, 401);

      const response = await fetch(`${cronBaseUrl}/v1/admin/outbound/cron/readiness`, {
        headers: {
          authorization: 'Bearer test-admin-token',
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.read_only, true);
      assert.equal(body.ready_to_enable, true);
      assert.equal(body.ready_to_run_authorized, true);
      assert.equal(body.cron.enabled, true);
      assert.equal(body.cron.secret_configured, true);
      assert.equal(body.cron.strong_secret_configured, true);
      assert.match(body.cron.next_idempotency_key, /^cron-browserbase-fetch-\d{4}-\d{2}-\d{2}$/);
      assert.equal(body.cron.arming_idempotency_key, 'first-live-browserbase-001');
      assert.equal(body.outbound.preview_ok, true);
      assert.equal(body.arming.found, true);
      assert.match(body.arming.event_id, /^payevt_/);
      assert.equal(body.arming.trigger, 'admin_manual');
      assert.equal(body.arming.idempotency_key, 'first-live-browserbase-001');
      assert.equal(body.arming.amount_base_units, '10000');
      assert.equal(signerCalled, false);

      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes('test-admin-token'), false);
      assert.equal(serialized.includes('test-signer-token'), false);
      assert.equal(serialized.includes('strong-cron-secret-with-32-chars'), false);
    } finally {
      await new Promise((resolve) => cronServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('reports outbound cron readiness blockers without calling signer when not armed', async () => {
    let signerCalled = false;
    const signerServer = createServer(async (_req, res) => {
      signerCalled = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const cronConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: 'first-live-browserbase-001',
    });
    const cronStore = new ReportStore(join(tempDir, 'cron-readiness-not-armed-reports.json'));
    const cronPaymentLedger = new PaymentLedger(join(tempDir, 'cron-readiness-not-armed-payment-events.json'));
    const cronServer = createServer(createApp({
      config: cronConfig,
      store: cronStore,
      paymentLedger: cronPaymentLedger,
    }));
    await new Promise((resolve) => cronServer.listen(0, '127.0.0.1', resolve));
    const cronBaseUrl = `http://127.0.0.1:${cronServer.address().port}`;

    try {
      const response = await fetch(`${cronBaseUrl}/v1/admin/outbound/cron/readiness`, {
        headers: {
          authorization: 'Bearer test-admin-token',
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.read_only, true);
      assert.equal(body.ready_to_enable, false);
      assert.equal(body.ready_to_run_authorized, false);
      assert.equal(body.arming.found, false);
      assert.equal(body.arming.expected_idempotency_key, 'first-live-browserbase-001');
      assert.ok(body.blockers.some((blocker) => blocker.includes('No matching successful manual outbound payment event')));
      assert.equal(signerCalled, false);
    } finally {
      await new Promise((resolve) => cronServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('runs outbound cron through the remote signer with a daily idempotency key', async () => {
    let signerRequest = null;
    const signerServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      signerRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        approval: {
          operation: 'mpp_fetch',
          amount_base_units: signerRequest.body.amount_base_units,
        },
        fetch_result: {
          provider: 'turnkey',
          mode: 'turnkey_mpp_fetch',
          receipt: { reference: 'tx_fake_cron_remote_signer' },
        },
      }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const cronConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: 'first-live-browserbase-001',
    });
    const cronStore = new ReportStore(join(tempDir, 'cron-remote-signer-reports.json'));
    const cronPaymentLedger = new PaymentLedger(join(tempDir, 'cron-remote-signer-payment-events.json'));
    await cronPaymentLedger.insert(verifiedManualOutboundEvent('first-live-browserbase-001'));
    const cronServer = createServer(createApp({
      config: cronConfig,
      store: cronStore,
      paymentLedger: cronPaymentLedger,
    }));
    await new Promise((resolve) => cronServer.listen(0, '127.0.0.1', resolve));
    const cronBaseUrl = `http://127.0.0.1:${cronServer.address().port}`;

    try {
      const response = await fetch(`${cronBaseUrl}/api/cron/outbound/browserbase-fetch`, {
        headers: {
          authorization: 'Bearer strong-cron-secret-with-32-chars',
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.trigger, 'vercel_cron');
      assert.match(body.idempotency_key, /^cron-browserbase-fetch-\d{4}-\d{2}-\d{2}$/);
      assert.match(body.ledger_event_id, /^payevt_/);
      assert.equal(body.result.ok, true);
      assert.equal(signerRequest.method, 'POST');
      assert.equal(signerRequest.url, '/v1/agents/agent-launch-intel/mpp/fetch');
      assert.equal(signerRequest.authorization, 'Bearer test-signer-token');
      assert.equal(signerRequest.body.idempotency_key, body.idempotency_key);
      assert.equal(signerRequest.body.confirm, 'fetch-one-mpp-endpoint');
      assert.equal(signerRequest.body.amount_base_units, '10000');

      const events = await cronPaymentLedger.list();
      assert.equal(events.length, 2);
      const cronEvent = events.find((event) => event.type === 'outbound_cron_payment_succeeded');
      assert.equal(cronEvent.event_id, body.ledger_event_id);
      assert.equal(cronEvent.idempotency_key, body.idempotency_key);
      assert.equal(cronEvent.amount_base_units, '10000');
      assert.equal(cronEvent.receipt_reference, 'tx_fake_cron_remote_signer');
      assert.equal(JSON.stringify(events).includes('strong-cron-secret-with-32-chars'), false);
      assert.equal(JSON.stringify(events).includes('test-signer-token'), false);
    } finally {
      await new Promise((resolve) => cronServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('records outbound cron signer failures in the payment ledger', async () => {
    const signerServer = createServer(async (_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'downstream_unavailable',
        message: 'fake signer outage',
      }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const cronConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: 'first-live-browserbase-001',
    });
    const cronStore = new ReportStore(join(tempDir, 'cron-failed-remote-signer-reports.json'));
    const cronPaymentLedger = new PaymentLedger(join(tempDir, 'cron-failed-remote-signer-payment-events.json'));
    await cronPaymentLedger.insert(verifiedManualOutboundEvent('first-live-browserbase-001'));
    const cronServer = createServer(createApp({
      config: cronConfig,
      store: cronStore,
      paymentLedger: cronPaymentLedger,
    }));
    await new Promise((resolve) => cronServer.listen(0, '127.0.0.1', resolve));
    const cronBaseUrl = `http://127.0.0.1:${cronServer.address().port}`;

    try {
      const response = await fetch(`${cronBaseUrl}/api/cron/outbound/browserbase-fetch`, {
        headers: {
          authorization: 'Bearer strong-cron-secret-with-32-chars',
        },
      });

      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error, 'outbound_cron_payment_failed');
      assert.match(body.ledger_event_id, /^payevt_/);

      const events = await cronPaymentLedger.list();
      assert.equal(events.length, 2);
      const failedCronEvent = events.find((event) => event.type === 'outbound_cron_payment_failed');
      assert.equal(failedCronEvent.event_id, body.ledger_event_id);
      assert.equal(failedCronEvent.status_code, 502);
      assert.match(failedCronEvent.error, /fake signer outage/);
      assert.equal(JSON.stringify(events).includes('strong-cron-secret-with-32-chars'), false);
      assert.equal(JSON.stringify(events).includes('test-signer-token'), false);
    } finally {
      await new Promise((resolve) => cronServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('runs outbound spending through the remote signer provider', async () => {
    let signerRequest = null;
    const signerServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      signerRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        approval: {
          operation: 'mpp_fetch',
          amount_base_units: signerRequest.body.amount_base_units,
        },
        fetch_result: {
          provider: 'turnkey',
          mode: 'turnkey_mpp_fetch',
          receipt: { reference: 'tx_fake_remote_signer' },
        },
      }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const outboundConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    });
    const outboundStore = new ReportStore(join(tempDir, 'remote-signer-outbound-reports.json'));
    const outboundPaymentLedger = new PaymentLedger(join(tempDir, 'remote-signer-outbound-payment-events.json'));
    const outboundServer = createServer(createApp({
      config: outboundConfig,
      store: outboundStore,
      paymentLedger: outboundPaymentLedger,
    }));
    await new Promise((resolve) => outboundServer.listen(0, '127.0.0.1', resolve));
    const outboundBaseUrl = `http://127.0.0.1:${outboundServer.address().port}`;

    try {
      const response = await fetch(`${outboundBaseUrl}/v1/admin/outbound/browserbase-fetch`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          confirm: 'run-one-outbound-payment',
          idempotency_key: 'previewed-live-key',
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.match(body.ledger_event_id, /^payevt_/);
      assert.equal(body.provider, 'remote_signer');
      assert.equal(body.signer_response.fetch_result.mode, 'turnkey_mpp_fetch');
      assert.equal(signerRequest.method, 'POST');
      assert.equal(signerRequest.url, '/v1/agents/agent-launch-intel/mpp/fetch');
      assert.equal(signerRequest.authorization, 'Bearer test-signer-token');
      assert.equal(signerRequest.body.confirm, 'fetch-one-mpp-endpoint');
      assert.equal(signerRequest.body.idempotency_key, 'previewed-live-key');
      assert.equal(signerRequest.body.command, 'fetch_browserbase_page');
      assert.equal(signerRequest.body.amount_base_units, '10000');

      const events = await outboundPaymentLedger.list();
      assert.equal(events.length, 1);
      assert.equal(events[0].event_id, body.ledger_event_id);
      assert.equal(events[0].type, 'outbound_admin_payment_succeeded');
      assert.equal(events[0].idempotency_key, 'previewed-live-key');
      assert.equal(events[0].receipt_reference, 'tx_fake_remote_signer');
      assert.equal(JSON.stringify(events).includes('test-admin-token'), false);
      assert.equal(JSON.stringify(events).includes('test-signer-token'), false);
    } finally {
      await new Promise((resolve) => outboundServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('previews outbound remote signer payment request without calling signer', async () => {
    const outboundConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: 'https://signer.example',
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    });
    const outboundStore = new ReportStore(join(tempDir, 'remote-signer-preview-reports.json'));
    const outboundServer = createServer(createApp({ config: outboundConfig, store: outboundStore }));
    await new Promise((resolve) => outboundServer.listen(0, '127.0.0.1', resolve));
    const outboundBaseUrl = `http://127.0.0.1:${outboundServer.address().port}`;

    try {
      const response = await fetch(`${outboundBaseUrl}/v1/admin/outbound/browserbase-fetch/preview?idempotency_key=previewed-live-key`, {
        headers: {
          authorization: 'Bearer test-admin-token',
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.read_only, true);
      assert.equal(body.signer_admin_token_configured, true);
      assert.equal(body.request.method, 'POST');
      assert.equal(body.request.url, 'https://signer.example/v1/agents/agent-launch-intel/mpp/fetch');
      assert.equal(body.request.body.confirm, 'fetch-one-mpp-endpoint');
      assert.equal(body.request.body.idempotency_key, 'previewed-live-key');
      assert.equal(body.request.body.endpoint, 'https://mpp.browserbase.com/fetch');
      assert.equal(body.request.body.amount_base_units, '10000');
      assert.equal(body.limits.max_amount_base_units, '10000');
      assert.deepEqual(body.blockers, []);
      assert.equal(JSON.stringify(body).includes('test-signer-token'), false);
      assert.match(body.note, /No signer request/);
    } finally {
      await new Promise((resolve) => outboundServer.close(resolve));
    }
  });

  it('checks outbound remote signer readiness without calling payment routes', async () => {
    const signerRequests = [];
    const signerServer = createServer(async (req, res) => {
      signerRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          provider: 'mock',
          agent_count: 1,
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/readiness') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          provider: 'mock',
          admin_token_configured: true,
          turnkey: {
            organization_configured: false,
            api_public_key_configured: false,
            api_private_key_configured: false,
            policy_configured: false,
            sign_with_mode: 'wallet',
          },
          ledger: {
            backend: 'upstash_redis',
            durable_configured: true,
          },
          admin_rate_limit: {
            enabled: true,
            max: 60,
            window_ms: 60000,
          },
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/agents' && req.headers.authorization === 'Bearer test-signer-token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          agents: [
            {
              agent_id: 'agent-launch-intel',
              enabled: true,
              wallet_address: '0x1111111111111111111111111111111111111111',
              tempo_access_key_address: '0x2222222222222222222222222222222222222222',
              per_call_limit_base_units: '10000',
              daily_limit_base_units: '50000',
              allowed_services: ['mpp.browserbase.com'],
              allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
              allowed_recipients: ['0x9d27dc344b981264208583a6fc88b8c137d9e4b3'],
              allowed_commands: ['fetch_browserbase_page'],
            },
          ],
        }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const outboundConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    });
    const outboundStore = new ReportStore(join(tempDir, 'remote-signer-readiness-reports.json'));
    const outboundServer = createServer(createApp({ config: outboundConfig, store: outboundStore }));
    await new Promise((resolve) => outboundServer.listen(0, '127.0.0.1', resolve));
    const outboundBaseUrl = `http://127.0.0.1:${outboundServer.address().port}`;

    try {
      const response = await fetch(`${outboundBaseUrl}/v1/admin/outbound/readiness`, {
        headers: {
          authorization: 'Bearer test-admin-token',
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.read_only, true);
      assert.equal(body.remote_signer.health.ok, true);
      assert.equal(body.remote_signer.readiness.ok, true);
      assert.equal(body.remote_signer.readiness.ledger.backend, 'upstash_redis');
      assert.equal(body.remote_signer.readiness.ledger.durable_configured, true);
      assert.deepEqual(body.remote_signer.readiness.admin_rate_limit, {
        enabled: true,
        max: 60,
        window_ms: 60000,
      });
      assert.equal(body.remote_signer.agent_policy.found, true);
      assert.equal(JSON.stringify(body).includes('test-signer-token'), false);
      assert.deepEqual(
        signerRequests.map((request) => `${request.method} ${request.url}`).sort(),
        ['GET /health', 'GET /v1/readiness', 'GET /v1/agents'].sort(),
      );
      assert.equal(
        signerRequests.some((request) => request.method !== 'GET'),
        false,
      );
    } finally {
      await new Promise((resolve) => outboundServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('can require durable storage in public outbound readiness smoke', async () => {
    const signerServer = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', provider: 'mock', agent_count: 1 }));
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/readiness') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          provider: 'mock',
          admin_token_configured: true,
          turnkey: {},
          ledger: {
            backend: 'upstash_redis',
            durable_configured: true,
          },
          admin_rate_limit: {
            enabled: true,
            max: 60,
            window_ms: 60000,
          },
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/agents' && req.headers.authorization === 'Bearer test-signer-token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          agents: [
            {
              agent_id: 'agent-launch-intel',
              enabled: true,
              wallet_address: '0x1111111111111111111111111111111111111111',
              tempo_access_key_address: '0x2222222222222222222222222222222222222222',
              per_call_limit_base_units: '10000',
              daily_limit_base_units: '50000',
              allowed_services: ['mpp.browserbase.com'],
              allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
              allowed_recipients: ['0x9d27dc344b981264208583a6fc88b8c137d9e4b3'],
              allowed_commands: ['fetch_browserbase_page'],
            },
          ],
        }));
        return;
      }

      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise((resolve) => signerServer.listen(0, '127.0.0.1', resolve));

    const outboundConfig = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
      OUTBOUND_ADMIN_TOKEN: 'test-admin-token',
      OUTBOUND_LIVE_PAYMENTS: 'true',
      OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
      OUTBOUND_SIGNER_BASE_URL: `http://127.0.0.1:${signerServer.address().port}`,
      OUTBOUND_SIGNER_ADMIN_TOKEN: 'test-signer-token',
      OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
      MAX_OUTBOUND_PER_CALL_USD: '0.01',
      OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    });
    const outboundStore = new ReportStore(join(tempDir, 'remote-signer-durable-readiness-reports.json'));
    const outboundServer = createServer(createApp({ config: outboundConfig, store: outboundStore }));
    await new Promise((resolve) => outboundServer.listen(0, '127.0.0.1', resolve));
    const outboundBaseUrl = `http://127.0.0.1:${outboundServer.address().port}`;

    try {
      const summary = await runPublicOutboundReadinessSmoke({
        baseUrl: outboundBaseUrl,
        adminToken: 'test-admin-token',
        expectPaymentMode: 'mock',
        requireOutboundReady: true,
        requireDurableSignerLedger: true,
        requireSignerAdminRateLimit: true,
        allowHttp: true,
      });
      assert.equal(summary.outbound_readiness.signer_ledger_backend, 'upstash_redis');
      assert.deepEqual(summary.outbound_readiness.signer_admin_rate_limit, {
        enabled: true,
        max: 60,
        window_ms: 60000,
      });
      assert.equal(summary.health.storage_backend, 'file');

      await assert.rejects(
        runPublicOutboundReadinessSmoke({
          baseUrl: outboundBaseUrl,
          adminToken: 'test-admin-token',
          requireOutboundReady: true,
          requireDurableStorage: true,
          requireDurableSignerLedger: true,
          allowHttp: true,
        }),
        /agent storage is not durable/,
      );
    } finally {
      await new Promise((resolve) => outboundServer.close(resolve));
      await new Promise((resolve) => signerServer.close(resolve));
    }
  });

  it('uses idempotency to avoid duplicate reports', async () => {
    const payload = {
      target: 'auto.exchange',
      question: 'Can listed agents earn through Tempo/MPP?',
      depth: 'quick',
    };

    const first = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-payment': 'paid',
        'idempotency-key': 'idem-1',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 200);
    const firstReport = await first.json();

    const second = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-payment': 'paid',
        'idempotency-key': 'idem-1',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-report-cache'), 'idempotent-replay');
    const secondReport = await second.json();

    assert.equal(secondReport.report_id, firstReport.report_id);
  });

  it('detects idempotency conflicts', async () => {
    const response = await fetch(`${baseUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-payment': 'paid',
        'idempotency-key': 'idem-1',
      },
      body: JSON.stringify({
        target: 'different target',
        question: 'Can listed agents earn through Tempo/MPP?',
        depth: 'quick',
      }),
    });

    assert.equal(response.status, 409);
  });
});

function verifiedManualOutboundEvent(idempotencyKey) {
  return {
    type: 'outbound_admin_payment_succeeded',
    trigger: 'admin_manual',
    idempotency_key: idempotencyKey,
    payment_provider: 'remote_signer',
    signer_agent_id: 'agent-launch-intel',
    signer_command: 'fetch_browserbase_page',
    service: 'mpp.browserbase.com',
    endpoint: 'https://mpp.browserbase.com/fetch',
    amount_base_units: '10000',
    receipt_reference: 'tx_fake_first_manual_outbound',
  };
}
