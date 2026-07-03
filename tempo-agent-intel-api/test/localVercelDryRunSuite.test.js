import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_VERCEL_REQUIRED_KEYS,
  SIGNER_ACCESS_KEY_VERCEL_REQUIRED_KEYS,
  SIGNER_VERCEL_REQUIRED_KEYS,
  checkEnvKeys,
  getSignerVercelRequiredKeys,
  runLocalVercelDryRunSuite,
} from '../scripts/local-vercel-dry-run-suite.js';

describe('local Vercel dry-run suite', () => {
  it('passes only when required env keys and local live boundary are ready', async () => {
    const result = await runLocalVercelDryRunSuite({}, fakeDeps({
      agentValues: valuesFor(AGENT_VERCEL_REQUIRED_KEYS, {
        OUTBOUND_ADMIN_TOKEN: 'agent-admin-secret-with-32-chars',
        OUTBOUND_SIGNER_ADMIN_TOKEN: 'shared-signer-secret-with-32-chars',
        TEMPO_MPP_SECRET_KEY: 'tempo-mpp-secret-with-32-chars',
      }),
      signerValues: valuesFor(SIGNER_VERCEL_REQUIRED_KEYS, {
        SIGNER_ADMIN_TOKEN: 'shared-signer-secret-with-32-chars',
        TURNKEY_API_PRIVATE_KEY: 'turnkey-private-api-secret-32-chars',
      }),
      nextStep: readyNextStep(),
    }));
    const text = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.read_only, true);
    assert.equal(result.live_actions, false);
    assert.equal(result.required_env_keys.agent.ok, true);
    assert.equal(result.required_env_keys.signer.ok, true);
    assert.equal(result.next_step.stage, 'ready_for_env_upload_approval');
    assert.equal(text.includes('agent-admin-secret-with-32-chars'), false);
    assert.equal(text.includes('turnkey-private-api-secret-32-chars'), false);
  });

  it('reports missing Vercel upload keys before helper dry-runs', async () => {
    const signerValues = valuesFor(SIGNER_VERCEL_REQUIRED_KEYS);
    delete signerValues.SIGNER_ADMIN_RATE_LIMIT_ENABLED;

    const result = await runLocalVercelDryRunSuite({}, fakeDeps({
      agentValues: valuesFor(AGENT_VERCEL_REQUIRED_KEYS),
      signerValues,
      nextStep: readyNextStep(),
    }));

    assert.equal(result.ok, false);
    assert.equal(result.required_env_keys.signer.ok, false);
    assert.deepEqual(result.required_env_keys.signer.missing_keys, ['SIGNER_ADMIN_RATE_LIMIT_ENABLED']);
    assert(result.blockers.includes('signer env missing required Vercel upload key: SIGNER_ADMIN_RATE_LIMIT_ENABLED'));
  });

  it('requires access-key Vercel upload keys only when signer mode is access_key', async () => {
    assert.deepEqual(
      getSignerVercelRequiredKeys({ TURNKEY_SIGN_WITH_MODE: 'wallet' }),
      SIGNER_VERCEL_REQUIRED_KEYS,
    );
    assert.deepEqual(
      getSignerVercelRequiredKeys({ TURNKEY_SIGN_WITH_MODE: 'access_key' }),
      [...SIGNER_VERCEL_REQUIRED_KEYS, ...SIGNER_ACCESS_KEY_VERCEL_REQUIRED_KEYS],
    );

    const signerValues = valuesFor(SIGNER_VERCEL_REQUIRED_KEYS, {
      TURNKEY_SIGN_WITH_MODE: 'access_key',
    });

    const result = await runLocalVercelDryRunSuite({}, fakeDeps({
      agentValues: valuesFor(AGENT_VERCEL_REQUIRED_KEYS),
      signerValues,
      nextStep: readyNextStep(),
    }));

    assert.equal(result.ok, false);
    assert.deepEqual(result.required_env_keys.signer.missing_keys, SIGNER_ACCESS_KEY_VERCEL_REQUIRED_KEYS);
    assert(result.blockers.includes('signer env missing required Vercel upload key: TURNKEY_ACCESS_KEY_SIGN_WITH'));
  });

  it('keeps owner-value blockers before env upload dry-runs', async () => {
    const result = await runLocalVercelDryRunSuite({}, fakeDeps({
      agentValues: valuesFor(AGENT_VERCEL_REQUIRED_KEYS),
      signerValues: valuesFor(SIGNER_VERCEL_REQUIRED_KEYS),
      nextStep: {
        ok: true,
        read_only: true,
        live_actions: false,
        stage: 'awaiting_owner_values',
        checks: { local_live_boundary: { ok: false } },
      },
    }));

    assert.equal(result.ok, false);
    assert(result.blockers.includes('local next-step stage is awaiting_owner_values, not ready_for_env_upload_approval'));
  });

  it('rejects forbidden public agent runtime keys', () => {
    const values = valuesFor(AGENT_VERCEL_REQUIRED_KEYS, {
      ROOT_PRIVATE_KEY: 'must-not-be-here',
    });
    const result = checkEnvKeys(values, AGENT_VERCEL_REQUIRED_KEYS, ['ROOT_PRIVATE_KEY']);

    assert.equal(result.ok, false);
    assert.deepEqual(result.forbidden_present, ['ROOT_PRIVATE_KEY']);
  });
});

function fakeDeps({ agentValues, signerValues, nextStep }) {
  return {
    async readEnvFile(path) {
      return {
        exists: true,
        path,
        values: path.includes('signer') ? signerValues : agentValues,
      };
    },
    async runLocalLiveNextStep() {
      return nextStep;
    },
  };
}

function readyNextStep() {
  return {
    ok: true,
    read_only: true,
    live_actions: false,
    stage: 'ready_for_env_upload_approval',
    checks: { local_live_boundary: { ok: true } },
  };
}

function valuesFor(keys, overrides = {}) {
  return {
    ...Object.fromEntries(keys.map((key) => [key, `${key.toLowerCase()}_value`])),
    ...overrides,
  };
}
