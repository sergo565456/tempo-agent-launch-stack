import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { readOptionalEnvFile } from '../src/envFiles.js';
import { checkLiveReadiness } from '../src/liveReadiness.js';

const FIRST_LIVE_MAX_PER_CALL_BASE_UNITS = 10_000n;
const FIRST_LIVE_MAX_DAILY_BASE_UNITS = 50_000n;
const SUPPORTED_FIRST_LIVE_COMMANDS = new Set([
  'fetch_browserbase_page',
  'codex_graphql_query',
]);
const DEV_PLACEHOLDER_ADDRESSES = new Set([
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]);

export async function runTurnkeyLiveHandoffCheck(options = {}) {
  const envFile = await readOptionalEnvFile(options.envFile || '', {
    required: Boolean(options.envFile),
  });
  const includeProcessEnv = options.includeProcessEnv !== false;
  const env = {
    ...(includeProcessEnv ? process.env : {}),
    ...(options.explicitEnv || {}),
    ...envFile.values,
  };
  const config = getConfig(env);
  const readiness = checkLiveReadiness(config, env);
  const secretValues = [
    env.SIGNER_ADMIN_TOKEN,
    env.TURNKEY_API_PRIVATE_KEY,
    env.UPSTASH_REDIS_REST_TOKEN,
  ].filter(Boolean);

  const checks = buildChecks(config, env);
  const blockers = unique([
    ...readiness.failures,
    ...checks.filter((check) => !check.ok).map((check) => check.message),
  ]);
  const warnings = unique([
    ...readiness.warnings,
    ...checks.filter((check) => check.warning && check.ok).map((check) => check.warning),
  ]);

  const summary = {
    ok: blockers.length === 0,
    read_only: true,
    env_file: {
      path: envFile.path || null,
      exists: envFile.exists,
      loaded_keys: Object.keys(envFile.values).sort(),
    },
    readiness: {
      ok: readiness.ok,
      mode: readiness.mode,
      failures: readiness.failures,
      warnings: readiness.warnings,
      summary: readiness.summary,
    },
    checks,
    blockers,
    warnings,
    next_manual_boundary: blockers.length === 0
      ? 'Manual approval is still required before uploading signer env, deploying, or sending the first live outbound MPP payment.'
      : 'Complete the missing Turnkey, wallet, policy, ledger, or signer-env handoff items before any deploy or live payment.',
    note: 'Read-only Turnkey live handoff check. It loads env names and configuration booleans only; it does not call Turnkey, sign, pay, fetch MPP services, upload env, or deploy.',
  };

  assertNoSecretLeak('turnkey live handoff summary', JSON.stringify(summary), secretValues);
  return summary;
}

function buildChecks(config, env) {
  const checks = [
    check('signer_provider_turnkey', config.provider === 'turnkey', 'SIGNER_PROVIDER must be turnkey.'),
    check('signer_admin_token_strong', isStrongAdminToken(config.signerAdminToken), 'SIGNER_ADMIN_TOKEN must be a strong non-demo token with at least 32 characters.'),
    check('public_base_url_https', isRealPublicHttpsUrl(config.publicBaseUrl), 'PUBLIC_BASE_URL must be a real public HTTPS URL, not a template, example, or reserved hostname.'),
    check('turnkey_org_configured', hasRealValue(config.turnkey.organizationId), 'TURNKEY_ORGANIZATION_ID must be configured.'),
    check('turnkey_api_public_key_configured', hasRealValue(config.turnkey.apiPublicKey), 'TURNKEY_API_PUBLIC_KEY must be configured.'),
    check('turnkey_api_private_key_configured', config.turnkey.apiPrivateKeyConfigured && hasRealValue(config.turnkey.apiPrivateKey), 'TURNKEY_API_PRIVATE_KEY must be configured in secrets.'),
    check('turnkey_policy_id_configured', hasRealValue(config.turnkey.policyId), 'TURNKEY_POLICY_ID must be configured.'),
    check('turnkey_signer_api_user_configured', hasRealValue(config.turnkey.signerApiUserId), 'TURNKEY_SIGNER_API_USER_ID must be configured.'),
    check('turnkey_sign_with_mode_supported', ['wallet', 'access_key'].includes(config.turnkey.signWithMode), 'TURNKEY_SIGN_WITH_MODE must be wallet or access_key.'),
    check('turnkey_sponsor_disabled', !config.turnkey.sponsorWith, 'TURNKEY_SPONSOR_WITH must remain empty.'),
    check('tempo_chain_mainnet_profile', config.tempoChainId === 4217, 'TEMPO_CHAIN_ID must be 4217.'),
    check('tempo_rpc_https', isRealPublicHttpsUrl(config.tempoRpcUrl), 'TEMPO_RPC_URL must be HTTPS and non-local.'),
    check('tempo_token_decimals_usdce', config.tempoTokenDecimals === 6, 'TEMPO_TOKEN_DECIMALS must be 6.'),
  ];

  for (const agent of config.agentWallets) {
    checks.push(...agentChecks(agent, config));
  }

  checks.push(check('first_live_test_tiny_caps', config.agentWallets.every((agent) => BigInt(agent.per_call_limit_base_units) <= FIRST_LIVE_MAX_PER_CALL_BASE_UNITS && BigInt(agent.daily_limit_base_units) <= FIRST_LIVE_MAX_DAILY_BASE_UNITS), 'First live test caps must be <= 0.01 USDC.e per call and <= 0.05 USDC.e daily.'));

  if (env.LIVE_READINESS_MODE === 'production') {
    checks.push(check('production_durable_ledger', config.ledgerBackend === 'upstash_redis' && env.SIGNER_LEDGER_DURABLE === 'true' && hasRealValue(config.upstashRedis.restUrl) && config.upstashRedis.restTokenConfigured && hasRealValue(config.upstashRedis.restToken), 'Production signer mode requires durable Upstash Redis ledger env.'));
  }

  return checks;
}

