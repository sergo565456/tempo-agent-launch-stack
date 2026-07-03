import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicLiveNextStep } from '../scripts/public-live-next-step.js';

describe('public live next-step planner', () => {
  it('plans the inbound payment as the first live boundary', async () => {
    const calls = [];
    const summary = await runPublicLiveNextStep(baseOptions(), makeDeps(calls));

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.stage, 'awaiting_inbound_payment');
    assert.equal(summary.expected_cron_mode, 'disabled');
    assert.equal(summary.checks.launch_readiness.live_actions, false);
    assert.equal(summary.checks.inbound_reconciliation, null);
    assert.equal(summary.next_actions[0].name, 'dry_run_public_inbound_payment');
    assert.equal(summary.next_actions[0].live_action, false);
    assert.equal(summary.next_actions[1].name, 'confirm_public_inbound_payment');
    assert.equal(summary.next_actions[1].live_action, true);
    assert.equal(summary.next_actions[1].requires_manual_approval, true);
    assert.equal(calls.map((call) => call.name).join(','), 'launch');
  });

  it('plans the first manual outbound payment after inbound evidence is verified', async () => {
    const calls = [];
    const summary = await runPublicLiveNextStep({
      ...baseOptions(),
      inboundIdempotencyKey: 'public-live-tempo-inbound-001',
    }, makeDeps(calls));

    assert.equal(summary.stage, 'awaiting_manual_outbound_payment');
    assert.equal(summary.checks.inbound_reconciliation.report_id, 'rpt_live_001');
    assert.equal(summary.next_actions[0].name, 'reconcile_public_inbound_payment');
    assert.equal(summary.next_actions[1].name, 'confirm_first_manual_outbound_payment');
    assert.match(summary.next_actions[1].command, /--confirm-live-outbound-payment/);
    assert.equal(calls.map((call) => call.name).join(','), 'launch,inbound');
  });

  it('plans cron enablement after manual outbound evidence is verified', async () => {
    const calls = [];
    const summary = await runPublicLiveNextStep({
      ...baseOptions(),
      inboundIdempotencyKey: 'public-live-tempo-inbound-001',
      expectManualOutboundComplete: true,
    }, makeDeps(calls));

    assert.equal(summary.stage, 'awaiting_cron_enablement');
    assert.equal(summary.expected_cron_mode, 'ready_to_enable');
    assert.equal(summary.checks.manual_outbound_reconciliation.signer_status, 'approved');
    assert.equal(summary.checks.cron_arming_readiness.arming_event_type, 'outbound_admin_payment_succeeded');
    assert.equal(summary.checks.completion_verifier.cron_ready_to_enable, true);
    assert.equal(summary.next_actions[0].name, 'set_public_agent_cron_env');
    assert.equal(summary.next_actions[0].requires_manual_approval, true);
    assert.equal(summary.next_actions[1].name, 'verify_auth_gated_cron_state');
    assert.equal(calls.map((call) => call.name).join(','), 'launch,inbound,outbound,cronArming,completion');
  });

  it('plans one authorized cron verification after cron is auth-gated', async () => {
    const calls = [];
    const summary = await runPublicLiveNextStep({
      ...baseOptions(),
      inboundIdempotencyKey: 'public-live-tempo-inbound-001',
      expectManualOutboundComplete: true,
      expectCronAuthGated: true,
      expectedCronIdempotencyKey: 'cron-browserbase-fetch-2026-06-07',
    }, makeDeps(calls));

    assert.equal(summary.stage, 'awaiting_authorized_cron_verification');
    assert.equal(summary.expected_cron_mode, 'auth_gated');
    assert.equal(summary.idempotency.cron_expected, 'cron-browserbase-fetch-2026-06-07');
    assert.equal(summary.next_actions.length, 1);
    assert.equal(summary.next_actions[0].name, 'confirm_one_authorized_cron_payment');
    assert.match(summary.next_actions[0].command, /--confirm-live-cron-run/);
    assert.equal(calls.map((call) => call.name).join(','), 'launch,inbound,outbound,cronArming,completion');
  });

  it('verifies cron completion before listing review when requested', async () => {
    const calls = [];
    const summary = await runPublicLiveNextStep({
      ...baseOptions(),
      inboundIdempotencyKey: 'public-live-tempo-inbound-001',
      expectManualOutboundComplete: true,
      expectCronAuthGated: true,
      expectAuthorizedCronComplete: true,
      expectedCronIdempotencyKey: 'cron-browserbase-fetch-2026-06-07',
    }, makeDeps(calls));

    assert.equal(summary.stage, 'ready_for_listing_review');
    assert.equal(summary.checks.authorized_cron_reconciliation.idempotency_key, 'cron-browserbase-fetch-2026-06-07');
    assert.equal(summary.next_actions[0].name, 'prepare_public_listing_review');
    assert.equal(calls.map((call) => call.name).join(','), 'launch,inbound,outbound,cronArming,completion,outbound');
  });

  it('rejects impossible stage claims and token leaks', async () => {
    await assert.rejects(
      () => runPublicLiveNextStep({
        ...baseOptions(),
        expectManualOutboundComplete: true,
      }, makeDeps([])),
      /Inbound evidence is required/,
    );

    await assert.rejects(
      () => runPublicLiveNextStep(baseOptions(), makeDeps([], { leakToken: true })),
      /public live next-step planner composed results leaked an admin or cron token/,
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
    async runPublicLiveLaunchOrchestrator(input) {
      calls.push({ name: 'launch', options: input });
      return {
        ok: true,
        read_only: true,
        live_actions: false,
        checks: {
          go_live_readiness: {
            signer_provider: 'turnkey',
          },
          outbound_preview: {
            amount_base_units: '10000',
          },
        },
        ...(options.leakToken ? { leaked: 'agent-admin-token' } : {}),
      };
    },
    async runPublicInboundReconcile(input) {
      calls.push({ name: 'inbound', options: input });
      return {
        ok: true,
        read_only: true,
        match: {
          idempotency_key: input.idempotencyKey,
          report_id: 'rpt_live_001',
          receipt_id: 'rcpt_live_001',
        },
      };
    },
    async runPublicOutboundReconcile(input) {
      calls.push({ name: 'outbound', options: input });
      return {
        ok: true,
        read_only: true,
        idempotency_key: input.idempotencyKey,
        agent: {
          event_type: input.idempotencyKey.startsWith('cron-')
            ? 'outbound_cron_payment_succeeded'
            : 'outbound_admin_payment_succeeded',
          trigger: input.idempotencyKey.startsWith('cron-') ? 'vercel_cron' : 'admin_manual',
          amount_base_units: '10000',
        },
        signer: {
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
        arming_event: {
          type: 'outbound_admin_payment_succeeded',
        },
        cron_safety: {
          status: input.expectCronAuthGated ? 401 : 503,
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
            report_id: 'rpt_live_001',
          },
          manual_outbound_payment: {
            idempotency_key: input.manualOutboundIdempotencyKey,
          },
          cron_readiness: {
            ready_to_enable: !input.expectCronAuthGated,
            ready_to_run_authorized: input.expectCronAuthGated,
          },
        },
      };
    },
  };
}
