import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicListingReadiness } from '../scripts/public-listing-readiness.js';

describe('public listing readiness', () => {
  it('accepts verified payment evidence and complete discovery surfaces', async () => {
    const calls = [];
    const summary = await runPublicListingReadiness(baseOptions(), makeDeps(calls));

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.ready_for_listing, true);
    assert.deepEqual(summary.blockers, []);
    assert.equal(summary.launch_stage, 'ready_for_listing_review');
    assert.equal(summary.discovery.paid_endpoint_count, 4);
    assert.equal(summary.discovery.tempo_standard_prices_usd['/v1/analyze'], '0.01');
    assert.equal(summary.pricing.expected_standard_price_usd, '0.01');
    assert.equal(summary.next_manual_boundary, 'Owner review and manual submission to MPP directories/listings. Do not submit automatically.');
    assert.equal(calls.map((call) => call.name).join(','), 'nextStep,GET /health,GET /openapi.json,GET /llms.txt,GET /.well-known/agent-card.json,GET /.well-known/x402');
  });

  it('returns blockers when discovery is incomplete', async () => {
    const calls = [];
    const summary = await runPublicListingReadiness(baseOptions(), makeDeps(calls, {
      incompleteDiscovery: true,
    }));

    assert.equal(summary.ok, false);
    assert.equal(summary.ready_for_listing, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes('durable agent storage')));
    assert.ok(summary.blockers.some((blocker) => blocker.includes('outbound_live_payments=true')));
    assert.ok(summary.blockers.some((blocker) => blocker.includes('x-payment-info')));
  });

  it('blocks listing when public discovery advertises a stale expensive price', async () => {
    const calls = [];
    const summary = await runPublicListingReadiness(baseOptions(), makeDeps(calls, {
      staleExpensivePrice: true,
    }));

    assert.equal(summary.ok, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes('listing price must be 0.01 USD, got 2.00')));
  });

  it('returns blockers when launch evidence is not at listing stage', async () => {
    const calls = [];
    const summary = await runPublicListingReadiness(baseOptions(), makeDeps(calls, {
      stage: 'awaiting_authorized_cron_verification',
    }));

    assert.equal(summary.ok, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes('ready_for_listing_review')));
    assert.ok(summary.blockers.some((blocker) => blocker.includes('Authorized cron payment reconciliation')));
  });

  it('rejects admin token leaks from composed evidence or discovery', async () => {
    await assert.rejects(
      () => runPublicListingReadiness(baseOptions(), makeDeps([], { leakFromNextStep: true })),
      /public live next-step listing evidence leaked an admin or cron token/,
    );

    await assert.rejects(
      () => runPublicListingReadiness(baseOptions(), makeDeps([], { leakFromDiscovery: true })),
      /public listing discovery \/health leaked an admin or cron token/,
    );
  });
});

function baseOptions() {
  return {
    agentUrl: 'http://agent.local',
    signerUrl: 'http://signer.local',
    agentAdminToken: 'agent-admin-token',
    signerAdminToken: 'signer-admin-token',
    inboundIdempotencyKey: 'public-live-tempo-inbound-001',
    expectedCronIdempotencyKey: 'cron-browserbase-fetch-2026-06-07',
    allowHttp: true,
  };
}

function makeDeps(calls, options = {}) {
  return {
    async runPublicLiveNextStep(input) {
      calls.push({ name: 'nextStep', options: input });
      return {
        ok: true,
        read_only: true,
        stage: options.stage || 'ready_for_listing_review',
        checks: {
          inbound_reconciliation: {
            ok: true,
            report_id: 'rpt_live_001',
          },
          manual_outbound_reconciliation: {
            ok: true,
            idempotency_key: 'first-live-browserbase-001',
          },
          authorized_cron_reconciliation: options.stage
            ? null
            : {
              ok: true,
              idempotency_key: input.expectedCronIdempotencyKey,
            },
        },
        ...(options.leakFromNextStep ? { leaked: 'agent-admin-token' } : {}),
      };
    },
    async request(url) {
      calls.push({ name: `GET ${url.pathname}` });
      const body = buildDiscoveryBody(url.pathname, options);
      const text = JSON.stringify(body) + (options.leakFromDiscovery && url.pathname === '/health' ? ' agent-admin-token' : '');
      return {
        status: 200,
        body,
        text,
      };
    },
  };
}

function buildDiscoveryBody(path, options) {
  if (path === '/health') {
    return {
      status: 'ok',
      payment_mode: 'tempo',
      outbound_live_payments: !options.incompleteDiscovery,
      storage: {
        durable_configured: !options.incompleteDiscovery,
      },
    };
  }
  if (path === '/openapi.json') {
    const operation = options.incompleteDiscovery
      ? { post: {} }
      : {
        post: {
          'x-payment-info': {
            offers: [{
              method: 'tempo',
              amount: options.staleExpensivePrice ? '2000000' : '10000',
              amount_usd: options.staleExpensivePrice ? '2.00' : '0.01',
              currency: 'USDC.e',
            }],
          },
        },
      };
    return {
      paths: {
        '/v1/analyze': operation,
        '/v1/launch-readiness': operation,
        '/v1/service-diligence': operation,
        '/v1/ecosystem-fit': operation,
      },
    };
  }
  if (path === '/llms.txt') {
    return 'Agent Launch Intel API\nPayment mode: tempo\nPOST /v1/analyze';
  }
  if (path === '/.well-known/agent-card.json') {
    return {
      name: 'Agent Launch Intel API',
      payment: {
        offers: [{ method: 'tempo' }],
      },
    };
  }
  if (path === '/.well-known/x402') {
    return {
      payment: {
        offers: [{ method: 'tempo' }],
      },
      resources: ['/v1/analyze'],
    };
  }
  throw new Error(`Unexpected path ${path}`);
}
