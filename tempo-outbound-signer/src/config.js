import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_TEMPO_USDC = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_TEMPO_RPC_URL = 'https://rpc.tempo.xyz';
const DEFAULT_BROWSERBASE_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const DEFAULT_BROWSERBASE_FETCH_URL = 'https://mpp.dev/services';
const DEV_AGENT_WALLET = '0x1111111111111111111111111111111111111111';
const DEV_AGENT_ACCESS_KEY = '0x2222222222222222222222222222222222222222';

export function getConfig(env = process.env) {
  const tempoChainId = Number.parseInt(env.TEMPO_CHAIN_ID || '4217', 10);
  const tempoUsdcAddress = env.TEMPO_USDC_ADDRESS || DEFAULT_TEMPO_USDC;
  const agentWallets = parseAgentWallets(stripEnvWrapperQuotes(env.AGENT_WALLETS_JSON || defaultAgentWalletsJson()));

  return {
    serviceName: 'tempo-outbound-signer',
    host: env.HOST || '127.0.0.1',
    port: Number.parseInt(env.PORT || '3100', 10),
    publicBaseUrl: env.PUBLIC_BASE_URL || `http://${env.HOST || '127.0.0.1'}:${env.PORT || '3100'}`,
    provider: env.SIGNER_PROVIDER || 'mock',
    exposeProviderErrorDetails: env.SIGNER_EXPOSE_PROVIDER_ERROR_DETAILS === 'true',
    ledgerBackend: env.SIGNER_LEDGER_BACKEND || 'file',
    signerAdminToken: env.SIGNER_ADMIN_TOKEN || '',
    ledgerPath: env.SIGNER_LEDGER_PATH || join(tmpdir(), 'tempo-outbound-signer-ledger.json'),
    upstashRedis: {
      restUrl: env.UPSTASH_REDIS_REST_URL || '',
      restTokenConfigured: Boolean(env.UPSTASH_REDIS_REST_TOKEN),
      restToken: env.UPSTASH_REDIS_REST_TOKEN || '',
      keyPrefix: env.SIGNER_LEDGER_REDIS_PREFIX || 'tempo-outbound-signer',
      keyPrefixConfigured: Boolean(env.SIGNER_LEDGER_REDIS_PREFIX),
      sharedBackendAllowed: env.ALLOW_SHARED_UPSTASH_BACKEND === 'true',
    },
    tempoChainId,
    tempoRpcUrl: env.TEMPO_RPC_URL || DEFAULT_TEMPO_RPC_URL,
    tempoUsdcAddress,
    tempoTokenDecimals: Number.parseInt(env.TEMPO_TOKEN_DECIMALS || '6', 10),
    agentWallets,
    turnkey: {
      apiBaseUrl: env.TURNKEY_API_BASE_URL || 'https://api.turnkey.com',
      organizationId: env.TURNKEY_ORGANIZATION_ID || '',
      apiPublicKey: env.TURNKEY_API_PUBLIC_KEY || '',
      apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY || '',
      apiPrivateKeyConfigured: Boolean(env.TURNKEY_API_PRIVATE_KEY),
      policyId: env.TURNKEY_POLICY_ID || '',
      signerApiUserId: env.TURNKEY_SIGNER_API_USER_ID || '',
      signWith: env.TURNKEY_SIGN_WITH || '',
      signWithMode: env.TURNKEY_SIGN_WITH_MODE || 'wallet',
      accessKeySignWith: env.TURNKEY_ACCESS_KEY_SIGN_WITH || '',
      accessKeyPublicKey: env.TURNKEY_ACCESS_KEY_PUBLIC_KEY || '',
      accessKeyPolicyId: env.TURNKEY_ACCESS_KEY_POLICY_ID || '',
      accessKeyModeAudited: env.TURNKEY_ACCESS_KEY_MODE_AUDITED === 'true',
      sponsorWith: env.TURNKEY_SPONSOR_WITH || '',
    },
    adminRateLimit: {
      enabled: env.SIGNER_ADMIN_RATE_LIMIT_ENABLED
        ? env.SIGNER_ADMIN_RATE_LIMIT_ENABLED === 'true'
        : env.SIGNER_PROVIDER === 'turnkey' || env.LIVE_READINESS_MODE === 'production' || Boolean(env.VERCEL),
      max: parsePositiveInteger(env.SIGNER_ADMIN_RATE_LIMIT_MAX, 60),
      windowMs: parsePositiveInteger(env.SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS, 60_000),
      trustProxyHeaders: env.SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS
        ? env.SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS === 'true'
        : Boolean(env.VERCEL),
    },
  };
}

