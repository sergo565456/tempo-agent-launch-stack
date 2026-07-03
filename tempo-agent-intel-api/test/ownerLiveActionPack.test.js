import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runOwnerLiveActionPack } from '../scripts/owner-live-action-pack.js';

describe('owner live action pack', () => {
  it('builds a read-only owner action pack from missing handoff values', async () => {
    const summary = await runOwnerLiveActionPack({}, makeDeps(false));

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.ready_for_local_live_boundary, false);
    assert.equal(summary.ready_for_env_upload_or_payment, false);
    assert.ok(summary.implemented_live_signing_path.current.includes('TURNKEY_SIGN_WITH_MODE=wallet remains simplest'));
    assert.ok(summary.implemented_live_signing_path.current.includes('TURNKEY_SIGN_WITH_MODE=access_key is implemented but owner-gated'));
    assert.ok(summary.implemented_live_signing_path.access_key_mode.includes('Implemented in the signer'));
    assert.ok(summary.owner_actions.some((action) => action.status === 'owner_action_required'));
    assert.equal(summary.recommended_path.some((step) => step.id === 'strict_turnkey_policy'), true);
    assert.equal(summary.recommended_path.some((step) => step.boundary === 'owner_manual_onchain'), true);
    assert.equal(summary.creation_guides.some((guide) => guide.id === 'turnkey_org_and_api_only_signer'), true);
    assert.equal(summary.creation_guides.some((guide) => (
      guide.id === 'tempo_access_key'
      && guide.safety_checks.some((check) => check.includes('Root Key remains owner-only'))
    )), true);
    assert.equal(summary.creation_guides.some((guide) => (
      guide.id === 'turnkey_agent_wallet'
      && guide.owner_steps.some((step) => step.includes('ADDRESS_FORMAT_ETHEREUM'))
    )), true);
    assert.equal(summary.official_references.some((reference) => reference.url === 'https://docs.turnkey.com/networks/tempo'), true);
    assert.equal(summary.official_references.some((reference) => reference.url === 'https://docs.turnkey.com/concepts/policies/quickstart'), true);
    assert.equal(summary.live_values_template.turnkey_api_private_key, '__PASTE_TURNKEY_API_PRIVATE_KEY__');
    assert.equal(summary.owner_value_requirements.some((item) => item.key === 'turnkey_api_private_key' && item.secret === true), true);
    assert.equal(summary.owner_value_requirements.some((item) => item.destinations.includes('signer.TURNKEY_API_PRIVATE_KEY')), true);
    assert.ok(summary.hard_stops.some((stop) => stop.includes('Tempo Access Key')));
    assert.ok(summary.note.includes('No file writes'));
  });

  it('marks owner actions configured when the local handoff checklist is complete', async () => {
    const summary = await runOwnerLiveActionPack({
      agentEnvFile: '.secrets/agent-production.env',
      signerEnvFile: '../tempo-outbound-signer/.secrets/signer-live.env',
    }, makeDeps(true));

    assert.equal(summary.ready_for_local_live_boundary, true);
    assert.equal(summary.owner_actions.every((action) => action.status === 'configured_locally'), true);
    assert.equal(summary.next_manual_boundary.includes('explicit owner approval'), true);
    assert.equal(summary.commands.owner_action_pack.includes('handoff:owner-action-pack'), true);
    assert.equal(summary.commands.local_live_next_step.includes('handoff:next-step'), true);
    assert.equal(summary.commands.init_live_values_template.includes('handoff:init-live-values'), true);
    assert.equal(summary.commands.validate_live_values_pre_policy.includes('handoff:validate-live-values'), true);
    assert.equal(summary.commands.validate_live_values_pre_policy.includes('--allow-missing-policy-id'), true);
    assert.equal(summary.commands.validate_live_values_final.includes('handoff:validate-live-values'), true);
    assert.equal(summary.commands.pre_policy_dry_run_apply_live_values.includes('--allow-missing-policy-id'), true);
    assert.equal(summary.commands.turnkey_policy_draft.includes('turnkey-policy-draft.js'), true);
    assert.equal(summary.commands.post_policy_final_apply_live_values.includes('--write'), true);
    assert.equal(summary.commands.signer_vercel_deploy_dry_run.includes('deploy-vercel-live.ps1'), true);
    assert.equal(summary.commands.signer_vercel_deploy_dry_run.includes('-DryRun'), true);
    assert.equal(summary.commands.agent_vercel_deploy_dry_run.includes('deploy-vercel-production.ps1'), true);
    assert.equal(summary.commands.agent_vercel_deploy_dry_run.includes('-DryRun'), true);
  });

  it('sanitizes secret-looking values from checklist details', async () => {
    const summary = await runOwnerLiveActionPack({}, makeDeps(true, {
      leakSecretRedactedValue: true,
    }));
    const serialized = JSON.stringify(summary);

    assert.equal(serialized.includes('turnkey-private-secret-0000000001'), false);
  });
});

