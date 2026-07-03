import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { checkAgentProductionReadiness } from '../src/runtime/productionReadiness.js';

describe('agent production readiness', () => {
  it('rejects local defaults before production deploy', () => {
    const env = {};
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('PUBLIC_BASE_URL must be a real public HTTPS URL for production, not a template, example, or reserved hostname.'));
    assert(result.failures.includes('AGENT_STORAGE_BACKEND must be upstash_redis for production autonomous storage.'));
    assert(result.failures.includes('OUTBOUND_LIVE_PAYMENTS must be true for production autonomous outbound spend.'));
  });

  it('accepts a strict production autonomous Tempo configuration', () => {
    const env = validProductionEnv();
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.summary.payment_mode, 'tempo');
    assert.equal(result.summary.storage_backend, 'upstash_redis');
    assert.equal(result.summary.outbound_payment_provider, 'remote_signer');
    assert.equal(result.summary.outbound_signer_https, true);
    assert.equal(result.summary.report_access_proof_required, true);
    assert.equal(result.summary.report_rate_limit_enabled, true);
  });

  it('rejects disabled production report access proof', () => {
    const env = {
      ...validProductionEnv(),
      REQUIRE_REPORT_ACCESS_PROOF: 'false',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('REQUIRE_REPORT_ACCESS_PROOF must be true for production paid report retrieval.'));
  });

  it('rejects disabled production report rate limiting', () => {
    const env = {
      ...validProductionEnv(),
      REPORT_RATE_LIMIT_ENABLED: 'false',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('REPORT_RATE_LIMIT_ENABLED must be true for production paid report routes.'));
  });

  it('rejects unsafe production report rate limit bounds', () => {
    const env = {
      ...validProductionEnv(),
      REPORT_RATE_LIMIT_MAX: '121',
      REPORT_RATE_LIMIT_WINDOW_MS: '999',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('REPORT_RATE_LIMIT_MAX must be between 1 and 120 for production paid report routes.'));
    assert(result.failures.includes('REPORT_RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000.'));
  });

  it('rejects private key material in the public agent runtime', () => {
    const env = {
      ...validProductionEnv(),
      AGENT_ACCESS_KEY_PRIVATE_KEY: 'configured-private-key',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('AGENT_ACCESS_KEY_PRIVATE_KEY must not be present in the public agent production runtime.'));
  });

  it('rejects bootstrap fill placeholders before production use', () => {
    const env = {
      ...validProductionEnv(),
      PUBLIC_BASE_URL: '__FILL_AGENT_PUBLIC_HTTPS_URL__',
      UPSTASH_REDIS_REST_URL: '__FILL_AGENT_UPSTASH_REST_URL__',
      UPSTASH_REDIS_REST_TOKEN: '__FILL_AGENT_UPSTASH_REST_TOKEN__',
      RECEIVE_TEMPO_ADDRESS: '__FILL_RECEIVE_TEMPO_ADDRESS__',
      OUTBOUND_SIGNER_BASE_URL: '__FILL_SIGNER_PUBLIC_HTTPS_URL__',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('PUBLIC_BASE_URL still contains a bootstrap __FILL_*__ placeholder.'));
    assert(result.failures.includes('UPSTASH_REDIS_REST_URL is required for production agent storage.'));
    assert(result.failures.includes('UPSTASH_REDIS_REST_TOKEN is required for production agent storage.'));
    assert(result.failures.includes('RECEIVE_TEMPO_ADDRESS must be a valid public receiving wallet address.'));
    assert(result.failures.includes('OUTBOUND_SIGNER_BASE_URL still contains a bootstrap __FILL_*__ placeholder.'));
  });

  it('rejects template, example, and reserved hostnames before production use', () => {
    const env = {
      ...validProductionEnv(),
      PUBLIC_BASE_URL: 'https://your-agent.vercel.app',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.upstash.io',
      OUTBOUND_SIGNER_BASE_URL: 'https://tempo-outbound-signer.example.com',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('PUBLIC_BASE_URL must be a real public HTTPS URL for production, not a template, example, or reserved hostname.'));
    assert(result.failures.includes('UPSTASH_REDIS_REST_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.'));
    assert(result.failures.includes('OUTBOUND_SIGNER_BASE_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.'));
  });

  it('rejects enabled outbound cron without a strong cron secret', () => {
    const env = {
      ...validProductionEnv(),
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'short',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('CRON_SECRET must be at least 32 characters.'));
    assert(result.failures.includes('OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY must be set to the verified first manual outbound payment idempotency key when cron is enabled.'));
  });

  it('accepts enabled outbound cron only with a verified manual payment arming key', () => {
    const env = {
      ...validProductionEnv(),
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: 'first-live-browserbase-001',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, true);
    assert.equal(result.summary.outbound_cron_enabled, true);
    assert.equal(result.summary.outbound_cron_requires_verified_manual_payment, true);
    assert.equal(result.summary.outbound_cron_arming_idempotency_key_configured, true);
  });

  it('rejects production cron when manual-payment arming is disabled', () => {
    const env = {
      ...validProductionEnv(),
      ENABLE_OUTBOUND_CRON: 'true',
      CRON_SECRET: 'strong-cron-secret-with-32-chars',
      OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT: 'false',
      OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY: 'first-live-browserbase-001',
    };
    const result = checkAgentProductionReadiness(getConfig(env), env);

    assert.equal(result.ok, false);
    assert(result.failures.includes('OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT must remain true in production.'));
  });
});

