const DEV_PLACEHOLDER_ADDRESSES = new Set([
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]);

const TEST_MAX_PER_CALL_BASE_UNITS = 50_000n;
const TEST_MAX_DAILY_BASE_UNITS = 500_000n;

export function checkLiveReadiness(config, env = process.env) {
  const mode = env.LIVE_READINESS_MODE || 'test';
  const failures = [];
  const warnings = [];

  if (!['test', 'production'].includes(mode)) {
    failures.push('LIVE_READINESS_MODE must be test or production.');
  }

  if (config.provider !== 'turnkey') {
    failures.push('SIGNER_PROVIDER must be turnkey for live readiness.');
  }

  checkAdminToken(config, failures);
  checkPublicBaseUrl(config, failures);
  checkTempoConfig(config, failures);
  checkTurnkeyConfig(config, failures);
  checkAgentPolicies(config, mode, failures);
  checkLedgerConfig(config, env, mode, failures, warnings);
  checkAdminRateLimit(config, mode, failures);

  return {
    ok: failures.length === 0,
    mode,
    failures,
    warnings,
    summary: {
      provider: config.provider,
      agent_count: config.agentWallets.length,
      tempo_chain_id: config.tempoChainId,
      tempo_rpc_configured: Boolean(config.tempoRpcUrl),
      tempo_token_decimals: config.tempoTokenDecimals,
      turnkey_org_configured: Boolean(config.turnkey.organizationId) && !isFillPlaceholder(config.turnkey.organizationId),
      turnkey_policy_configured: Boolean(config.turnkey.policyId) && !isFillPlaceholder(config.turnkey.policyId),
      turnkey_signer_api_user_configured: Boolean(config.turnkey.signerApiUserId) && !isFillPlaceholder(config.turnkey.signerApiUserId),
      turnkey_sign_with_mode: config.turnkey.signWithMode,
      ledger_backend: config.ledgerBackend,
      admin_rate_limit_enabled: config.adminRateLimit.enabled,
      admin_rate_limit_max: config.adminRateLimit.max,
      admin_rate_limit_window_ms: config.adminRateLimit.windowMs,
    },
  };
}

function checkAdminToken(config, failures) {
  const token = config.signerAdminToken;
  if (!token) {
    failures.push('SIGNER_ADMIN_TOKEN is required.');
    return;
  }

  if (token.length < 32) {
    failures.push('SIGNER_ADMIN_TOKEN must be at least 32 characters for live use.');
  }

  if (['local-dev-token', 'smoke-token'].includes(token)) {
    failures.push('SIGNER_ADMIN_TOKEN must not use a documented demo token.');
  }
}

function checkPublicBaseUrl(config, failures) {
  if (isFillPlaceholder(config.publicBaseUrl)) {
    failures.push('PUBLIC_BASE_URL still contains a bootstrap __FILL_*__ placeholder.');
    return;
  }

  let url;
  try {
    url = new URL(config.publicBaseUrl);
  } catch {
    failures.push('PUBLIC_BASE_URL must be a valid URL.');
    return;
  }

  if (url.protocol !== 'https:' || isDisallowedLiveHostname(url.hostname)) {
    failures.push('PUBLIC_BASE_URL must be a real public HTTPS URL for live use, not a template, example, or reserved hostname.');
  }
}

function checkTempoConfig(config, failures) {
  if (config.tempoChainId !== 4217) {
    failures.push('TEMPO_CHAIN_ID must be 4217 for this Tempo signer profile.');
  }

  try {
    const rpcUrl = new URL(config.tempoRpcUrl);
    if (rpcUrl.protocol !== 'https:') {
      failures.push('TEMPO_RPC_URL must use HTTPS for live use.');
    }
    if (['localhost', '127.0.0.1', '::1'].includes(rpcUrl.hostname)) {
      failures.push('TEMPO_RPC_URL must not point to localhost for live use.');
    }
  } catch {
    failures.push('TEMPO_RPC_URL must be a valid URL.');
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(config.tempoUsdcAddress)) {
    failures.push('TEMPO_USDC_ADDRESS must be an EVM token address.');
  }

  if (config.tempoTokenDecimals !== 6) {
    failures.push('TEMPO_TOKEN_DECIMALS must be 6 for USDC.e amounts.');
  }
}

