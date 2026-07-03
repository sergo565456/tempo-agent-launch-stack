import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFullStackLiveHandoffCheck } from '../scripts/full-stack-live-handoff-check.js';

describe('full-stack live handoff check', () => {
  it('accepts matched agent and signer handoff env without live actions', async () => {
    const result = await runFullStackLiveHandoffCheck({
      includeProcessEnv: false,
      agentEnv: validAgentEnv(),
      signerEnv: validSignerEnv(),
      accessKeyVerifyOnchain: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.read_only, true);
    assert.equal(result.live_actions, false);
    assert.equal(result.agent.ok, true);
    assert.equal(result.signer.ok, true);
    assert.equal(result.signer_handoff.ok, true);
    assert.equal(result.signer_access_key_readiness.ok, true);
    assert.equal(result.signer_access_key_readiness.verify_onchain, false);
    assert.equal(result.pair_consistency.ok, true);
    assert.equal(result.signer_handoff.checks.find((check) => check.name === 'first_live_test_tiny_caps')?.ok, true);
  });

  it('rejects signer handoff mismatch even when pair readiness is otherwise aligned', async () => {
    const result = await runFullStackLiveHandoffCheck({
      includeProcessEnv: false,
      agentEnv: validAgentEnv(),
      signerEnv: validSignerEnv({
        TURNKEY_SIGN_WITH: '0x6666666666666666666666666666666666666666',
      }),
      accessKeyVerifyOnchain: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.pair_consistency.ok, true);
    assert(result.blockers.some((blocker) => blocker.includes('TURNKEY_SIGN_WITH/turnkey_sign_with must match wallet_address')));
  });

  it('rejects Access Key readiness failure before env upload approval', async () => {
    const result = await runFullStackLiveHandoffCheck({
      includeProcessEnv: false,
      agentEnv: validAgentEnv(),
      signerEnv: validSignerEnv(),
      accessKeyLoadDeps: async () => fakeTempoDeps({
        metadata: {
          address: '0x5555555555555555555555555555555555555555',
          keyType: 'secp256k1',
          expiry: 1n,
          spendPolicy: 'unlimited',
          isRevoked: true,
        },
        remaining: {
          remaining: 90000n,
          periodEnd: 1n,
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.signer_access_key_readiness.ok, false);
    assert(result.blockers.some((blocker) => blocker.includes('signer access key:')));
    assert(result.blockers.some((blocker) => blocker.includes('revoked on-chain')));
    assert(result.blockers.some((blocker) => blocker.includes('must use limited spend policy')));
    assert(result.blockers.some((blocker) => blocker.includes('exceeds the first live safety cap')));
  });

  it('rejects pair token mismatch without leaking token values', async () => {
    const result = await runFullStackLiveHandoffCheck({
      includeProcessEnv: false,
      agentEnv: {
        ...validAgentEnv(),
        OUTBOUND_SIGNER_ADMIN_TOKEN: 'different-agent-signer-token-32-chars',
      },
      signerEnv: validSignerEnv(),
      accessKeyVerifyOnchain: false,
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, false);
    assert(result.blockers.includes('pair: OUTBOUND_SIGNER_ADMIN_TOKEN must match SIGNER_ADMIN_TOKEN.'));
    assert.equal(serialized.includes('different-agent-signer-token-32-chars'), false);
    assert.equal(serialized.includes(sharedSignerToken()), false);
    assert.equal(serialized.includes('turnkey-private-key-configured'), false);
  });
});

function validAgentEnv() {
  return {
    PAYMENT_MODE: 'tempo',
    ENABLED_PAYMENT_RAILS: 'tempo',
    PUBLIC_BASE_URL: 'https://tempo-agent-intel-api-prod.vercel.app',
    EXPOSE_RUNTIME_READINESS_DETAILS: 'false',
    REQUIRE_IDEMPOTENCY_KEY_FOR_PAID: 'true',
    AGENT_STORAGE_BACKEND: 'upstash_redis',
    AGENT_STORAGE_REDIS_PREFIX: 'agent-launch-intel-api-prod',
    ALLOW_SHARED_UPSTASH_BACKEND: 'true',
    UPSTASH_REDIS_REST_URL: 'https://agent-redis-prod.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'agent-upstash-token',
    RECEIVE_TEMPO_ADDRESS: '0x3333333333333333333333333333333333333333',
    TEMPO_MPP_LIVE_ENABLED: 'true',
    TEMPO_MPP_SECRET_KEY: 'strong-tempo-mpp-secret-with-32-chars',
    TEMPO_MPP_REALM: 'https://tempo-agent-intel-api-prod.vercel.app',
    TEMPO_CHAIN_ID: '4217',
    TEMPO_RPC_URL: 'https://rpc.tempo.xyz',
    TEMPO_USDC_ADDRESS: '0x20c000000000000000000000b9537d11c60e8b50',
    TEMPO_TOKEN_DECIMALS: '6',
    OUTBOUND_LIVE_PAYMENTS: 'true',
    OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
    MAX_OUTBOUND_PER_CALL_USD: '0.01',
    MAX_OUTBOUND_DAILY_USD: '0.05',
    OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    OUTBOUND_DENY_UNKNOWN_SERVICES: 'true',
    OUTBOUND_ADMIN_TOKEN: 'strong-outbound-admin-token-32-chars',
    OUTBOUND_SIGNER_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
    OUTBOUND_SIGNER_ADMIN_TOKEN: sharedSignerToken(),
    OUTBOUND_SIGNER_AGENT_ID: 'agent-launch-intel',
    OUTBOUND_SIGNER_COMMAND: 'fetch_browserbase_page',
    OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS: '10000',
    OUTBOUND_BROWSERBASE_FETCH_RECIPIENT: '0x9d27dc344b981264208583a6fc88b8c137d9e4b3',
  };
}

function validSignerEnv(overrides = {}) {
  const walletAddress = '0x4444444444444444444444444444444444444444';
  const wallet = {
    agent_id: 'agent-launch-intel',
    wallet_address: walletAddress,
    tempo_access_key_address: '0x5555555555555555555555555555555555555555',
    turnkey_sign_with: walletAddress,
    enabled: true,
    per_call_limit_base_units: '10000',
    daily_limit_base_units: '50000',
    allowed_services: ['mpp.browserbase.com'],
    allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
    allowed_recipients: ['0x9d27dc344b981264208583a6fc88b8c137d9e4b3'],
    allowed_commands: ['fetch_browserbase_page'],
  };

  return {
    LIVE_READINESS_MODE: 'production',
    PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
    SIGNER_PROVIDER: 'turnkey',
    SIGNER_ADMIN_TOKEN: sharedSignerToken(),
    SIGNER_LEDGER_DURABLE: 'true',
    SIGNER_LEDGER_BACKEND: 'upstash_redis',
    SIGNER_LEDGER_REDIS_PREFIX: 'tempo-outbound-signer-prod',
    ALLOW_SHARED_UPSTASH_BACKEND: 'true',
    UPSTASH_REDIS_REST_URL: 'https://signer-redis-prod.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'signer-upstash-token',
    TEMPO_CHAIN_ID: '4217',
    TEMPO_RPC_URL: 'https://rpc.tempo.xyz',
    TEMPO_USDC_ADDRESS: '0x20c000000000000000000000b9537d11c60e8b50',
    TEMPO_TOKEN_DECIMALS: '6',
    TURNKEY_ORGANIZATION_ID: 'turnkey-org-id',
    TURNKEY_API_PUBLIC_KEY: 'turnkey-public-key',
    TURNKEY_API_PRIVATE_KEY: 'turnkey-private-key-configured',
    TURNKEY_POLICY_ID: 'turnkey-policy-id',
    TURNKEY_SIGNER_API_USER_ID: 'user_signer_api',
    TURNKEY_SIGN_WITH_MODE: 'wallet',
    TURNKEY_SIGN_WITH: walletAddress,
    AGENT_WALLETS_JSON: JSON.stringify([wallet]),
    ...overrides,
  };
}

function sharedSignerToken() {
  return 'shared-signer-admin-token-32-chars';
}

function fakeTempoDeps({ metadata, remaining }) {
  return {
    createClient: (params) => ({ params }),
    http: (url) => ({ type: 'http', url }),
    tempo: {
      extend: (params) => ({ id: 4217, ...params }),
    },
    Actions: {
      accessKey: {
        getMetadata: async () => metadata,
        getRemainingLimit: async () => remaining,
      },
    },
  };
}