function makeDeps(configured, options = {}) {
  return {
    async runLiveManualChecklist() {
      return buildChecklist(configured, options);
    },
    buildLiveValuesTemplate() {
      return {
        agent_public_base_url: 'https://your-agent.vercel.app',
        signer_public_base_url: 'https://your-signer.vercel.app',
        agent_receive_tempo_address: '0x0000000000000000000000000000000000000000',
        agent_upstash_redis_rest_url: 'https://your-agent-upstash.example',
        agent_upstash_redis_rest_token: '__PASTE_AGENT_UPSTASH_REST_TOKEN__',
        signer_upstash_redis_rest_url: 'https://your-signer-upstash.example',
        signer_upstash_redis_rest_token: '__PASTE_SIGNER_UPSTASH_REST_TOKEN__',
        turnkey_organization_id: '__PASTE_TURNKEY_ORGANIZATION_ID__',
        turnkey_api_public_key: '__PASTE_TURNKEY_API_PUBLIC_KEY__',
        turnkey_api_private_key: '__PASTE_TURNKEY_API_PRIVATE_KEY__',
        turnkey_policy_id: '__PASTE_TURNKEY_POLICY_ID__',
        turnkey_signer_api_user_id: '__PASTE_TURNKEY_SIGNER_API_USER_ID__',
        agent_turnkey_wallet_address: '0x0000000000000000000000000000000000000000',
        agent_tempo_access_key_address: '0x0000000000000000000000000000000000000000',
      };
    },
    buildOwnerValueRequirements() {
      return [
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
  };
}

function buildChecklist(configured, options) {
  return {
    ok: configured,
    read_only: true,
    live_actions: false,
    env_files: {
      agent: {
        path: 'agent.env',
        exists: true,
        loaded_keys: ['PUBLIC_BASE_URL'],
      },
      signer: {
        path: 'signer.env',
        exists: true,
        loaded_keys: ['PUBLIC_BASE_URL'],
      },
    },
    checklist: {
      agent: [
        item('PUBLIC_BASE_URL', configured, false),
        item('RECEIVE_TEMPO_ADDRESS', configured, false),
        item('UPSTASH_REDIS_REST_URL', configured, false),
        item('UPSTASH_REDIS_REST_TOKEN', configured, true, options.leakSecretRedactedValue),
      ],
      signer: [
        item('PUBLIC_BASE_URL', configured, false),
        item('UPSTASH_REDIS_REST_URL', configured, false),
        item('UPSTASH_REDIS_REST_TOKEN', configured, true),
        item('TURNKEY_ORGANIZATION_ID', configured, false),
        item('TURNKEY_API_PUBLIC_KEY', configured, false),
        item('TURNKEY_API_PRIVATE_KEY', configured, true, options.leakSecretRedactedValue),
        item('TURNKEY_SIGNER_API_USER_ID', configured, false),
        item('TURNKEY_POLICY_ID', configured, false),
      ],
      signer_policy: {
        ok: configured,
        items: [
          item('AGENT_WALLETS_JSON.wallet_address', configured, false),
          item('AGENT_WALLETS_JSON.tempo_access_key_address', configured, false),
        ],
      },
      pair: [],
    },
    manual_actions_remaining: configured ? [] : ['agent: fill Agent public HTTPS URL'],
    blockers: configured ? [] : ['agent: fill Agent public HTTPS URL'],
  };
}

function item(key, configured, secret, leak = false) {
  return {
    key,
    label: key,
    configured,
    placeholder: !configured,
    secret,
    redacted_value: configured
      ? (secret ? (leak ? 'turnkey-private-secret-0000000001' : '<configured-secret>') : 'configured-public-value')
      : null,
  };
}