function defaultAgentWalletsJson() {
  return JSON.stringify([
    {
      agent_id: 'agent-launch-intel',
      wallet_address: DEV_AGENT_WALLET,
      tempo_access_key_address: DEV_AGENT_ACCESS_KEY,
      turnkey_sign_with: '',
      enabled: true,
      per_call_limit_base_units: '10000',
      daily_limit_base_units: '50000',
      allowed_services: ['mpp.browserbase.com'],
      allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
      allowed_recipients: [DEFAULT_BROWSERBASE_RECIPIENT],
      allowed_commands: ['fetch_browserbase_page'],
      allowed_browserbase_fetch_urls: [DEFAULT_BROWSERBASE_FETCH_URL],
      allow_dynamic_mpp_recipient: true,
    },
  ]);
}

function stripEnvWrapperQuotes(value) {
  const raw = String(value || '').trim();
  if (
    (raw.startsWith("'") && raw.endsWith("'"))
    || (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseAgentWallets(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`AGENT_WALLETS_JSON must be valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('AGENT_WALLETS_JSON must be a non-empty array');
  }

  const seen = new Set();
  return parsed.map((wallet) => {
    const normalized = normalizeWallet(wallet);
    if (seen.has(normalized.agent_id)) {
      throw new Error(`Duplicate agent_id: ${normalized.agent_id}`);
    }
    seen.add(normalized.agent_id);
    return normalized;
  });
}

function normalizeWallet(wallet) {
  const agentId = normalizeString(wallet.agent_id);
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(agentId)) {
    throw new Error(`Invalid agent_id: ${wallet.agent_id}`);
  }

  assertAddress(wallet.wallet_address, `${agentId}.wallet_address`);
  assertAddress(wallet.tempo_access_key_address, `${agentId}.tempo_access_key_address`);
  if (wallet.turnkey_sign_with) {
    assertAddress(wallet.turnkey_sign_with, `${agentId}.turnkey_sign_with`);
  }
  assertPositiveIntegerString(wallet.per_call_limit_base_units, `${agentId}.per_call_limit_base_units`);
  assertPositiveIntegerString(wallet.daily_limit_base_units, `${agentId}.daily_limit_base_units`);

  return {
    agent_id: agentId,
    wallet_address: wallet.wallet_address,
    tempo_access_key_address: wallet.tempo_access_key_address,
    turnkey_sign_with: normalizeString(wallet.turnkey_sign_with),
    enabled: wallet.enabled !== false,
    per_call_limit_base_units: String(wallet.per_call_limit_base_units),
    daily_limit_base_units: String(wallet.daily_limit_base_units),
    allowed_services: normalizeList(wallet.allowed_services),
    allowed_endpoints: normalizeList(wallet.allowed_endpoints).map(normalizeEndpointUrl),
    allowed_recipients: normalizeList(wallet.allowed_recipients).map((address) => {
      assertAddress(address, `${agentId}.allowed_recipients`);
      return address;
    }),
    allowed_commands: normalizeList(wallet.allowed_commands),
    allowed_browserbase_fetch_urls: normalizeList(wallet.allowed_browserbase_fetch_urls).map(normalizeEndpointUrl),
    allow_dynamic_mpp_recipient: wallet.allow_dynamic_mpp_recipient === true,
  };
}

function normalizeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeString).filter(Boolean);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEndpointUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      throw new Error('endpoint must use HTTPS');
    }
    return url.href;
  } catch (error) {
    throw new Error(`Invalid allowed endpoint ${value}: ${error.message}`);
  }
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    throw new Error(`${label} must be an EVM address`);
  }
}

function assertPositiveIntegerString(value, label) {
  if (!/^\d+$/.test(String(value || '')) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive integer string`);
  }
}

function parsePositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
