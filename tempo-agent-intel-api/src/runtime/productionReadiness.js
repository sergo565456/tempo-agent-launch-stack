const DEFAULT_MAX_FIRST_LIVE_PER_CALL_USD = '0.01';
const DEFAULT_MAX_FIRST_LIVE_DAILY_USD = '0.05';

const DISALLOWED_SECRET_ENV_KEYS = [
  'ROOT_PRIVATE_KEY',
  'OWNER_PRIVATE_KEY',
  'TREASURY_PRIVATE_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
  'AGENT_ACCESS_KEY_PRIVATE_KEY',
];

const DEMO_TOKENS = new Set([
  'test-admin-token',
  'local-dev-token',
  'remote-signer-readiness-token',
  'test-signer-token',
  'agent-outbound-readiness-token',
]);

export function checkAgentProductionReadiness(config, env = process.env) {
  const failures = [];
  const warnings = [];

  checkPublicBaseUrl(config, failures);
  checkInboundTempo(config, env, failures);
  checkStorage(config, failures);
  checkIdempotency(config, failures);
  checkReportAccessProof(config, failures);
  checkReportRateLimit(config, failures);
  checkSharedUpstashAcceptance(config, warnings);
  checkOutboundSigner(config, failures, warnings);
  checkOutboundCron(config, failures);
  checkSecretExclusions(env, failures);

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary: {
      payment_mode: config.paymentMode,
      enabled_payment_rails: config.enabledPaymentRails,
      tempo_live_enabled: config.tempoMppLiveEnabled,
      public_base_url_https: isRealPublicHttpsUrl(config.publicBaseUrl),
      storage_backend: config.storageBackend,
      storage_durable_configured: config.storageBackend === 'upstash_redis'
        && Boolean(config.upstashRedis.restUrl)
        && !isFillPlaceholder(config.upstashRedis.restUrl)
        && config.upstashRedis.restTokenConfigured
        && !isFillPlaceholder(config.upstashRedis.restToken),
      idempotency_required: config.requireIdempotencyKeyForPaid,
      report_access_proof_required: config.requireReportAccessProof,
      outbound_live_payments: config.outboundSpendPolicy.livePaymentsEnabled,
      outbound_payment_provider: config.outboundSpendPolicy.paymentProvider,
      outbound_signer_https: isRealPublicHttpsUrl(config.outboundSigner.baseUrl),
      outbound_allowed_services: config.outboundSpendPolicy.allowedServices,
      max_outbound_per_call_usd: config.outboundSpendPolicy.maxPerCallUsd,
      max_outbound_daily_usd: config.outboundSpendPolicy.maxDailyUsd,
      outbound_cron_enabled: config.outboundCron.enabled,
      cron_secret_configured: Boolean(config.outboundCron.secret),
      outbound_cron_requires_verified_manual_payment: config.outboundCron.requireVerifiedManualPayment,
      outbound_cron_arming_idempotency_key_configured: Boolean(config.outboundCron.armingIdempotencyKey),
      receive_tempo_configured: isAddress(config.receiveTempoAddress),
      tempo_mpp_secret_configured: Boolean(config.tempoMppSecretKey),
      detailed_readiness_exposed: config.exposeRuntimeReadinessDetails,
      report_rate_limit_enabled: config.reportRateLimit.enabled,
      report_rate_limit_max: config.reportRateLimit.max,
      report_rate_limit_window_ms: config.reportRateLimit.windowMs,
    },
  };
}

function checkPublicBaseUrl(config, failures) {
  if (isFillPlaceholder(config.publicBaseUrl)) {
    failures.push('PUBLIC_BASE_URL still contains a bootstrap __FILL_*__ placeholder.');
    return;
  }

  if (!isRealPublicHttpsUrl(config.publicBaseUrl)) {
    failures.push('PUBLIC_BASE_URL must be a real public HTTPS URL for production, not a template, example, or reserved hostname.');
  }
}

