import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSimulatedLiveValues,
  runSimulatedOwnerLiveReadiness,
} from '../scripts/simulate-owner-live-readiness.js';

describe('simulated owner live readiness', () => {
  it('proves the owner handoff can reach env upload approval with production-like values', async () => {
    const summary = await runSimulatedOwnerLiveReadiness({ skipDrill: true });
    const serialized = JSON.stringify(summary);

    assert.equal(summary.ok, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.wrote_temp_files, true);
    assert.equal(summary.persistent_project_files_modified, false);
    assert.equal(summary.temp_dir_retained, false);
    assert.equal(summary.access_key_onchain_verification, false);
    assert.equal(summary.pre_policy.validation.ok, true);
    assert.equal(summary.pre_policy.write_apply_to_temp.policy_id_deferred, true);
    assert.equal(summary.pre_policy.next_step_stage, 'awaiting_pre_policy_apply_and_turnkey_policy');
    assert.equal(summary.pre_policy.policy_draft.ok, true);
    assert.equal(summary.pre_policy.policy_draft.current_signer_uses_access_key_mode, false);
    assert.equal(summary.final.validation.ok, true);
    assert.equal(summary.final.local_boundary.ok, true);
    assert.equal(summary.final.local_boundary.access_key_ok, true);
    assert.equal(summary.final.local_boundary.access_key_verify_onchain, false);
    assert.equal(summary.final.local_boundary.local_autonomous_drill_skipped, true);
    assert.equal(summary.final.next_step_stage, 'ready_for_env_upload_approval');
    assert.equal(summary.final.strict_worksheet_ok, true);
    assert.match(summary.next_manual_boundary, /explicit manual approval/);
    assert.equal(serialized.includes('simulatedAgentRedisSecretValue000001'), false);
    assert.equal(serialized.includes('simulatedSignerRedisSecretValue00001'), false);
    assert.equal(serialized.includes('simulatedTurnkeyApiSecretValue000001'), false);
    assert.equal(serialized.includes('simulatedSignerAdminTokenValue00001'), false);
  });

  it('uses a deferred Turnkey policy ID only in pre-policy mode', () => {
    const prePolicy = buildSimulatedLiveValues({ withPolicyId: false });
    const final = buildSimulatedLiveValues();

    assert.equal(prePolicy.turnkey_policy_id, '__PASTE_TURNKEY_POLICY_ID__');
    assert.equal(final.turnkey_policy_id, 'turnkey-policy-simulated-live');
    assert.notEqual(final.agent_turnkey_wallet_address, final.agent_tempo_access_key_address);
  });
});
