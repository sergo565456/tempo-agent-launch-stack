import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurnkeyLiveHandoffCheck } from '../scripts/turnkey-live-handoff-check.js';

describe('Turnkey live handoff check', () => {
  it('accepts a strict first-live handoff without leaking secrets', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv());

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });
      const serialized = JSON.stringify(summary);

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.readiness.mode, 'test');
      assert(summary.env_file.loaded_keys.includes('TURNKEY_API_PRIVATE_KEY'));
      assert(!serialized.includes('strong-signer-admin-token-0000000001'));
      assert(!serialized.includes('turnkey-private-key-secret-0000000001'));
      assert.equal(summary.checks.find((check) => check.name === 'first_live_test_tiny_caps')?.ok, true);
      assert.equal(summary.checks.find((check) => check.name === 'agent_agent-launch-intel_turnkey_sign_with_matches_wallet')?.ok, true);
      assert.equal(summary.checks.find((check) => check.name === 'turnkey_sign_with_mode_supported')?.ok, true);
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('accepts a strict Codex GraphQL first-live handoff', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv({
      AGENT_WALLETS_JSON: JSON.stringify([
        agentWallet({
          per_call_limit_base_units: '1000',
          daily_limit_base_units: '1000',
          allowed_services: ['graph.codex.io'],
          allowed_endpoints: ['https://graph.codex.io/graphql'],
          allowed_recipients: ['0xc12B5D802Da90d14a8b35dEc1cFb6fd5ceeDE60B'],
          allowed_commands: ['codex_graphql_query'],
        }),
      ]),
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });

      assert.equal(summary.ok, true);
      assert.equal(summary.checks.find((check) => check.name === 'agent_agent-launch-intel_single_service')?.ok, true);
      assert.equal(summary.checks.find((check) => check.name === 'agent_agent-launch-intel_single_endpoint')?.ok, true);
      assert.equal(summary.checks.find((check) => check.name === 'agent_agent-launch-intel_endpoint_matches_service')?.ok, true);
      assert.equal(summary.checks.find((check) => check.name === 'agent_agent-launch-intel_single_supported_command')?.ok, true);
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('accepts a strict audited access-key handoff without leaking raw-signing secrets', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv({
      TURNKEY_SIGN_WITH_MODE: 'access_key',
      TURNKEY_ACCESS_KEY_SIGN_WITH: '0x4444444444444444444444444444444444444444',
      TURNKEY_ACCESS_KEY_PUBLIC_KEY: `02${'44'.repeat(32)}`,
      TURNKEY_ACCESS_KEY_POLICY_ID: 'policy_access_key_test',
      TURNKEY_ACCESS_KEY_MODE_AUDITED: 'true',
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });
      const serialized = JSON.stringify(summary);

      assert.equal(summary.ok, true);
      assert.equal(summary.read_only, true);
      assert.equal(summary.checks.find((check) => check.name === 'turnkey_sign_with_mode_supported')?.ok, true);
      assert.equal(summary.checks.find((check) => check.name === 'agent_agent-launch-intel_access_key_sign_with_matches_access_key')?.ok, true);
      assert(!serialized.includes('turnkey-private-key-secret-0000000001'));
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('rejects a Turnkey sign-with address that would fail at execution time', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv({
      TURNKEY_SIGN_WITH: '0x5555555555555555555555555555555555555555',
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });

      assert.equal(summary.ok, false);
      assert(summary.blockers.some((blocker) => blocker.includes('TURNKEY_SIGN_WITH/turnkey_sign_with must match wallet_address')));
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('rejects a Turnkey Access Key sign-with address that would fail at execution time', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv({
      TURNKEY_SIGN_WITH_MODE: 'access_key',
      TURNKEY_ACCESS_KEY_SIGN_WITH: '0x5555555555555555555555555555555555555555',
      TURNKEY_ACCESS_KEY_PUBLIC_KEY: `02${'44'.repeat(32)}`,
      TURNKEY_ACCESS_KEY_POLICY_ID: 'policy_access_key_test',
      TURNKEY_ACCESS_KEY_MODE_AUDITED: 'true',
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });

      assert.equal(summary.ok, false);
      assert(summary.blockers.some((blocker) => blocker.includes('TURNKEY_ACCESS_KEY_SIGN_WITH must match tempo_access_key_address')));
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('rejects identical Turnkey wallet and Tempo Access Key addresses', async () => {
    const sameAddress = '0x3333333333333333333333333333333333333333';
    const envFile = await writeEnvFile(validFirstLiveEnv({
      AGENT_WALLETS_JSON: JSON.stringify([
        agentWallet({
          wallet_address: sameAddress,
          tempo_access_key_address: sameAddress,
          turnkey_sign_with: sameAddress,
        }),
      ]),
      TURNKEY_SIGN_WITH: sameAddress,
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });

      assert.equal(summary.ok, false);
      assert(summary.blockers.some((blocker) => blocker.includes('wallet_address and tempo_access_key_address must be different keys')));
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('rejects first-live test caps wider than the pinned tiny payment policy', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv({
      AGENT_WALLETS_JSON: JSON.stringify([
        agentWallet({
          per_call_limit_base_units: '50000',
          daily_limit_base_units: '50000',
        }),
      ]),
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });

      assert.equal(summary.ok, false);
      assert(summary.blockers.includes('First live test caps must be <= 0.01 USDC.e per call and <= 0.05 USDC.e daily.'));
      assert.equal(summary.readiness.ok, true);
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('rejects bootstrap fill placeholders as unconfigured handoff values', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv({
      TURNKEY_ORGANIZATION_ID: '__FILL_TURNKEY_ORGANIZATION_ID__',
      TURNKEY_API_PUBLIC_KEY: '__FILL_TURNKEY_API_PUBLIC_KEY__',
      TURNKEY_API_PRIVATE_KEY: '__FILL_TURNKEY_API_PRIVATE_KEY__',
      TURNKEY_POLICY_ID: '__FILL_TURNKEY_POLICY_ID__',
      TURNKEY_SIGNER_API_USER_ID: '__FILL_TURNKEY_SIGNER_API_USER_ID__',
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });

      assert.equal(summary.ok, false);
      assert.equal(summary.checks.find((check) => check.name === 'turnkey_org_configured')?.ok, false);
      assert.equal(summary.checks.find((check) => check.name === 'turnkey_api_public_key_configured')?.ok, false);
      assert.equal(summary.checks.find((check) => check.name === 'turnkey_api_private_key_configured')?.ok, false);
      assert.equal(summary.checks.find((check) => check.name === 'turnkey_policy_id_configured')?.ok, false);
      assert.equal(summary.checks.find((check) => check.name === 'turnkey_signer_api_user_configured')?.ok, false);
    } finally {
      await removeEnvFile(envFile);
    }
  });

  it('rejects template and example public signer URLs before live handoff', async () => {
    const envFile = await writeEnvFile(validFirstLiveEnv({
      PUBLIC_BASE_URL: 'https://your-signer.vercel.app',
    }));

    try {
      const summary = await runTurnkeyLiveHandoffCheck({ envFile });

      assert.equal(summary.ok, false);
      assert.equal(summary.checks.find((check) => check.name === 'public_base_url_https')?.ok, false);
      assert(summary.blockers.includes('PUBLIC_BASE_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.'));
    } finally {
      await removeEnvFile(envFile);
    }
  });
});

function validFirstLiveEnv(overrides = {}) {
  return {
    SIGNER_PROVIDER: 'turnkey',
    SIGNER_ADMIN_TOKEN: 'strong-signer-admin-token-0000000001',
    PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
    LIVE_READINESS_MODE: 'test',
    SIGNER_LEDGER_DURABLE: 'false',
    SIGNER_LEDGER_BACKEND: 'file',
    SIGNER_LEDGER_REDIS_PREFIX: 'tempo-outbound-signer-test',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    TEMPO_CHAIN_ID: '4217',
    TEMPO_RPC_URL: 'https://rpc.tempo.xyz',
    TEMPO_USDC_ADDRESS: '0x20c000000000000000000000b9537d11c60e8b50',
    TEMPO_TOKEN_DECIMALS: '6',
    AGENT_WALLETS_JSON: JSON.stringify([agentWallet()]),
    TURNKEY_API_BASE_URL: 'https://api.turnkey.com',
    TURNKEY_ORGANIZATION_ID: 'org_test',
    TURNKEY_API_PUBLIC_KEY: 'turnkey-public-key',
    TURNKEY_API_PRIVATE_KEY: 'turnkey-private-key-secret-0000000001',
    TURNKEY_POLICY_ID: 'policy_test',
    TURNKEY_SIGNER_API_USER_ID: 'user_signer_api',
    TURNKEY_SIGN_WITH_MODE: 'wallet',
    TURNKEY_SIGN_WITH: '0x3333333333333333333333333333333333333333',
    TURNKEY_SPONSOR_WITH: '',
    ...overrides,
  };
}

function agentWallet(overrides = {}) {
  return {
    agent_id: 'agent-launch-intel',
    wallet_address: '0x3333333333333333333333333333333333333333',
    tempo_access_key_address: '0x4444444444444444444444444444444444444444',
    turnkey_sign_with: '0x3333333333333333333333333333333333333333',
    enabled: true,
    per_call_limit_base_units: '10000',
    daily_limit_base_units: '50000',
    allowed_services: ['mpp.browserbase.com'],
    allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
    allowed_recipients: ['0x9d27dc344b981264208583a6fc88b8c137d9e4b3'],
    allowed_commands: ['fetch_browserbase_page'],
    ...overrides,
  };
}

async function writeEnvFile(values) {
  const dir = await mkdtemp(join(tmpdir(), 'tempo-signer-handoff-'));
  const file = join(dir, 'signer-live.env');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${formatValue(value)}`);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

async function removeEnvFile(file) {
  await rm(file.replace(/\\signer-live\.env$/, ''), { recursive: true, force: true });
}

function formatValue(value) {
  const text = String(value);
  return text.includes(' ') || text.includes('[') || text.includes('{') ? JSON.stringify(text) : text;
}
