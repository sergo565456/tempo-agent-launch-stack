import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLiveHandoffEnvFiles } from '../scripts/bootstrap-live-handoff-env.js';
import { buildOwnerValueRequirements, initLiveValuesTemplateFile, runApplyLiveHandoffValues, validateLiveValuesFile } from '../scripts/apply-live-handoff-values.js';
import { parseEnvText } from '../src/runtime/envFiles.js';

const LIVE_VALUES = {
  agent_public_base_url: 'https://agent-launch-intel-prod.vercel.app',
  signer_public_base_url: 'https://agent-launch-intel-signer-prod.vercel.app',
  agent_receive_tempo_address: '0x3333333333333333333333333333333333333333',
  agent_upstash_redis_rest_url: 'https://agent-launch-intel-prod.upstash.io',
  agent_upstash_redis_rest_token: 'agent-upstash-secret-with-32-chars',
  signer_upstash_redis_rest_url: 'https://agent-launch-intel-signer-prod.upstash.io',
  signer_upstash_redis_rest_token: 'signer-upstash-secret-with-32-chars',
  turnkey_organization_id: 'turnkey-org-real',
  turnkey_api_public_key: 'turnkey-public-real',
  turnkey_api_private_key: 'turnkey-private-secret-with-32-chars',
  turnkey_policy_id: 'turnkey-policy-real',
  turnkey_signer_api_user_id: 'turnkey-user-real',
  agent_turnkey_wallet_address: '0x4444444444444444444444444444444444444444',
  agent_tempo_access_key_address: '0x5555555555555555555555555555555555555555',
};

