import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLocalLiveNextStep } from '../scripts/local-live-next-step.js';

describe('local live next-step planner', () => {
  it('starts with the live-values template when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-local-next-missing-'));
    try {
      const summary = await runLocalLiveNextStep({
        inputFile: join(dir, '.secrets', 'live-values.json'),
        skipBoundary: true,
      }, makeDeps());

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.live_actions, false);
      assert.equal(summary.stage, 'awaiting_live_values_template');
      assert.equal(summary.next_actions[0].name, 'init_live_values_template');
      assert.equal(summary.next_actions[0].live_action, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('points at owner value filling when placeholders remain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-local-next-owner-values-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, '{}');
      const summary = await runLocalLiveNextStep({
        inputFile,
        skipBoundary: true,
      }, makeDeps({
        prePolicy: validation({
          ok: false,
          placeholderKeys: ['turnkey_api_private_key'],
          blockers: ['turnkey_api_private_key still contains a template placeholder.'],
        }),
      }));

      assert.equal(summary.stage, 'awaiting_owner_values');
      assert.equal(summary.checks.live_values_pre_policy.placeholder_keys[0], 'turnkey_api_private_key');
      assert.equal(summary.owner_value_requirements.some((item) => item.key === 'turnkey_api_private_key' && item.secret === true), true);
      assert.equal(summary.owner_value_requirements.some((item) => item.destinations.includes('signer.TURNKEY_API_PRIVATE_KEY')), true);
      assert.equal(summary.next_actions[0].name, 'fill_live_values_file');
      assert.equal(summary.next_actions[0].requires_manual_approval, true);
      assert.equal(summary.next_actions[1].command.includes('handoff:validate-live-values'), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plans pre-policy apply and Turnkey policy creation when only policy id is deferred', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-local-next-pre-policy-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, '{}');
      const summary = await runLocalLiveNextStep({
        inputFile,
        skipBoundary: true,
      }, makeDeps({
        prePolicy: validation({ ok: true, deferredKeys: ['turnkey_policy_id'] }),
        final: validation({
          ok: false,
          placeholderKeys: ['turnkey_policy_id'],
          blockers: ['turnkey_policy_id still contains a template placeholder.'],
        }),
      }));

      assert.equal(summary.stage, 'awaiting_pre_policy_apply_and_turnkey_policy');
      assert.equal(summary.next_actions[0].name, 'dry_run_pre_policy_apply');
      assert.equal(summary.next_actions[0].command.includes('--allow-missing-policy-id'), true);
      assert.equal(summary.next_actions[2].name, 'draft_turnkey_policy');
      assert.equal(summary.next_actions[3].live_action, true);
      assert.equal(summary.next_actions[3].requires_manual_approval, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plans final apply and local gate when live values are complete but boundary is not green', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-local-next-final-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, '{}');
      const summary = await runLocalLiveNextStep({
        inputFile,
      }, makeDeps({
        prePolicy: validation({ ok: true }),
        final: validation({ ok: true }),
        boundary: boundary({ ok: false, blockers: ['agent PUBLIC_BASE_URL is still placeholder'] }),
      }));

      assert.equal(summary.stage, 'awaiting_final_apply_or_local_gate');
      assert.equal(summary.checks.local_live_boundary.blockers_count, 1);
      assert.equal(summary.next_actions.some((action) => action.name === 'write_final_local_handoff_files'), true);
      assert.equal(summary.next_actions.every((action) => action.live_action === false), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops at explicit env upload approval once local gates are green', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-local-next-ready-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, '{}');
      const summary = await runLocalLiveNextStep({
        inputFile,
      }, makeDeps({
        prePolicy: validation({ ok: true }),
        final: validation({ ok: true }),
        boundary: boundary({ ok: true }),
      }));

      assert.equal(summary.stage, 'ready_for_env_upload_approval');
      assert.equal(summary.next_actions[0].name, 'request_env_upload_and_deploy_approval');
      assert.equal(summary.next_actions[0].live_action, true);
      assert.equal(summary.next_actions[0].requires_manual_approval, true);
      assert.equal(summary.next_actions[1].name, 'verify_tempo_access_key_onchain');
      assert.equal(summary.next_actions[1].live_action, false);
      assert.equal(summary.next_actions[2].command.includes('-DryRun'), true);
      assert.equal(summary.next_actions[3].command.includes('-DryRun'), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects known secret leaks from composed summaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-local-next-leak-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, '{}');
      await assert.rejects(
        () => runLocalLiveNextStep({
          inputFile,
          skipBoundary: true,
        }, makeDeps({
          prePolicy: validation({
            ok: false,
            blockers: ['turnkey-private-secret-0000000001'],
          }),
        })),
        /local live next-step planner leaked/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function makeDeps(options = {}) {
  return {
    async validateLiveValuesFile(input) {
      if (input.allowMissingPolicyId) {
        return options.prePolicy || validation({ ok: false });
      }
      return options.final || validation({ ok: false });
    },
    buildOwnerValueRequirements() {
      return options.requirements || [
        {
          key: 'turnkey_api_private_key',
          label: 'Turnkey API private key',
          kind: 'secret',
          secret: true,
          status: 'placeholder',
          deferred_allowed: false,
          owner_source: 'API-only signer user key.',
          destinations: ['signer.TURNKEY_API_PRIVATE_KEY'],
          safety: 'Never put this in the public agent runtime.',
        },
      ];
    },
    async runLocalLiveBoundaryGate() {
      return options.boundary || boundary({ ok: false });
    },
  };
}

function validation(options) {
  return {
    ok: options.ok,
    read_only: true,
    live_actions: false,
    wrote_files: false,
    allow_missing_policy_id: options.deferredKeys?.length ? true : false,
    configured_keys: options.ok ? ['agent_public_base_url'] : [],
    missing_keys: options.missingKeys || [],
    placeholder_keys: options.placeholderKeys || [],
    deferred_keys: options.deferredKeys || [],
    blockers: options.blockers || [],
    validation: {
      deferred_keys: options.deferredKeys || [],
      failures: options.blockers || [],
    },
    owner_value_requirements: options.requirements,
  };
}

function boundary(options) {
  return {
    ok: options.ok,
    read_only: true,
    live_actions: false,
    blockers: options.blockers || [],
    next_manual_values: options.ok ? [] : ['agent: fill Agent public HTTPS URL'],
    allowed_next_action: options.ok
      ? 'Request explicit manual approval for Vercel env upload/deploy.'
      : 'Fill owner values first.',
  };
}