function checkTurnkeyConfig(config, failures) {
  if (!config.turnkey.organizationId || isFillPlaceholder(config.turnkey.organizationId)) {
    failures.push('TURNKEY_ORGANIZATION_ID is required.');
  }

  if (!config.turnkey.apiPublicKey || isFillPlaceholder(config.turnkey.apiPublicKey)) {
    failures.push('TURNKEY_API_PUBLIC_KEY is required.');
  }

  if (!config.turnkey.apiPrivateKeyConfigured || isFillPlaceholder(config.turnkey.apiPrivateKey)) {
    failures.push('TURNKEY_API_PRIVATE_KEY is required in the secret runtime environment.');
  }

  if (!config.turnkey.policyId || isFillPlaceholder(config.turnkey.policyId)) {
    failures.push('TURNKEY_POLICY_ID is required so Turnkey can enforce signer-side policy.');
  }

  if (!config.turnkey.signerApiUserId || isFillPlaceholder(config.turnkey.signerApiUserId)) {
    failures.push('TURNKEY_SIGNER_API_USER_ID is required so the Turnkey policy consensus can target the API-only signer user.');
  }

  if (!['wallet', 'access_key'].includes(config.turnkey.signWithMode)) {
    failures.push('TURNKEY_SIGN_WITH_MODE must be wallet or access_key.');
  }

  if (config.turnkey.signWithMode === 'access_key') {
    if (config.turnkey.accessKeyModeAudited !== true) {
      failures.push('TURNKEY_ACCESS_KEY_MODE_AUDITED must be true after implementation and security audit before access_key live use.');
    }
    if (!config.turnkey.accessKeySignWith || isFillPlaceholder(config.turnkey.accessKeySignWith)) {
      failures.push('TURNKEY_ACCESS_KEY_SIGN_WITH is required for access_key mode.');
    }
    if (!config.turnkey.accessKeyPublicKey || isFillPlaceholder(config.turnkey.accessKeyPublicKey)) {
      failures.push('TURNKEY_ACCESS_KEY_PUBLIC_KEY is required for access_key mode.');
    }
    if (!config.turnkey.accessKeyPolicyId || isFillPlaceholder(config.turnkey.accessKeyPolicyId)) {
      failures.push('TURNKEY_ACCESS_KEY_POLICY_ID is required for the reviewed raw-signing policy.');
    }
  }

  if (config.turnkey.sponsorWith) {
    failures.push('TURNKEY_SPONSOR_WITH must remain empty until sponsored Tempo transfers are implemented.');
  }
}

function checkAgentPolicies(config, mode, failures) {
  for (const agent of config.agentWallets) {
    const label = agent.agent_id;

    if (DEV_PLACEHOLDER_ADDRESSES.has(agent.wallet_address.toLowerCase())) {
      failures.push(`${label}.wallet_address is still a development placeholder.`);
    }

    if (DEV_PLACEHOLDER_ADDRESSES.has(agent.tempo_access_key_address.toLowerCase())) {
      failures.push(`${label}.tempo_access_key_address is still a development placeholder.`);
    }

    if (agent.wallet_address.toLowerCase() === agent.tempo_access_key_address.toLowerCase()) {
      failures.push(`${label}.wallet_address and tempo_access_key_address must be different keys.`);
    }

    if (agent.allowed_services.length === 0) {
      failures.push(`${label}.allowed_services must be non-empty.`);
    }

    if (agent.allowed_endpoints.length === 0) {
      failures.push(`${label}.allowed_endpoints must be non-empty and exact.`);
    }

    if (agent.allowed_recipients.length === 0) {
      failures.push(`${label}.allowed_recipients must be non-empty.`);
    }

    if (agent.allowed_commands.length === 0) {
      failures.push(`${label}.allowed_commands must be non-empty.`);
    }

    if (mode === 'test') {
      if (BigInt(agent.per_call_limit_base_units) > TEST_MAX_PER_CALL_BASE_UNITS) {
        failures.push(`${label}.per_call_limit_base_units must be <= 50000 for live test mode.`);
      }

      if (BigInt(agent.daily_limit_base_units) > TEST_MAX_DAILY_BASE_UNITS) {
        failures.push(`${label}.daily_limit_base_units must be <= 500000 for live test mode.`);
      }
    }
  }
}