function agentChecks(agent, config) {
  const agentLabel = `agent ${agent.agent_id}`;
  const globalSignWith = normalizeAddress(config.turnkey.signWith);
  const accessKeySignWith = normalizeAddress(config.turnkey.accessKeySignWith);
  const agentSignWith = normalizeAddress(agent.turnkey_sign_with);
  const wallet = normalizeAddress(agent.wallet_address);
  const accessKey = normalizeAddress(agent.tempo_access_key_address);
  const service = agent.allowed_services[0] || '';
  const endpoint = agent.allowed_endpoints[0] || '';
  const command = agent.allowed_commands[0] || '';
  const checks = [
    check(`agent_${agent.agent_id}_enabled`, agent.enabled === true, `${agentLabel} must be enabled.`),
    check(`agent_${agent.agent_id}_wallet_real`, isRealAddress(wallet), `${agentLabel} wallet_address must be a real non-placeholder address.`),
    check(`agent_${agent.agent_id}_access_key_real`, isRealAddress(accessKey), `${agentLabel} tempo_access_key_address must be a real non-placeholder address.`),
    check(`agent_${agent.agent_id}_wallet_access_key_distinct`, wallet && accessKey && wallet !== accessKey, `${agentLabel} wallet_address and tempo_access_key_address must be different keys.`),
    check(`agent_${agent.agent_id}_single_service`, agent.allowed_services.length === 1 && isServiceHostname(service), `${agentLabel} first live test must allow exactly one real service hostname.`),
    check(`agent_${agent.agent_id}_single_endpoint`, agent.allowed_endpoints.length === 1 && isRealPublicHttpsUrl(endpoint), `${agentLabel} first live test must allow exactly one real public HTTPS endpoint.`),
    check(`agent_${agent.agent_id}_endpoint_matches_service`, endpointMatchesService(endpoint, service), `${agentLabel} first live endpoint host must match the allowed service hostname.`),
    check(`agent_${agent.agent_id}_single_supported_command`, agent.allowed_commands.length === 1 && SUPPORTED_FIRST_LIVE_COMMANDS.has(command), `${agentLabel} first live test must allow exactly one supported command.`),
    check(`agent_${agent.agent_id}_single_recipient`, agent.allowed_recipients.length === 1, `${agentLabel} first live test must allow exactly one recipient.`),
  ];

  if (config.turnkey.signWithMode === 'access_key') {
    checks.push(
      check(`agent_${agent.agent_id}_access_key_sign_with_matches_access_key`, !accessKeySignWith || accessKeySignWith === accessKey, `${agentLabel} TURNKEY_ACCESS_KEY_SIGN_WITH must match tempo_access_key_address when configured as an EVM address.`),
    );
  } else {
    checks.push(
      check(`agent_${agent.agent_id}_turnkey_sign_with_matches_wallet`, (!agentSignWith || agentSignWith === wallet) && (!globalSignWith || globalSignWith === wallet), `${agentLabel} TURNKEY_SIGN_WITH/turnkey_sign_with must match wallet_address when configured as an EVM address.`),
    );
  }

  return checks;
}

function check(name, ok, message, warning = '') {
  return {
    name,
    ok: Boolean(ok),
    message,
    ...(warning ? { warning } : {}),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '') ? value.toLowerCase() : '';
}

function isRealAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '') && !DEV_PLACEHOLDER_ADDRESSES.has(value.toLowerCase());
}

function hasRealValue(value) {
  const raw = String(value || '').trim();
  return Boolean(raw) && !/^__FILL_[A-Z0-9_]+__$/.test(raw);
}

function isStrongAdminToken(value) {
  return Boolean(value && value.length >= 32 && !['local-dev-token', 'smoke-token'].includes(value));
}

function isRealPublicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isDisallowedLiveHostname(url.hostname);
  } catch {
    return false;
  }
}

function isServiceHostname(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw.includes('/') || raw.includes(':') || raw.includes(' ')) {
    return false;
  }
  return !isDisallowedLiveHostname(raw) && raw.includes('.');
}

function endpointMatchesService(endpoint, service) {
  try {
    const url = new URL(endpoint);
    return url.hostname.toLowerCase() === String(service || '').trim().toLowerCase();
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

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked a signer secret.`);
    }
  }
}

function parseArgs(args) {
  const values = {
    envFile: process.env.SIGNER_ENV_FILE || '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/turnkey-live-handoff-check.js [--env-file .secrets/signer-live.env]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runTurnkeyLiveHandoffCheck(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}