function checkInboundTempo(config, env, failures) {
  if (!config.enabledPaymentRails.includes('tempo')) {
    failures.push('Enabled payment rails must include tempo for the production Tempo MPP service.');
  }

  if (config.paymentMode !== 'tempo' && config.paymentMode !== 'multi') {
    failures.push('PAYMENT_MODE must be tempo or multi for production paid service mode.');
  }

  if (config.tempoMppLiveEnabled !== true) {
    failures.push('TEMPO_MPP_LIVE_ENABLED must be true for production inbound Tempo MPP.');
  }

  if (!isAddress(config.receiveTempoAddress) || isFillPlaceholder(config.receiveTempoAddress)) {
    failures.push('RECEIVE_TEMPO_ADDRESS must be a valid public receiving wallet address.');
  }

  if (!config.tempoMppSecretKey || config.tempoMppSecretKey.length < 32) {
    failures.push('TEMPO_MPP_SECRET_KEY must be configured with a strong secret.');
  }

  if (env.PAYMENT_MODE === 'free') {
    failures.push('PAYMENT_MODE=free must not be used in production.');
  }

  if (config.exposeRuntimeReadinessDetails) {
    failures.push('EXPOSE_RUNTIME_READINESS_DETAILS must remain false in production.');
  }
}

function checkStorage(config, failures) {
  if (config.storageBackend !== 'upstash_redis') {
    failures.push('AGENT_STORAGE_BACKEND must be upstash_redis for production autonomous storage.');
  }

  if (!config.upstashRedis.restUrl || isFillPlaceholder(config.upstashRedis.restUrl)) {
    failures.push('UPSTASH_REDIS_REST_URL is required for production agent storage.');
  }

  if (!config.upstashRedis.restTokenConfigured || isFillPlaceholder(config.upstashRedis.restToken)) {
    failures.push('UPSTASH_REDIS_REST_TOKEN is required for production agent storage.');
  }

  if (config.upstashRedis.restUrl && !isRealPublicHttpsUrl(config.upstashRedis.restUrl)) {
    failures.push('UPSTASH_REDIS_REST_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.');
  }
}

function checkIdempotency(config, failures) {
  if (!config.requireIdempotencyKeyForPaid) {
    failures.push('REQUIRE_IDEMPOTENCY_KEY_FOR_PAID must be true for production paid routes.');
  }
}

function checkReportAccessProof(config, failures) {
  if (!config.requireReportAccessProof) {
    failures.push('REQUIRE_REPORT_ACCESS_PROOF must be true for production paid report retrieval.');
  }
}

function checkReportRateLimit(config, failures) {
  if (config.reportRateLimit.enabled !== true) {
    failures.push('REPORT_RATE_LIMIT_ENABLED must be true for production paid report routes.');
  }

  if (!Number.isFinite(config.reportRateLimit.max) || config.reportRateLimit.max < 1 || config.reportRateLimit.max > 120) {
    failures.push('REPORT_RATE_LIMIT_MAX must be between 1 and 120 for production paid report routes.');
  }

  if (!Number.isFinite(config.reportRateLimit.windowMs) || config.reportRateLimit.windowMs < 1_000 || config.reportRateLimit.windowMs > 3_600_000) {
    failures.push('REPORT_RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000.');
  }
}

function checkSharedUpstashAcceptance(config, warnings) {
  if (config.upstashRedis.sharedBackendAllowed) {
    warnings.push('Agent runtime explicitly allows a shared Upstash backend. This is acceptable only with a different signer Redis prefix and awareness that one leaked token can access both namespaces.');
  }
}