function checkLedgerConfig(config, env, mode, failures, warnings) {
  if (!['file', 'upstash_redis'].includes(config.ledgerBackend)) {
    failures.push('SIGNER_LEDGER_BACKEND must be file or upstash_redis.');
    return;
  }

  if (mode === 'production') {
    if (env.SIGNER_LEDGER_DURABLE !== 'true') {
      failures.push('Production mode requires SIGNER_LEDGER_DURABLE=true and a durable ledger backend.');
    }
    if (config.ledgerBackend !== 'upstash_redis') {
      failures.push('Production mode requires SIGNER_LEDGER_BACKEND=upstash_redis.');
    }
    if (!config.upstashRedis.restUrl) {
      failures.push('Production mode requires UPSTASH_REDIS_REST_URL for the signer ledger.');
    }
    if (isFillPlaceholder(config.upstashRedis.restUrl)) {
      failures.push('UPSTASH_REDIS_REST_URL still contains a bootstrap __FILL_*__ placeholder.');
    } else if (config.upstashRedis.restUrl && !isRealPublicHttpsUrl(config.upstashRedis.restUrl)) {
      failures.push('UPSTASH_REDIS_REST_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.');
    }
    if (!config.upstashRedis.restTokenConfigured || isFillPlaceholder(config.upstashRedis.restToken)) {
      failures.push('Production mode requires UPSTASH_REDIS_REST_TOKEN for the signer ledger.');
    }
    return;
  }

  if (env.SIGNER_LEDGER_DURABLE !== 'true') {
    warnings.push('Test mode is allowed with a file/ephemeral ledger only because the outbound key limit must remain tiny.');
  }

  if (config.ledgerBackend === 'upstash_redis' && (!config.upstashRedis.restUrl || !config.upstashRedis.restTokenConfigured)) {
    failures.push('SIGNER_LEDGER_BACKEND=upstash_redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  }
}

function checkAdminRateLimit(config, mode, failures) {
  if (mode !== 'production') {
    return;
  }

  if (config.adminRateLimit.enabled !== true) {
    failures.push('SIGNER_ADMIN_RATE_LIMIT_ENABLED must be true for production signer admin routes.');
  }

  if (!Number.isFinite(config.adminRateLimit.max) || config.adminRateLimit.max < 1 || config.adminRateLimit.max > 120) {
    failures.push('SIGNER_ADMIN_RATE_LIMIT_MAX must be between 1 and 120 for production signer admin routes.');
  }

  if (!Number.isFinite(config.adminRateLimit.windowMs) || config.adminRateLimit.windowMs < 1_000 || config.adminRateLimit.windowMs > 3_600_000) {
    failures.push('SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000.');
  }
}

function isFillPlaceholder(value) {
  return /^__FILL_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function isRealPublicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isDisallowedLiveHostname(url.hostname);
  } catch {
    return false;
  }
}

function isDisallowedLiveHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) {
    return true;
  }
  if (['localhost', '127.0.0.1', '::1'].includes(normalized)) {
    return true;
  }
  if (
    normalized === 'example'
    || normalized.endsWith('.example')
    || normalized === 'example.com'
    || normalized.endsWith('.example.com')
    || normalized === 'invalid'
    || normalized.endsWith('.invalid')
    || normalized === 'test'
    || normalized.endsWith('.test')
  ) {
    return true;
  }
  return normalized
    .split('.')
    .some((label) => ['example', 'test', 'invalid', 'your'].includes(label)
      || label.startsWith('your-')
      || label.includes('placeholder'));
}
