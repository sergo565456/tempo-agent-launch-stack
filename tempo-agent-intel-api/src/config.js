import { DEPTH_PRICES_USD } from './payments/pricing.js';
import { parseAllowedServices } from './outbound/spendPolicy.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_BROWSERBASE_SERVICE = 'mpp.browserbase.com';
const DEFAULT_BROWSERBASE_FETCH_ENDPOINT = 'https://mpp.browserbase.com/fetch';
const DEFAULT_BROWSERBASE_FETCH_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const DEFAULT_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS = '10000';
const DEFAULT_BROWSERBASE_FETCH_URL = 'https://mpp.dev/services';
const DEFAULT_BROWSERBASE_FETCH_COMMAND = 'fetch_browserbase_page';

export function getConfig(env = process.env) {
  const paymentMode = env.PAYMENT_MODE || 'mock';
  const outboundPaymentProvider = env.OUTBOUND_PAYMENT_PROVIDER || 'remote_signer';

  if (paymentMode === 'free' && env.ALLOW_FREE_PAYMENT_MODE !== 'true') {
    throw new Error('PAYMENT_MODE=free requires ALLOW_FREE_PAYMENT_MODE=true');
  }

  if (!['free', 'mock', 'tempo', 'x402', 'multi'].includes(paymentMode)) {
    throw new Error(`Unsupported PAYMENT_MODE: ${paymentMode}`);
  }

  if (!['remote_signer', 'local_access_key'].includes(outboundPaymentProvider)) {
    throw new Error(`Unsupported OUTBOUND_PAYMENT_PROVIDER: ${outboundPaymentProvider}`);
  }

  const storageBackend = env.AGENT_STORAGE_BACKEND || 'file';
  if (!['file', 'upstash_redis'].includes(storageBackend)) {
    throw new Error(`Unsupported AGENT_STORAGE_BACKEND: ${storageBackend}`);
  }

  const enabledPaymentRails = parseEnabledPaymentRails(env.ENABLED_PAYMENT_RAILS, paymentMode);

  return {
    serviceName: 'agent-launch-intel-api',
    host: env.HOST || '127.0.0.1',
    port: Number.parseInt(env.PORT || '3000', 10),
    publicBaseUrl: resolvePublicBaseUrl(env),
    exposeRuntimeReadinessDetails: env.EXPOSE_RUNTIME_READINESS_DETAILS === 'true',
    requireIdempotencyKeyForPaid: env.REQUIRE_IDEMPOTENCY_KEY_FOR_PAID
      ? env.REQUIRE_IDEMPOTENCY_KEY_FOR_PAID === 'true'
      : ['tempo', 'x402', 'multi'].includes(paymentMode),
    requireReportAccessProof: env.REQUIRE_REPORT_ACCESS_PROOF
      ? env.REQUIRE_REPORT_ACCESS_PROOF === 'true'
      : ['tempo', 'x402', 'multi'].includes(paymentMode),
    storageBackend,
    reportStorePath: env.REPORT_STORE_PATH || defaultStoragePath(env, 'reports.json'),
    paymentLedgerPath: env.PAYMENT_LEDGER_PATH || defaultStoragePath(env, 'payment-events.json'),
    upstashRedis: {
      restUrl: env.UPSTASH_REDIS_REST_URL || '',
      restToken: env.UPSTASH_REDIS_REST_TOKEN || '',
      restTokenConfigured: Boolean(env.UPSTASH_REDIS_REST_TOKEN),
      keyPrefix: env.AGENT_STORAGE_REDIS_PREFIX || 'agent-launch-intel-api',
      keyPrefixConfigured: Boolean(env.AGENT_STORAGE_REDIS_PREFIX),
      sharedBackendAllowed: env.ALLOW_SHARED_UPSTASH_BACKEND === 'true',
    },
    paymentMode,
    enabledPaymentRails,
    receiveTempoAddress: env.RECEIVE_TEMPO_ADDRESS || '',
    receiveBaseAddress: env.RECEIVE_BASE_ADDRESS || '',
    tempoRpcUrl: env.TEMPO_RPC_URL || 'https://rpc.tempo.xyz',
    tempoChainId: Number.parseInt(env.TEMPO_CHAIN_ID || '4217', 10),
    tempoCurrencyAddress: env.TEMPO_USDC_ADDRESS || '0x20c000000000000000000000b9537d11c60e8b50',
    baseCurrencyAddress: env.BASE_USDC_ADDRESS || '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    tempoTokenDecimals: Number.parseInt(env.TEMPO_TOKEN_DECIMALS || '6', 10),
    baseTokenDecimals: Number.parseInt(env.BASE_TOKEN_DECIMALS || '6', 10),
    tempoMppDepsRoot: env.TEMPO_MPP_DEPS_ROOT || '.',
    tempoMppRuntimeEnvPath: env.TEMPO_MPP_RUNTIME_ENV_PATH || '.secrets/mpp-runtime.env',
    tempoMppSecretKey: env.TEMPO_MPP_SECRET_KEY || env.MPP_SECRET_KEY || '',
    tempoMppLiveEnabled: env.TEMPO_MPP_LIVE_ENABLED === 'true',
    tempoMppRealm: env.TEMPO_MPP_REALM || '',
    tempoMppWaitForConfirmation: env.TEMPO_MPP_WAIT_FOR_CONFIRMATION !== 'false',
    tempoMppVerifyOnchainOnRequest: env.TEMPO_MPP_VERIFY_ONCHAIN_ON_REQUEST !== 'false',
    tempoMppSupportedModes: parseList(env.TEMPO_MPP_SUPPORTED_MODES || 'push'),
    agentAccessKeyEnvPath: env.AGENT_ACCESS_KEY_ENV_PATH || '.secrets/agent-access-key.20260606T012346_f2fe5409.env',
    agentAccessKey: {
      AGENT_ROOT_ACCOUNT_ADDRESS: env.AGENT_ROOT_ACCOUNT_ADDRESS || '',
      AGENT_ACCESS_KEY_ADDRESS: env.AGENT_ACCESS_KEY_ADDRESS || '',
      AGENT_ACCESS_KEY_PRIVATE_KEY: env.AGENT_ACCESS_KEY_PRIVATE_KEY || '',
      AGENT_ACCESS_KEY_EXPIRES_AT: env.AGENT_ACCESS_KEY_EXPIRES_AT || '',
      AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON: env.AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON || '',
    },
    maxReportPriceUsd: env.MAX_REPORT_PRICE_USD || DEPTH_PRICES_USD.deep,
    pricesUsd: {
      quick: env.PRICE_QUICK_USD || DEPTH_PRICES_USD.quick,
      standard: env.PRICE_STANDARD_USD || DEPTH_PRICES_USD.standard,
      deep: env.PRICE_DEEP_USD || DEPTH_PRICES_USD.deep,
    },
    outboundSpendPolicy: {
      paymentProvider: outboundPaymentProvider,
      livePaymentsEnabled: env.OUTBOUND_LIVE_PAYMENTS === 'true',
      maxPerCallUsd: env.MAX_OUTBOUND_PER_CALL_USD || '0.05',
      maxDailyUsd: env.MAX_OUTBOUND_DAILY_USD || '0.50',
      allowedServices: parseAllowedServices(env.OUTBOUND_ALLOWED_SERVICES),
      denyUnknownServices: env.OUTBOUND_DENY_UNKNOWN_SERVICES !== 'false',
      targetService: env.OUTBOUND_TARGET_SERVICE || DEFAULT_BROWSERBASE_SERVICE,
      targetEndpoint: env.OUTBOUND_TARGET_ENDPOINT || DEFAULT_BROWSERBASE_FETCH_ENDPOINT,
      targetAmountBaseUnits: env.OUTBOUND_TARGET_AMOUNT_BASE_UNITS
        || env.OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS
        || DEFAULT_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS,
      targetRecipient: env.OUTBOUND_TARGET_RECIPIENT
        || env.OUTBOUND_BROWSERBASE_FETCH_RECIPIENT
        || DEFAULT_BROWSERBASE_FETCH_RECIPIENT,
      allowDynamicMppRecipient: env.OUTBOUND_ALLOW_DYNAMIC_MPP_RECIPIENT
        ? env.OUTBOUND_ALLOW_DYNAMIC_MPP_RECIPIENT === 'true'
        : false,
      browserbaseFetchUrl: env.OUTBOUND_BROWSERBASE_FETCH_URL || DEFAULT_BROWSERBASE_FETCH_URL,
    },
    outboundSigner: {
      baseUrl: env.OUTBOUND_SIGNER_BASE_URL || '',
      adminToken: env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
      agentId: env.OUTBOUND_SIGNER_AGENT_ID || 'agent-launch-intel',
      command: env.OUTBOUND_SIGNER_COMMAND || DEFAULT_BROWSERBASE_FETCH_COMMAND,
    },
    outboundAdminToken: env.OUTBOUND_ADMIN_TOKEN || '',
    outboundCron: {
      enabled: env.ENABLE_OUTBOUND_CRON === 'true',
      secret: env.CRON_SECRET || '',
      idempotencyPrefix: env.OUTBOUND_CRON_IDEMPOTENCY_PREFIX || 'cron-browserbase-fetch',
      requireVerifiedManualPayment: env.OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT !== 'false',
      armingIdempotencyKey: env.OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY || '',
    },
    reportRateLimit: {
      enabled: env.REPORT_RATE_LIMIT_ENABLED
        ? env.REPORT_RATE_LIMIT_ENABLED === 'true'
        : ['tempo', 'x402', 'multi'].includes(paymentMode),
      max: parsePositiveInteger(env.REPORT_RATE_LIMIT_MAX, 30),
      windowMs: parsePositiveInteger(env.REPORT_RATE_LIMIT_WINDOW_MS, 60_000),
      trustProxyHeaders: env.REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS
        ? env.REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS === 'true'
        : Boolean(env.VERCEL),
    },
  };
}

function defaultStoragePath(env, fileName) {
  const runtimeDataDir = env.RUNTIME_DATA_DIR || (env.VERCEL ? join(tmpdir(), 'agent-launch-intel-api') : '.data');
  return join(runtimeDataDir, fileName);
}

function resolvePublicBaseUrl(env) {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL;
  }

  if (env.VERCEL_URL) {
    return `https://${env.VERCEL_URL}`;
  }

  return `http://${env.HOST || '127.0.0.1'}:${env.PORT || '3000'}`;
}

function parseEnabledPaymentRails(raw, paymentMode) {
  if (raw) {
    return raw
      .split(',')
      .map((rail) => rail.trim())
      .filter(Boolean);
  }

  if (paymentMode === 'multi') {
    return ['tempo', 'x402'];
  }

  if (paymentMode === 'free') {
    return [];
  }

  return [paymentMode];
}

function parseList(raw) {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
