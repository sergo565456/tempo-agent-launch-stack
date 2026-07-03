import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPredeployPairReadiness } from '../scripts/predeploy-pair-readiness.js';

describe('predeploy pair readiness', () => {
  it('accepts a matched production agent and signer configuration', async () => {
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: validAgentEnv(),
      signerEnv: validSignerEnv(),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.consistency.matched.signer_url_matches, true);
    assert.equal(result.consistency.matched.admin_token_matches, true);
    assert.equal(result.consistency.matched.agent_policy_found, true);
    assert.equal(result.consistency.matched.requested_amount_within_signer_limit, true);
  });

  it('accepts a matched Codex GraphQL production target', async () => {
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: validCodexAgentEnv(),
      signerEnv: validCodexSignerEnv(),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.consistency.matched.command_allowed, true);
    assert.equal(result.consistency.matched.service_scope_aligned, true);
    assert.equal(result.consistency.matched.endpoint_allowed, true);
    assert.equal(result.consistency.matched.recipient_allowed, true);
    assert.equal(result.consistency.summary.requested_amount_base_units, '1000');
  });

  it('rejects a signer URL mismatch', async () => {
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: {
        ...validAgentEnv(),
        OUTBOUND_SIGNER_BASE_URL: 'https://wrong-signer-prod.vercel.app',
      },
      signerEnv: validSignerEnv(),
    });

    assert.equal(result.ok, false);
    assert(result.failures.includes('pair: OUTBOUND_SIGNER_BASE_URL must exactly match signer PUBLIC_BASE_URL.'));
  });

  it('rejects an admin token mismatch without returning token values', async () => {
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: {
        ...validAgentEnv(),
        OUTBOUND_SIGNER_ADMIN_TOKEN: 'different-agent-token-value-with-32-chars',
      },
      signerEnv: validSignerEnv(),
    });

    assert.equal(result.ok, false);
    assert(result.failures.includes('pair: OUTBOUND_SIGNER_ADMIN_TOKEN must match SIGNER_ADMIN_TOKEN.'));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('different-agent-token-value-with-32-chars'), false);
    assert.equal(serialized.includes(sharedSignerToken()), false);
  });

  it('rejects signer policy scope that is wider than the agent cap', async () => {
    const signerEnv = validSignerEnv({
      perCallLimitBaseUnits: '20000',
    });
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: validAgentEnv(),
      signerEnv,
    });

    assert.equal(result.ok, false);
    assert(result.failures.includes('pair: Signer per_call_limit_base_units must not exceed agent MAX_OUTBOUND_PER_CALL_USD.'));
  });

  it('allows a shared Upstash backend when Redis prefixes differ', async () => {
    const sharedUpstashToken = 'shared-upstash-token-with-32-chars';
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: {
        ...validAgentEnv(),
        ALLOW_SHARED_UPSTASH_BACKEND: 'true',
        UPSTASH_REDIS_REST_URL: 'https://shared-redis-prod.upstash.io/',
        UPSTASH_REDIS_REST_TOKEN: sharedUpstashToken,
      },
      signerEnv: {
        ...validSignerEnv(),
        PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
        ALLOW_SHARED_UPSTASH_BACKEND: 'true',
        UPSTASH_REDIS_REST_URL: 'https://shared-redis-prod.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: sharedUpstashToken,
      },
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.consistency.matched.shared_upstash_backend_detected, true);
    assert.equal(result.consistency.matched.shared_upstash_backend_explicitly_allowed, true);
    assert.equal(result.consistency.matched.durable_ledger_prefixes_explicitly_configured, true);
    assert.equal(result.consistency.matched.durable_ledger_prefixes_distinct, true);
    assert.equal(result.consistency.matched.durable_ledger_isolation_ok, true);
    assert.equal(result.consistency.matched.durable_ledger_token_isolation_ok, true);
    assert(result.warnings.includes('pair: Agent and signer share one Upstash REST backend by explicit production choice; isolation relies on distinct Redis prefixes and the shared token can access both namespaces.'));
    assert.equal(serialized.includes(sharedUpstashToken), false);
  });

  it('rejects a shared Upstash backend unless both runtimes explicitly allow it', async () => {
    const sharedUpstashToken = 'shared-upstash-token-with-32-chars';
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: {
        ...validAgentEnv(),
        UPSTASH_REDIS_REST_URL: 'https://shared-redis-prod.upstash.io/',
        UPSTASH_REDIS_REST_TOKEN: sharedUpstashToken,
      },
      signerEnv: {
        ...validSignerEnv(),
        UPSTASH_REDIS_REST_URL: 'https://shared-redis-prod.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: sharedUpstashToken,
      },
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, false);
    assert(result.failures.includes('pair: Shared Upstash backend requires ALLOW_SHARED_UPSTASH_BACKEND=true in both agent and signer env files.'));
    assert.equal(result.consistency.matched.shared_upstash_backend_detected, true);
    assert.equal(result.consistency.matched.shared_upstash_backend_explicitly_allowed, false);
    assert.equal(serialized.includes(sharedUpstashToken), false);
  });

  it('rejects manually edited env files that collapse public runtimes or shared Redis prefixes', async () => {
    const sharedUpstashToken = 'shared-upstash-token-with-32-chars';
    const result = await runPredeployPairReadiness({
      includeProcessEnv: false,
      agentEnv: {
        ...validAgentEnv(),
        PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app/',
        ALLOW_SHARED_UPSTASH_BACKEND: 'true',
        AGENT_STORAGE_REDIS_PREFIX: 'shared-live-prefix',
        UPSTASH_REDIS_REST_URL: 'https://shared-redis-prod.upstash.io/',
        UPSTASH_REDIS_REST_TOKEN: sharedUpstashToken,
      },
      signerEnv: {
        ...validSignerEnv(),
        PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
        ALLOW_SHARED_UPSTASH_BACKEND: 'true',
        SIGNER_LEDGER_REDIS_PREFIX: 'shared-live-prefix',
        UPSTASH_REDIS_REST_URL: 'https://shared-redis-prod.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: sharedUpstashToken,
      },
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, false);
    assert(result.failures.includes('pair: Agent PUBLIC_BASE_URL must be different from signer PUBLIC_BASE_URL.'));
    assert(result.failures.includes('pair: Agent and signer Redis prefixes must be different when sharing an Upstash backend.'));
    assert(result.failures.includes('pair: Agent and signer UPSTASH_REDIS_REST_TOKEN must be different unless the shared Upstash backend uses different Redis prefixes.'));
    assert.equal(serialized.includes(sharedUpstashToken), false);
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

function validCodexAgentEnv() {
  return {
    ...validAgentEnv(),
    MAX_OUTBOUND_PER_CALL_USD: '0.002',
    MAX_OUTBOUND_DAILY_USD: '0.01',
    OUTBOUND_ALLOWED_SERVICES: 'graph.codex.io',
    OUTBOUND_SIGNER_COMMAND: 'codex_graphql_query',
    OUTBOUND_TARGET_SERVICE: 'graph.codex.io',
    OUTBOUND_TARGET_ENDPOINT: 'https://graph.codex.io/graphql',
    OUTBOUND_TARGET_AMOUNT_BASE_UNITS: '1000',
    OUTBOUND_TARGET_RECIPIENT: '0xc12B5D802Da90d14a8b35dEc1cFb6fd5ceeDE60B',
  };
}

function validSignerEnv(overrides = {}) {
  const wallet = {
    agent_id: 'agent-launch-intel',
    wallet_address: '0x4444444444444444444444444444444444444444',
    tempo_access_key_address: '0x5555555555555555555555555555555555555555',
    turnkey_sign_with: '0x4444444444444444444444444444444444444444',
    enabled: true,
    per_call_limit_base_units: overrides.perCallLimitBaseUnits || '10000',
    daily_limit_base_units: overrides.dailyLimitBaseUnits || '50000',
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
    AGENT_WALLETS_JSON: JSON.stringify([wallet]),
  };
}

function validCodexSignerEnv() {
  const wallet = {
    agent_id: 'agent-launch-intel',
    wallet_address: '0x4444444444444444444444444444444444444444',
    tempo_access_key_address: '0x5555555555555555555555555555555555555555',
    turnkey_sign_with: '0x4444444444444444444444444444444444444444',
    enabled: true,
    per_call_limit_base_units: '1000',
    daily_limit_base_units: '1000',
    allowed_services: ['graph.codex.io'],
    allowed_endpoints: ['https://graph.codex.io/graphql'],
    allowed_recipients: ['0xc12B5D802Da90d14a8b35dEc1cFb6fd5ceeDE60B'],
    allowed_commands: ['codex_graphql_query'],
  };

  return {
    ...validSignerEnv(),
    AGENT_WALLETS_JSON: JSON.stringify([wallet]),
  };
}

function sharedSignerToken() {
  return 'shared-signer-admin-token-32-chars';
}