describe('apply live handoff values', () => {
  it('initializes a local live-values template and refuses to overwrite it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-live-values-template-'));
    const outputFile = join(dir, '.secrets', 'live-values.json');
    try {
      const first = await initLiveValuesTemplateFile({ outputFile });
      const raw = await readFile(outputFile, 'utf8');
      const parsed = JSON.parse(raw);
      const second = await initLiveValuesTemplateFile({ outputFile });
      const serialized = JSON.stringify(first);

      assert.equal(first.ok, true);
      assert.equal(first.live_actions, false);
      assert.equal(first.wrote_file, true);
      assert.equal(parsed.turnkey_api_private_key, '__PASTE_TURNKEY_API_PRIVATE_KEY__');
      assert.equal(parsed.turnkey_sign_with_mode, 'wallet');
      assert.equal(parsed.turnkey_access_key_mode_audited, 'false');
      assert.equal(parsed.agent_public_base_url, 'https://your-agent.vercel.app');
      assert.equal(second.ok, false);
      assert.equal(second.wrote_file, false);
      assert(second.blockers[0].includes('already exists'));
      assert.equal(serialized.includes('turnkey-private-secret'), false);
      assert.equal(raw.endsWith('\n'), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates the local live-values file without writing or leaking secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-validate-live-values-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, JSON.stringify({
        ...LIVE_VALUES,
        turnkey_policy_id: '__PASTE_TURNKEY_POLICY_ID__',
      }, null, 2));

      const result = await validateLiveValuesFile({
        inputFile,
        allowMissingPolicyId: true,
      });
      const serialized = JSON.stringify(result);

      assert.equal(result.ok, true);
      assert.equal(result.read_only, true);
      assert.equal(result.live_actions, false);
      assert.equal(result.wrote_files, false);
      assert.equal(result.value_status.turnkey_policy_id.status, 'deferred');
      assert.equal(result.value_status.turnkey_sign_with_mode.redacted_value, 'wallet(default)');
      assert.equal(result.value_status.turnkey_access_key_sign_with.status, 'not_required');
      assert.equal(result.value_status.turnkey_api_private_key.redacted_value, '<provided-secret>');
      assert.equal(result.deferred_keys.includes('turnkey_policy_id'), true);
      assert(result.owner_value_requirements.some((item) => item.key === 'turnkey_api_private_key' && item.secret === true));
      assert(result.owner_value_requirements.some((item) => item.key === 'agent_turnkey_wallet_address' && item.destinations.includes('signer.TURNKEY_SIGN_WITH')));
      assert.equal(serialized.includes(LIVE_VALUES.agent_upstash_redis_rest_token), false);
      assert.equal(serialized.includes(LIVE_VALUES.signer_upstash_redis_rest_token), false);
      assert.equal(serialized.includes(LIVE_VALUES.turnkey_api_private_key), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports placeholder live-values blockers without reading env files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-validate-placeholders-'));
    const inputFile = join(dir, '.secrets', 'live-values.json');
    try {
      await initLiveValuesTemplateFile({ outputFile: inputFile });

      const result = await validateLiveValuesFile({ inputFile });

      assert.equal(result.ok, false);
      assert.equal(result.read_only, true);
      assert.equal(result.live_actions, false);
      assert.equal(result.wrote_files, false);
      assert(result.placeholder_keys.includes('turnkey_api_private_key'));
      assert(result.placeholder_keys.includes('turnkey_policy_id'));
      assert(result.blockers.some((blocker) => blocker.includes('template placeholder')));
      assert.equal(result.value_status.turnkey_api_private_key.redacted_value, '<template-placeholder>');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds owner value requirements with destinations and safety notes', () => {
    const requirements = buildOwnerValueRequirements({
      ...LIVE_VALUES,
      turnkey_policy_id: '__PASTE_TURNKEY_POLICY_ID__',
    }, {
      allowMissingPolicyId: true,
    });
    const policy = requirements.find((item) => item.key === 'turnkey_policy_id');
    const signerKey = requirements.find((item) => item.key === 'turnkey_api_private_key');
    const accessKey = requirements.find((item) => item.key === 'agent_tempo_access_key_address');

    assert.equal(policy.status, 'deferred');
    assert.equal(policy.deferred_allowed, true);
    assert.equal(signerKey.secret, true);
    assert(signerKey.safety.includes('Never put this in the public agent runtime'));
    assert(accessKey.safety.includes('root-authorized'));
  });

  it('dry-runs without writing files or leaking secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-apply-live-values-'));
    const agentEnvFile = join(dir, 'agent.env');
    const signerEnvFile = join(dir, 'signer.env');
    const inputFile = join(dir, 'live-values.json');
    try {
      const files = buildLiveHandoffEnvFiles({
        tempoMppSecretKey: 'existing-tempo-secret-with-32-chars',
        outboundAdminToken: 'existing-agent-admin-with-32-chars',
        signerAdminToken: 'existing-signer-admin-with-32-chars',
        cronSecret: 'existing-cron-secret-with-32-chars',
      });
      const legacyAgentEnv = files.agent
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('REPORT_RATE_LIMIT_'))
        .join('\n');
      await writeFile(agentEnvFile, legacyAgentEnv);
      const legacySignerEnv = files.signer
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('SIGNER_ADMIN_RATE_LIMIT_'))
        .join('\n');
      await writeFile(signerEnvFile, legacySignerEnv);
      await writeFile(inputFile, JSON.stringify(LIVE_VALUES, null, 2));

      const before = await readFile(agentEnvFile, 'utf8');
      const result = await runApplyLiveHandoffValues({
        inputFile,
        agentEnvFile,
        signerEnvFile,
      });
      const serialized = JSON.stringify(result);

      assert.equal(result.ok, true);
      assert.equal(result.read_only, true);
      assert.equal(result.wrote_files, false);
      assert(result.files[0].updated_keys.includes('PUBLIC_BASE_URL'));
      assert(result.files[1].updated_keys.includes('AGENT_WALLETS_JSON'));
      assert.equal(await readFile(agentEnvFile, 'utf8'), before);
      assert.equal(serialized.includes(LIVE_VALUES.agent_upstash_redis_rest_token), false);
      assert.equal(serialized.includes(LIVE_VALUES.signer_upstash_redis_rest_token), false);
      assert.equal(serialized.includes(LIVE_VALUES.turnkey_api_private_key), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes local env files only when explicitly requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-apply-live-values-write-'));
    const agentEnvFile = join(dir, 'agent.env');
    const signerEnvFile = join(dir, 'signer.env');
    const inputFile = join(dir, 'live-values.json');
    try {
      const files = buildLiveHandoffEnvFiles({
        tempoMppSecretKey: 'existing-tempo-secret-with-32-chars',
        outboundAdminToken: 'existing-agent-admin-with-32-chars',
        signerAdminToken: 'existing-signer-admin-with-32-chars',
        cronSecret: 'existing-cron-secret-with-32-chars',
      });
      await writeFile(agentEnvFile, files.agent);
      await writeFile(signerEnvFile, files.signer);
      await writeFile(inputFile, JSON.stringify(LIVE_VALUES, null, 2));

      const result = await runApplyLiveHandoffValues({
        inputFile,
        agentEnvFile,
        signerEnvFile,
        write: true,
      });
      const agentEnv = parseEnvText(await readFile(agentEnvFile, 'utf8'));
      const signerEnv = parseEnvText(await readFile(signerEnvFile, 'utf8'));
      const wallets = JSON.parse(signerEnv.AGENT_WALLETS_JSON);

      assert.equal(result.ok, true);
      assert.equal(result.read_only, false);
      assert.equal(result.wrote_files, true);
      assert.equal(agentEnv.PUBLIC_BASE_URL, LIVE_VALUES.agent_public_base_url);
      assert.equal(agentEnv.OUTBOUND_SIGNER_BASE_URL, LIVE_VALUES.signer_public_base_url);
      assert.equal(agentEnv.RECEIVE_TEMPO_ADDRESS, LIVE_VALUES.agent_receive_tempo_address);
      assert.equal(agentEnv.TEMPO_MPP_REALM, LIVE_VALUES.agent_public_base_url);
      assert.equal(agentEnv.REPORT_RATE_LIMIT_ENABLED, 'true');
      assert.equal(agentEnv.REPORT_RATE_LIMIT_MAX, '30');
      assert.equal(agentEnv.REPORT_RATE_LIMIT_WINDOW_MS, '60000');
      assert.equal(agentEnv.REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS, 'true');
      assert(result.files[0].updated_keys.includes('REPORT_RATE_LIMIT_ENABLED'));
      assert.equal(signerEnv.PUBLIC_BASE_URL, LIVE_VALUES.signer_public_base_url);
      assert.equal(signerEnv.TURNKEY_SIGNER_API_USER_ID, LIVE_VALUES.turnkey_signer_api_user_id);
      assert.equal(signerEnv.TURNKEY_SIGN_WITH_MODE, 'wallet');
      assert.equal(signerEnv.TURNKEY_ACCESS_KEY_SIGN_WITH, undefined);
      assert.equal(signerEnv.TURNKEY_SIGN_WITH, LIVE_VALUES.agent_turnkey_wallet_address);
      assert.equal(signerEnv.SIGNER_ADMIN_RATE_LIMIT_ENABLED, 'true');
      assert.equal(signerEnv.SIGNER_ADMIN_RATE_LIMIT_MAX, '60');
      assert.equal(signerEnv.SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS, '60000');
      assert.equal(signerEnv.SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS, 'true');
      assert(result.files[1].updated_keys.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED'));
      assert.equal(wallets[0].wallet_address, LIVE_VALUES.agent_turnkey_wallet_address);
      assert.equal(wallets[0].tempo_access_key_address, LIVE_VALUES.agent_tempo_access_key_address);
      assert.equal(wallets[0].turnkey_sign_with, LIVE_VALUES.agent_turnkey_wallet_address);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes access-key mode values only when explicitly selected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-apply-live-values-access-key-'));
    const agentEnvFile = join(dir, 'agent.env');
    const signerEnvFile = join(dir, 'signer.env');
    const inputFile = join(dir, 'live-values.json');
    try {
      const files = buildLiveHandoffEnvFiles({
        tempoMppSecretKey: 'existing-tempo-secret-with-32-chars',
        outboundAdminToken: 'existing-agent-admin-with-32-chars',
        signerAdminToken: 'existing-signer-admin-with-32-chars',
        cronSecret: 'existing-cron-secret-with-32-chars',
      });
      await writeFile(agentEnvFile, files.agent);
      await writeFile(signerEnvFile, files.signer);
      await writeFile(inputFile, JSON.stringify({
        ...LIVE_VALUES,
        turnkey_sign_with_mode: 'access_key',
        turnkey_access_key_sign_with: LIVE_VALUES.agent_tempo_access_key_address,
        turnkey_access_key_public_key: `02${'44'.repeat(32)}`,
        turnkey_access_key_policy_id: 'turnkey-access-key-policy-real',
        turnkey_access_key_mode_audited: 'true',
      }, null, 2));

      const result = await runApplyLiveHandoffValues({
        inputFile,
        agentEnvFile,
        signerEnvFile,
        write: true,
      });
      const signerEnv = parseEnvText(await readFile(signerEnvFile, 'utf8'));

      assert.equal(result.ok, true);
      assert.equal(signerEnv.TURNKEY_SIGN_WITH_MODE, 'access_key');
      assert.equal(signerEnv.TURNKEY_ACCESS_KEY_SIGN_WITH, LIVE_VALUES.agent_tempo_access_key_address);
      assert.equal(signerEnv.TURNKEY_ACCESS_KEY_PUBLIC_KEY, `02${'44'.repeat(32)}`);
      assert.equal(signerEnv.TURNKEY_ACCESS_KEY_POLICY_ID, 'turnkey-access-key-policy-real');
      assert.equal(signerEnv.TURNKEY_ACCESS_KEY_MODE_AUDITED, 'true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports a pre-policy apply before Turnkey policy ID exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-apply-live-values-pre-policy-'));
    const agentEnvFile = join(dir, 'agent.env');
    const signerEnvFile = join(dir, 'signer.env');
    const inputFile = join(dir, 'live-values.json');
    try {
      const files = buildLiveHandoffEnvFiles({
        tempoMppSecretKey: 'existing-tempo-secret-with-32-chars',
        outboundAdminToken: 'existing-agent-admin-with-32-chars',
        signerAdminToken: 'existing-signer-admin-with-32-chars',
        cronSecret: 'existing-cron-secret-with-32-chars',
      });
      await writeFile(agentEnvFile, files.agent);
      await writeFile(signerEnvFile, files.signer);
      await writeFile(inputFile, JSON.stringify({
        ...LIVE_VALUES,
        turnkey_policy_id: '__PASTE_TURNKEY_POLICY_ID__',
      }, null, 2));

      const result = await runApplyLiveHandoffValues({
        inputFile,
        agentEnvFile,
        signerEnvFile,
        write: true,
        allowMissingPolicyId: true,
      });
      const signerEnv = parseEnvText(await readFile(signerEnvFile, 'utf8'));
      const wallets = JSON.parse(signerEnv.AGENT_WALLETS_JSON);

      assert.equal(result.ok, true);
      assert.equal(result.policy_id_deferred, true);
      assert.equal(result.applied_values.turnkey_policy_id, '<deferred-until-policy-created>');
      assert.equal(result.files[1].updated_keys.includes('TURNKEY_POLICY_ID'), false);
      assert.equal(signerEnv.TURNKEY_POLICY_ID, '__FILL_TURNKEY_POLICY_ID__');
      assert.equal(signerEnv.TURNKEY_SIGNER_API_USER_ID, LIVE_VALUES.turnkey_signer_api_user_id);
      assert.equal(signerEnv.TURNKEY_SIGN_WITH, LIVE_VALUES.agent_turnkey_wallet_address);
      assert.equal(wallets[0].wallet_address, LIVE_VALUES.agent_turnkey_wallet_address);
      assert.equal(wallets[0].tempo_access_key_address, LIVE_VALUES.agent_tempo_access_key_address);
      assert(result.next_step.includes('turnkey-policy-draft.js'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects placeholders and dev addresses before touching files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-apply-live-values-reject-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, JSON.stringify({
        ...LIVE_VALUES,
        agent_turnkey_wallet_address: '0x1111111111111111111111111111111111111111',
        turnkey_api_private_key: '__PASTE_TURNKEY_API_PRIVATE_KEY__',
      }));

      const result = await runApplyLiveHandoffValues({
        inputFile,
        agentEnvFile: join(dir, 'missing-agent.env'),
        signerEnvFile: join(dir, 'missing-signer.env'),
        write: true,
      });

      assert.equal(result.ok, false);
      assert.equal(result.wrote_files, false);
      assert(result.blockers.some((blocker) => blocker.includes('agent_turnkey_wallet_address')));
      assert(result.blockers.some((blocker) => blocker.includes('turnkey_api_private_key')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects template, example, and reserved URL hostnames before touching files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-apply-live-values-template-url-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, JSON.stringify({
        ...LIVE_VALUES,
        agent_public_base_url: 'https://your-agent.vercel.app',
        signer_public_base_url: 'https://signer.example.com',
        agent_upstash_redis_rest_url: 'https://agent-upstash.example',
        signer_upstash_redis_rest_url: 'https://signer-upstash.test',
      }));

      const result = await runApplyLiveHandoffValues({
        inputFile,
        agentEnvFile: join(dir, 'missing-agent.env'),
        signerEnvFile: join(dir, 'missing-signer.env'),
        write: true,
      });

      assert.equal(result.ok, false);
      assert.equal(result.wrote_files, false);
      assert(result.blockers.some((blocker) => blocker.includes('agent_public_base_url must be a real public HTTPS URL')));
      assert(result.blockers.some((blocker) => blocker.includes('signer_public_base_url must be a real public HTTPS URL')));
      assert(result.blockers.some((blocker) => blocker.includes('agent_upstash_redis_rest_url must be a real public HTTPS URL')));
      assert(result.blockers.some((blocker) => blocker.includes('signer_upstash_redis_rest_url must be a real public HTTPS URL')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects runtime and wallet cross-field collisions before touching files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-apply-live-values-cross-field-'));
    const inputFile = join(dir, 'live-values.json');
    try {
      await writeFile(inputFile, JSON.stringify({
        ...LIVE_VALUES,
        agent_public_base_url: 'https://shared-runtime-prod.vercel.app',
        signer_public_base_url: 'https://shared-runtime-prod.vercel.app/',
        agent_upstash_redis_rest_url: 'https://shared-redis-prod.upstash.io',
        signer_upstash_redis_rest_url: 'https://shared-redis-prod.upstash.io/',
        agent_upstash_redis_rest_token: 'shared-upstash-secret-with-32-chars',
        signer_upstash_redis_rest_token: 'shared-upstash-secret-with-32-chars',
        agent_tempo_access_key_address: LIVE_VALUES.agent_turnkey_wallet_address,
      }));

      const result = await runApplyLiveHandoffValues({
        inputFile,
        agentEnvFile: join(dir, 'missing-agent.env'),
        signerEnvFile: join(dir, 'missing-signer.env'),
        write: true,
      });

      assert.equal(result.ok, false);
      assert.equal(result.wrote_files, false);
      assert(result.blockers.includes('agent_public_base_url and signer_public_base_url must be different public HTTPS services.'));
      assert.equal(result.blockers.some((blocker) => blocker.includes('upstash_redis_rest_url and signer_upstash_redis_rest_url')), false);
      assert.equal(result.blockers.some((blocker) => blocker.includes('upstash_redis_rest_token and signer_upstash_redis_rest_token')), false);
      assert(result.blockers.includes('agent_turnkey_wallet_address and agent_tempo_access_key_address must be different keys.'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
