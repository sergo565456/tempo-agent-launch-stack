import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { checkLiveReadiness } from '../src/liveReadiness.js';

describe('live readiness', () => {
  it('rejects production mode without a durable Upstash ledger', () => {
    const env = validProductionEnv({
      SIGNER_LEDGER_BACKEND: 'file',
      SIGNER_LEDGER_DURABLE: 'true',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('Production mode requires SIGNER_LEDGER_BACKEND=upstash_redis.'));
    assert(result.failures.includes('Production mode requires UPSTASH_REDIS_REST_URL for the signer ledger.'));
    assert(result.failures.includes('Production mode requires UPSTASH_REDIS_REST_TOKEN for the signer ledger.'));
  });

  it('accepts production mode with durable Upstash ledger env configured', () => {
    const env = validProductionEnv();
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, true);
    assert.equal(result.summary.ledger_backend, 'upstash_redis');
    assert.equal(result.summary.admin_rate_limit_enabled, true);
  });

  it('accepts AGENT_WALLETS_JSON with accidental env wrapper quotes', () => {
    const env = validProductionEnv();
    env.AGENT_WALLETS_JSON = `'${env.AGENT_WALLETS_JSON}'`;
    const config = getConfig(env);
    const result = checkLiveReadiness(config, env);

    assert.equal(config.agentWallets.length, 1);
    assert.equal(config.agentWallets[0].agent_id, 'agent-launch-intel');
    assert.equal(result.ok, true);
  });

  it('accepts audited access_key mode with dedicated raw-signing values', () => {
    const env = validProductionEnv({
      TURNKEY_SIGN_WITH_MODE: 'access_key',
      TURNKEY_ACCESS_KEY_MODE_AUDITED: 'true',
      TURNKEY_ACCESS_KEY_SIGN_WITH: '0x4444444444444444444444444444444444444444',
      TURNKEY_ACCESS_KEY_PUBLIC_KEY: '0x04accesskeypublichexplaceholder',
      TURNKEY_ACCESS_KEY_POLICY_ID: 'policy_access_key_123',
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, true);
    assert.equal(result.summary.turnkey_sign_with_mode, 'access_key');
  });

  it('rejects access_key mode without audited raw-signing values', () => {
    const env = validProductionEnv({
      TURNKEY_SIGN_WITH_MODE: 'access_key',
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('TURNKEY_ACCESS_KEY_MODE_AUDITED must be true after implementation and security audit before access_key live use.'));
    assert(result.failures.includes('TURNKEY_ACCESS_KEY_SIGN_WITH is required for access_key mode.'));
    assert(result.failures.includes('TURNKEY_ACCESS_KEY_PUBLIC_KEY is required for access_key mode.'));
    assert(result.failures.includes('TURNKEY_ACCESS_KEY_POLICY_ID is required for the reviewed raw-signing policy.'));
  });

  it('rejects disabled production signer admin rate limiting', () => {
    const env = validProductionEnv({
      SIGNER_ADMIN_RATE_LIMIT_ENABLED: 'false',
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED must be true for production signer admin routes.'));
  });

  it('rejects unsafe production signer admin rate limit bounds', () => {
    const env = validProductionEnv({
      SIGNER_ADMIN_RATE_LIMIT_MAX: '121',
      SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS: '999',
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('SIGNER_ADMIN_RATE_LIMIT_MAX must be between 1 and 120 for production signer admin routes.'));
    assert(result.failures.includes('SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000.'));
  });

  it('rejects identical wallet and access key addresses', () => {
    const sameAddress = '0x3333333333333333333333333333333333333333';
    const env = validProductionEnv({
      AGENT_WALLETS_JSON: JSON.stringify([
        {
          ...agentWallet(),
          wallet_address: sameAddress,
          tempo_access_key_address: sameAddress,
          turnkey_sign_with: sameAddress,
        },
      ]),
      TURNKEY_SIGN_WITH: sameAddress,
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('agent-launch-intel.wallet_address and tempo_access_key_address must be different keys.'));
  });

  it('rejects bootstrap fill placeholders before live use', () => {
    const env = validProductionEnv({
      PUBLIC_BASE_URL: '__FILL_SIGNER_PUBLIC_HTTPS_URL__',
      UPSTASH_REDIS_REST_URL: '__FILL_SIGNER_UPSTASH_REST_URL__',
      UPSTASH_REDIS_REST_TOKEN: '__FILL_SIGNER_UPSTASH_REST_TOKEN__',
      TURNKEY_ORGANIZATION_ID: '__FILL_TURNKEY_ORGANIZATION_ID__',
      TURNKEY_API_PUBLIC_KEY: '__FILL_TURNKEY_API_PUBLIC_KEY__',
      TURNKEY_API_PRIVATE_KEY: '__FILL_TURNKEY_API_PRIVATE_KEY__',
      TURNKEY_POLICY_ID: '__FILL_TURNKEY_POLICY_ID__',
      TURNKEY_SIGNER_API_USER_ID: '__FILL_TURNKEY_SIGNER_API_USER_ID__',
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('PUBLIC_BASE_URL still contains a bootstrap __FILL_*__ placeholder.'));
    assert(result.failures.includes('UPSTASH_REDIS_REST_URL still contains a bootstrap __FILL_*__ placeholder.'));
    assert(result.failures.includes('Production mode requires UPSTASH_REDIS_REST_TOKEN for the signer ledger.'));
    assert(result.failures.includes('TURNKEY_ORGANIZATION_ID is required.'));
    assert(result.failures.includes('TURNKEY_API_PUBLIC_KEY is required.'));
    assert(result.failures.includes('TURNKEY_API_PRIVATE_KEY is required in the secret runtime environment.'));
    assert(result.failures.includes('TURNKEY_POLICY_ID is required so Turnkey can enforce signer-side policy.'));
    assert(result.failures.includes('TURNKEY_SIGNER_API_USER_ID is required so the Turnkey policy consensus can target the API-only signer user.'));
  });

  it('rejects template, example, and reserved hostnames before production use', () => {
    const env = validProductionEnv({
      PUBLIC_BASE_URL: 'https://your-signer.vercel.app',
      UPSTASH_REDIS_REST_URL: 'https://signer-redis.example',
    });
    const result = checkLiveReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('PUBLIC_BASE_URL must be a real public HTTPS URL for live use, not a template, example, or reserved hostname.'));
    assert(result.failures.includes('UPSTASH_REDIS_REST_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.'));
  });
});

function validProductionEnv(overrides = {}) {
  return {
    SIGNER_PROVIDER: 'turnkey',
    SIGNER_ADMIN_TOKEN: 'strong-admin-token-with-40-characters-001',
    SIGNER_ADMIN_RATE_LIMIT_ENABLED: 'true',
    SIGNER_ADMIN_RATE_LIMIT_MAX: '60',
    SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS: '60000',
    SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
    PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
    LIVE_READINESS_MODE: 'production',
    SIGNER_LEDGER_DURABLE: 'true',
    SIGNER_LEDGER_BACKEND: 'upstash_redis',
    SIGNER_LEDGER_REDIS_PREFIX: 'tempo-outbound-signer-test',
    UPSTASH_REDIS_REST_URL: 'https://signer-redis-prod.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-secret-token',
    TEMPO_CHAIN_ID: '4217',
    TEMPO_RPC_URL: 'https://rpc.tempo.xyz',
    TEMPO_USDC_ADDRESS: '0x20c000000000000000000000b9537d11c60e8b50',
    TEMPO_TOKEN_DECIMALS: '6',
    AGENT_WALLETS_JSON: JSON.stringify([
      {
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
      },
    ]),
    TURNKEY_API_BASE_URL: 'https://api.turnkey.com',
    TURNKEY_ORGANIZATION_ID: 'org_123',
    TURNKEY_API_PUBLIC_KEY: 'public-key',
    TURNKEY_API_PRIVATE_KEY: 'private-key',
    TURNKEY_POLICY_ID: 'policy_123',
    TURNKEY_SIGNER_API_USER_ID: 'user_signer_api',
    TURNKEY_SIGN_WITH_MODE: 'wallet',
    TURNKEY_SIGN_WITH: '0x3333333333333333333333333333333333333333',
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
