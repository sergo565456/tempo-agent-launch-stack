import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicLiveLaunchOrchestrator } from '../scripts/public-live-launch-orchestrator.js';

describe('public live launch orchestrator', () => {
  it('runs only read-only checks by default', async () => {
    const calls = [];
    const summary = await runPublicLiveLaunchOrchestrator(baseOptions(), makeDeps(calls));

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.checks.go_live_readiness.ok, true);
    assert.equal(summary.checks.outbound_preview.read_only, true);
    assert.equal(summary.checks.outbound_execution, null);
    assert.equal(summary.checks.authorized_cron_run, null);
    assert.equal(calls.map((call) => call.name).join(','), 'goLive,outbound');
    assert.equal(calls[1].options.previewOnly, true);
    assert.equal(calls[1].options.confirmLivePayment, undefined);
  });

  it('executes the outbound live payment only with the explicit outbound confirmation flag', async () => {
    const calls = [];
    const summary = await runPublicLiveLaunchOrchestrator({
      ...baseOptions(),
      confirmLiveOutboundPayment: true,
      verifySignerLedger: true,
    }, makeDeps(calls));

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, false);
    assert.equal(summary.live_actions, true);
    assert.equal(summary.checks.outbound_execution.idempotency_key, 'first-live-browserbase-001');
    assert.equal(summary.checks.cron_arming_readiness.ok, true);
    assert.equal(calls.map((call) => call.name).join(','), 'goLive,outbound,outbound,cronArming');
    assert.equal(calls[2].options.confirmLivePayment, true);
    assert.equal(calls[2].options.verifySignerLedger, true);
  });

  it('executes authorized cron only with the explicit cron confirmation flag', async () => {
    const calls = [];
    const summary = await runPublicLiveLaunchOrchestrator({
      ...baseOptions(),
      confirmLiveCronRun: true,
      cronSecret: 'cron-secret-token',
      expectedCronIdempotencyKey: 'cron-browserbase-fetch-2026-06-07',
    }, makeDeps(calls));

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, false);
    assert.equal(summary.live_actions, true);
    assert.equal(summary.checks.authorized_cron_run.idempotency_key, 'cron-browserbase-fetch-2026-06-07');
    assert.equal(calls.at(-1).name, 'cronRun');
    assert.equal(calls.at(-1).options.confirmLiveCronRun, true);
  });

  it('rejects secret leaks from composed summaries', async () => {
    const calls = [];
    await assert.rejects(
      () => runPublicLiveLaunchOrchestrator(baseOptions(), makeDeps(calls, {
        leakAgentToken: true,
      })),
      /public live launch orchestrator .* leaked an admin or cron token/,
    );
  });
});

function baseOptions() {
  return {
    agentUrl: 'http://agent.local',
    signerUrl: 'http://signer.local',
    agentAdminToken: 'agent-admin-token',
    signerAdminToken: 'signer-admin-token',
    allowHttp: true,
  };
}

function makeDeps(calls, options = {}) {
  return {
    async runPublicAutonomousGoLiveReadiness(input) {
      calls.push({ name: 'goLive', options: input });
      return {
        ok: true,
        read_only: true,
        checks: {
          signer_production_preflight: {
            provider: 'turnkey',
            ledger_backend: 'upstash_redis',
          },
          autonomous_readiness: {
            ok: true,
            cron_ready_to_enable: false,
            cron_ready_to_run_authorized: false,
          },
        },
      };
    },
    async runPublicOutboundLivePayment(input) {
      calls.push({ name: 'outbound', options: input });
      if (input.previewOnly) {
        return {
          ok: true,
          read_only: true,
          preview: {
            request: {
              body: {
                amount_base_units: '10000',
                endpoint: 'https://mpp.browserbase.com/fetch',
                recipient: '0x9d27dc344b981264208583a6fc88b8c137d9e4b3',
              },
            },
            blockers: [],
          },
          ...(options.leakAgentToken ? { leaked: 'agent-admin-token' } : {}),
        };
      }
      return {
        ok: true,
        idempotency_key: input.idempotencyKey,
        execution: {
          service: 'mpp.browserbase.com',
          endpoint: 'https://mpp.browserbase.com/fetch',
          requested_amount_base_units: '10000',
        },
        signer_ledger: {
          status: 'approved',
        },
      };
    },
    async runPublicCronArmingReadiness(input) {
      calls.push({ name: 'cronArming', options: input });
      return {
        ok: true,
        read_only: true,
        idempotency_key: input.idempotencyKey,
        checks: {
          manual_outbound_reconciliation: {
            trigger: 'admin_manual',
            signer_status: 'approved',
          },
          cron_safety: {
            status: 503,
          },
        },
      };
    },
    async runPublicAutonomousCompletionVerifier(input) {
      calls.push({ name: 'completion', options: input });
      return {
        ok: true,
        read_only: true,
        checks: {
          inbound_payment: {
            report_id: 'rpt_live',
          },
          manual_outbound_payment: {
            idempotency_key: input.manualOutboundIdempotencyKey,
          },
          cron_readiness: {
            ready_to_enable: true,
            ready_to_run_authorized: false,
          },
        },
      };
    },
    async runPublicOutboundCronLiveRun(input) {
      calls.push({ name: 'cronRun', options: input });
      return {
        ok: true,
        idempotency_key: input.expectedIdempotencyKey,
        execution: {
          trigger: 'vercel_cron',
          requested_amount_base_units: '10000',
        },
        agent_ledger: {
          type: 'outbound_cron_payment_succeeded',
        },
        signer_ledger: null,
      };
    },
  };
}