function checkOutboundSigner(config, failures, warnings) {
  if (config.outboundSpendPolicy.paymentProvider !== 'remote_signer') {
    failures.push('OUTBOUND_PAYMENT_PROVIDER must be remote_signer for production autonomous outbound spend.');
  }

  if (config.outboundSpendPolicy.livePaymentsEnabled !== true) {
    failures.push('OUTBOUND_LIVE_PAYMENTS must be true for production autonomous outbound spend.');
  }

  if (isFillPlaceholder(config.outboundSigner.baseUrl)) {
    failures.push('OUTBOUND_SIGNER_BASE_URL still contains a bootstrap __FILL_*__ placeholder.');
  } else if (!isRealPublicHttpsUrl(config.outboundSigner.baseUrl)) {
    failures.push('OUTBOUND_SIGNER_BASE_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.');
  }

  checkStrongToken(config.outboundAdminToken, 'OUTBOUND_ADMIN_TOKEN', failures);
  checkStrongToken(config.outboundSigner.adminToken, 'OUTBOUND_SIGNER_ADMIN_TOKEN', failures);

  if (!config.outboundSigner.agentId) {
    failures.push('OUTBOUND_SIGNER_AGENT_ID is required.');
  }

  if (!config.outboundSigner.command) {
    failures.push('OUTBOUND_SIGNER_COMMAND is required.');
  }

  if (!config.outboundSpendPolicy.allowedServices.includes(config.outboundSpendPolicy.targetService)) {
    failures.push('OUTBOUND_ALLOWED_SERVICES must include OUTBOUND_TARGET_SERVICE.');
  }

  if (config.outboundSpendPolicy.denyUnknownServices !== true) {
    failures.push('OUTBOUND_DENY_UNKNOWN_SERVICES must not be false in production.');
  }

  if (!isUsdAtMost(config.outboundSpendPolicy.maxPerCallUsd, DEFAULT_MAX_FIRST_LIVE_PER_CALL_USD)) {
    failures.push(`MAX_OUTBOUND_PER_CALL_USD must be <= ${DEFAULT_MAX_FIRST_LIVE_PER_CALL_USD} for the first production launch profile.`);
  }

  if (!isUsdAtMost(config.outboundSpendPolicy.maxDailyUsd, DEFAULT_MAX_FIRST_LIVE_DAILY_USD)) {
    failures.push(`MAX_OUTBOUND_DAILY_USD must be <= ${DEFAULT_MAX_FIRST_LIVE_DAILY_USD} for the first production launch profile.`);
  }
}

function checkOutboundCron(config, failures) {
  if (!config.outboundCron.enabled) {
    return;
  }

  checkStrongToken(config.outboundCron.secret, 'CRON_SECRET', failures);

  if (!/^[a-zA-Z0-9._:-]{1,96}$/.test(config.outboundCron.idempotencyPrefix)) {
    failures.push('OUTBOUND_CRON_IDEMPOTENCY_PREFIX must contain only letters, numbers, dots, underscores, colons, or hyphens.');
  }

  if (config.outboundCron.requireVerifiedManualPayment !== true) {
    failures.push('OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT must remain true in production.');
  }

  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(config.outboundCron.armingIdempotencyKey)) {
    failures.push('OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY must be set to the verified first manual outbound payment idempotency key when cron is enabled.');
  }
}

function checkSecretExclusions(env, failures) {
  for (const key of DISALLOWED_SECRET_ENV_KEYS) {
    if (env[key]) {
      failures.push(`${key} must not be present in the public agent production runtime.`);
    }
  }
}

function checkStrongToken(value, label, failures) {
  if (!value) {
    failures.push(`${label} is required.`);
    return;
  }

  if (value.length < 32) {
    failures.push(`${label} must be at least 32 characters.`);
  }

  if (DEMO_TOKENS.has(value)) {
    failures.push(`${label} must not use a documented demo token.`);
  }
}

function isRealPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return url.protocol === 'https:' && !isDisallowedLiveHostname(url.hostname);
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

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

function isFillPlaceholder(value) {
  return /^__FILL_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function isUsdAtMost(value, max) {
  try {
    return parseDecimalToMillionths(value) <= parseDecimalToMillionths(max);
  } catch {
    return false;
  }
}

function parseDecimalToMillionths(value) {
  const raw = String(value || '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
