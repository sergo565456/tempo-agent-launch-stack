import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runOwnerLiveWorksheet } from '../scripts/owner-live-worksheet.js';

describe('owner live worksheet', () => {
  it('builds a read-only markdown worksheet without live actions', async () => {
    const summary = await runOwnerLiveWorksheet({}, makeDeps());

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.stage, 'awaiting_owner_values');
    assert.equal(summary.strict_ok, true);
    assert.equal(summary.strict_status, 'not_requested');
    assert.equal(summary.local_live_boundary_ok, false);
    assert.equal(summary.ready_for_env_upload_approval, false);
    assert.equal(summary.ready_for_env_upload_or_payment, false);
    assert.equal(summary.owner_values.some((item) => item.key === 'turnkey_api_private_key'), true);
    assert.equal(summary.creation_guides.some((guide) => guide.id === 'turnkey_org_and_api_only_signer'), true);
    assert.equal(summary.next_safe_actions[0].name, 'validate_live_values_pre_policy');
    assert.ok(summary.markdown.includes('# Owner Live Handoff Worksheet'));
    assert.ok(summary.markdown.includes('Strict mode: not requested'));
    assert.ok(summary.markdown.includes('turnkey_api_private_key'));
    assert.ok(summary.markdown.includes('Root Key remains owner-only'));
    assert.ok(summary.note.includes('No file writes'));
  });

  it('fails strict mode until the local live boundary is ready for env upload approval', async () => {
    const summary = await runOwnerLiveWorksheet({ strict: true }, makeDeps());

    assert.equal(summary.strict, true);
    assert.equal(summary.strict_ok, false);
    assert.equal(summary.strict_status, 'failed');
    assert.match(summary.markdown, /Strict mode: failed/);
    assert.match(summary.strict_failure_reason, /ready_for_env_upload_approval/);
  });

  it('passes strict mode only when next-step reaches env upload approval', async () => {
    const summary = await runOwnerLiveWorksheet({ strict: true }, makeDeps({
      stage: 'ready_for_env_upload_approval',
      localLiveBoundaryOk: true,
    }));

    assert.equal(summary.strict_ok, true);
    assert.equal(summary.strict_status, 'passed');
    assert.match(summary.markdown, /Strict mode: passed/);
    assert.equal(summary.strict_failure_reason, null);
    assert.equal(summary.ready_for_env_upload_approval, true);
    assert.equal(summary.local_live_boundary_ok, true);
  });

  it('rejects known secret-looking values from composed summaries', async () => {
    await assert.rejects(
      () => runOwnerLiveWorksheet({}, makeDeps({ leak: true })),
      /owner live worksheet leaked/,
    );
  });
});

function makeDeps(options = {}) {
  return {
    async runOwnerLiveActionPack() {
      return {
        ok: true,
        read_only: true,
        live_actions: false,
        ready_for_local_live_boundary: false,
        ready_for_env_upload_or_payment: false,
        recommended_path: [
          {
            step: 1,
            id: 'owner_root_outside_runtime',
            title: 'Keep owner/root authority outside runtimes',
            boundary: 'owner_manual',
            done_when: 'No root material in runtimes.',
          },
        ],
        creation_guides: [
          {
            id: 'turnkey_org_and_api_only_signer',
            title: 'Turnkey organization and API-only signer user/key',
            creates_values: ['turnkey_api_private_key'],
            owner_steps: ['Create an API-only signer user.'],
            safety_checks: [
              options.leak ? 'turnkey-private-secret-0000000001' : 'Never put TURNKEY_API_PRIVATE_KEY in the public agent runtime.',
            ],
            verification_commands: ['npm run handoff:validate-live-values -- --allow-missing-policy-id'],
          },
          {
            id: 'tempo_access_key',
            title: 'Tempo Access Key authorization metadata',
            creates_values: ['agent_tempo_access_key_address'],
            owner_steps: ['Authorize the Access Key with Root Key.'],
            safety_checks: ['Root Key remains owner-only and must not enter either deployed runtime.'],
            verification_commands: ['npm run preflight:local-live-boundary'],
          },
        ],
        owner_value_requirements: [
          {
            key: 'turnkey_api_private_key',
            label: 'Turnkey API private key',
            kind: 'secret',
            secret: true,
            status: 'placeholder',
            deferred_allowed: false,
            destinations: ['signer.TURNKEY_API_PRIVATE_KEY'],
            owner_source: 'API-only signer user key.',
            safety: 'Never put this in the public agent runtime.',
          },
        ],
        checklist: {
          manual_actions_remaining: ['signer: fill Turnkey API private key'],
        },
        hard_stops: ['No Vercel env upload/deploy or live payment without explicit owner approval.'],
      };
    },
    async runLocalLiveNextStep() {
      return {
        ok: true,
        read_only: true,
        live_actions: false,
        stage: options.stage || 'awaiting_owner_values',
        owner_value_requirements: [
          {
            key: 'turnkey_api_private_key',
            label: 'Turnkey API private key',
            kind: 'secret',
            secret: true,
            status: 'placeholder',
            deferred_allowed: false,
            destinations: ['signer.TURNKEY_API_PRIVATE_KEY'],
            owner_source: 'API-only signer user key.',
            safety: 'Never put this in the public agent runtime.',
          },
        ],
        checks: {
          local_live_boundary: {
            ok: options.localLiveBoundaryOk === true,
            next_manual_values: ['signer: fill Turnkey API private key'],
          },
        },
        next_actions: [
          {
            name: 'validate_live_values_pre_policy',
            live_action: false,
            requires_manual_approval: false,
            command: 'npm run handoff:validate-live-values -- --allow-missing-policy-id',
          },
        ],
      };
    },
  };
}