function validProductionEnv() {
  return {
    PAYMENT_MODE: 'tempo',
    ENABLED_PAYMENT_RAILS: 'tempo',
    PUBLIC_BASE_URL: 'https://tempo-agent-intel-api-prod.vercel.app',
    EXPOSE_RUNTIME_READINESS_DETAILS: 'false',
    REQUIRE_IDEMPOTENCY_KEY_FOR_PAID: 'true',
    REQUIRE_REPORT_ACCESS_PROOF: 'true',
    REPORT_RATE_LIMIT_ENABLED: 'true',
    REPORT_RATE_LIMIT_MAX: '30',
    REPORT_RATE_LIMIT_WINDOW_MS: '60000',
    REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
    AGENT_STORAGE_BACKEND: 'upstash_redis',
    AGENT_STORAGE_REDIS_PREFIX: 'agent-launch-intel-api-prod',
    UPSTASH_REDIS_REST_URL: 'https://agent-redis-prod.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-secret-token',
    RECEIVE_TEMPO_ADDRESS: '0x3333333333333333333333333333333333333333',
    TEMPO_MPP_LIVE_ENABLED: 'true',
    TEMPO_MPP_SECRET_KEY: 'strong-tempo-mpp-secret-with-32-chars',
    TEMPO_MPP_REALM: 'https://tempo-agent-intel-api-prod.vercel.app',
    OUTBOUND_LIVE_PAYMENTS: 'true',
    OUTBOUND_PAYMENT_PROVIDER: 'remote_signer',
    MAX_OUTBOUND_PER_CALL_USD: '0.01',
    MAX_OUTBOUND_DAILY_USD: '0.05',
    OUTBOUND_ALLOWED_SERVICES: 'mpp.browserbase.com',
    OUTBOUND_DENY_UNKNOWN_SERVICES: 'true',
    OUTBOUND_ADMIN_TOKEN: 'strong-outbound-admin-token-32-chars',
    OUTBOUND_SIGNER_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
    OUTBOUND_SIGNER_ADMIN_TOKEN: 'strong-signer-admin-token-32-chars',
    OUTBOUND_SIGNER_AGENT_ID: 'agent-launch-intel',
    OUTBOUND_SIGNER_COMMAND: 'fetch_browserbase_page',
  };
}
