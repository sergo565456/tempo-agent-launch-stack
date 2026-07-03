import { fileURLToPath } from 'node:url';
import { getConfig as getAgentConfig } from '../src/config.js';
import { readOptionalEnvFile as readAgentEnvFile } from '../src/runtime/envFiles.js';
import { checkAgentProductionReadiness } from '../src/runtime/productionReadiness.js';
import { getConfig as getSignerConfig } from '../../tempo-outbound-signer/src/config.js';
import { readOptionalEnvFile as readSignerEnvFile } from '../../tempo-outbound-signer/src/envFiles.js';
import { checkLiveReadiness } from '../../tempo-outbound-signer/src/liveReadiness.js';

export async function runPredeployPairReadiness(options = {}) {
  const includeProcessEnv = options.includeProcessEnv !== false;
  const [agentEnvBundle, signerEnvBundle] = await Promise.all([
    loadEnvBundle({
      kind: 'agent',
      envFile: options.agentEnvFile || '',
      explicitEnv: options.agentEnv,
      includeProcessEnv,
      reader: readAgentEnvFile,
    }),
    loadEnvBundle({
      kind: 'signer',
      envFile: options.signerEnvFile || '',
      explicitEnv: options.signerEnv,
      includeProcessEnv,
      reader: (path) => readSignerEnvFile(path, { required: Boolean(path) }),
    }),
  ]);

  const agentConfig = getAgentConfig(agentEnvBundle.env);
  const signerConfig = getSignerConfig(signerEnvBundle.env);
  const agentReadiness = checkAgentProductionReadiness(agentConfig, agentEnvBundle.env);
  const signerReadiness = checkLiveReadiness(signerConfig, signerEnvBundle.env);
  const consistency = checkPairConsistency(agentConfig, signerConfig);

  const failures = [
    ...agentReadiness.failures.map((message) => `agent: ${message}`),
    ...signerReadiness.failures.map((message) => `signer: ${message}`),
    ...consistency.failures.map((message) => `pair: ${message}`),
  ];
  const warnings = [
    ...agentReadiness.warnings.map((message) => `agent: ${message}`),
    ...signerReadiness.warnings.map((message) => `signer: ${message}`),
    ...consistency.warnings.map((message) => `pair: ${message}`),
  ];

  return {
    ok: failures.length === 0,
    read_only: true,
    live_actions: false,
    failures,
    warnings,
    agent: {
      ok: agentReadiness.ok,
      failures: agentReadiness.failures,
      warnings: agentReadiness.warnings,
      summary: agentReadiness.summary,
      env_file: agentEnvBundle.env_file,
    },
    signer: {
      ok: signerReadiness.ok,
      mode: signerReadiness.mode,
      failures: signerReadiness.failures,
      warnings: signerReadiness.warnings,
      summary: signerReadiness.summary,
      env_file: signerEnvBundle.env_file,
    },
    consistency,
    note: 'No deploy, payment, signing, public HTTP request, or outbound MPP fetch was executed.',
  };
}

function checkPairConsistency(agentConfig, signerConfig) {
  const failures = [];
  const warnings = [];
  const signerAgent = signerConfig.agentWallets.find((agent) => agent.agent_id === agentConfig.outboundSigner.agentId);
  const matched = {
    signer_url_matches: false,
    admin_token_matches: false,
    agent_policy_found: Boolean(signerAgent),
    agent_policy_enabled: Boolean(signerAgent?.enabled),
    command_allowed: false,
    service_scope_aligned: false,
    endpoint_allowed: false,
    recipient_allowed: false,
    tempo_chain_matches: false,
    tempo_currency_matches: false,
    tempo_decimals_match: false,
    requested_amount_within_signer_limit: false,
    signer_per_call_not_wider_than_agent: false,
    signer_daily_not_wider_than_agent: false,
    public_runtimes_distinct: false,
    shared_upstash_backend_detected: false,
    shared_upstash_backend_explicitly_allowed: false,
    durable_ledger_prefixes_explicitly_configured: false,
    durable_ledger_prefixes_production_safe: false,
    durable_ledgers_distinct: false,
    durable_ledger_tokens_distinct: false,
    durable_ledger_prefixes_distinct: false,
    durable_ledger_isolation_ok: false,
    durable_ledger_token_isolation_ok: false,
  };

  matched.public_runtimes_distinct = normalizeUrl(agentConfig.publicBaseUrl) !== normalizeUrl(signerConfig.publicBaseUrl);
  if (!matched.public_runtimes_distinct) {
    failures.push('Agent PUBLIC_BASE_URL must be different from signer PUBLIC_BASE_URL.');
  }

  const agentUpstashUrl = normalizeUrl(agentConfig.upstashRedis.restUrl);
  const signerUpstashUrl = normalizeUrl(signerConfig.upstashRedis.restUrl);
  const sharedUpstashRestUrl = Boolean(agentUpstashUrl && signerUpstashUrl && agentUpstashUrl === signerUpstashUrl);
  const sharedUpstashRestToken = sameNonEmptyValue(
    agentConfig.upstashRedis.restToken,
    signerConfig.upstashRedis.restToken,
  );
  const sharedUpstashBackend = sharedUpstashRestUrl || sharedUpstashRestToken;
  matched.shared_upstash_backend_detected = sharedUpstashBackend;
  matched.shared_upstash_backend_explicitly_allowed = agentConfig.upstashRedis.sharedBackendAllowed === true
    && signerConfig.upstashRedis.sharedBackendAllowed === true;
  matched.durable_ledger_prefixes_explicitly_configured = agentConfig.upstashRedis.keyPrefixConfigured === true
    && signerConfig.upstashRedis.keyPrefixConfigured === true;
  matched.durable_ledger_prefixes_production_safe = isProductionRedisPrefix(agentConfig.upstashRedis.keyPrefix)
    && isProductionRedisPrefix(signerConfig.upstashRedis.keyPrefix);
  matched.durable_ledgers_distinct = Boolean(agentUpstashUrl && signerUpstashUrl && agentUpstashUrl !== signerUpstashUrl);
  matched.durable_ledger_tokens_distinct = !sharedUpstashRestToken;
  matched.durable_ledger_prefixes_distinct = normalizeRedisPrefix(agentConfig.upstashRedis.keyPrefix)
    !== normalizeRedisPrefix(signerConfig.upstashRedis.keyPrefix);
  matched.durable_ledger_isolation_ok = matched.durable_ledgers_distinct
    || (sharedUpstashBackend
      && matched.shared_upstash_backend_explicitly_allowed
      && matched.durable_ledger_prefixes_explicitly_configured
      && matched.durable_ledger_prefixes_production_safe
      && matched.durable_ledger_prefixes_distinct);
  matched.durable_ledger_token_isolation_ok = matched.durable_ledger_tokens_distinct
    || (sharedUpstashBackend
      && matched.shared_upstash_backend_explicitly_allowed
      && matched.durable_ledger_prefixes_explicitly_configured
      && matched.durable_ledger_prefixes_production_safe
      && matched.durable_ledger_prefixes_distinct);

  if (sharedUpstashBackend) {
    if (!matched.shared_upstash_backend_explicitly_allowed) {
      failures.push('Shared Upstash backend requires ALLOW_SHARED_UPSTASH_BACKEND=true in both agent and signer env files.');
    }
    if (!matched.durable_ledger_prefixes_explicitly_configured) {
      failures.push('Shared Upstash backend requires explicit AGENT_STORAGE_REDIS_PREFIX and SIGNER_LEDGER_REDIS_PREFIX values.');
    }
    if (!matched.durable_ledger_prefixes_production_safe) {
      failures.push('Shared Upstash backend requires production-safe Redis prefixes containing only letters, numbers, dots, underscores, colons, or hyphens.');
    }
    if (matched.shared_upstash_backend_explicitly_allowed && matched.durable_ledger_prefixes_distinct) {
      warnings.push('Agent and signer share one Upstash REST backend by explicit production choice; isolation relies on distinct Redis prefixes and the shared token can access both namespaces.');
    }
  }

  if (!matched.durable_ledger_isolation_ok) {
    failures.push('Agent and signer Redis prefixes must be different when sharing an Upstash backend.');
  }

  if (!matched.durable_ledger_token_isolation_ok) {
    failures.push('Agent and signer UPSTASH_REDIS_REST_TOKEN must be different unless the shared Upstash backend uses different Redis prefixes.');
  }

  matched.signer_url_matches = normalizeUrl(agentConfig.outboundSigner.baseUrl) === normalizeUrl(signerConfig.publicBaseUrl);
  if (!matched.signer_url_matches) {
    failures.push('OUTBOUND_SIGNER_BASE_URL must exactly match signer PUBLIC_BASE_URL.');
  }

  matched.admin_token_matches = Boolean(agentConfig.outboundSigner.adminToken)
    && agentConfig.outboundSigner.adminToken === signerConfig.signerAdminToken;
  if (!matched.admin_token_matches) {
    failures.push('OUTBOUND_SIGNER_ADMIN_TOKEN must match SIGNER_ADMIN_TOKEN.');
  }

  matched.tempo_chain_matches = agentConfig.tempoChainId === signerConfig.tempoChainId;
  if (!matched.tempo_chain_matches) {
    failures.push('Agent and signer TEMPO_CHAIN_ID must match.');
  }

  matched.tempo_currency_matches = normalizeAddress(agentConfig.tempoCurrencyAddress) === normalizeAddress(signerConfig.tempoUsdcAddress);
  if (!matched.tempo_currency_matches) {
    failures.push('Agent TEMPO_USDC_ADDRESS must match signer TEMPO_USDC_ADDRESS.');
  }

  matched.tempo_decimals_match = agentConfig.tempoTokenDecimals === signerConfig.tempoTokenDecimals;
  if (!matched.tempo_decimals_match) {
    failures.push('Agent and signer TEMPO_TOKEN_DECIMALS must match.');
  }

  if (!signerAgent) {
    failures.push(`Signer AGENT_WALLETS_JSON must include OUTBOUND_SIGNER_AGENT_ID ${agentConfig.outboundSigner.agentId}.`);
    return buildConsistencyResult(failures, warnings, matched, null, agentConfig);
  }

  if (!signerAgent.enabled) {
    failures.push(`Signer policy for ${agentConfig.outboundSigner.agentId} must be enabled.`);
  }

  matched.command_allowed = signerAgent.allowed_commands.includes(agentConfig.outboundSigner.command);
  if (!matched.command_allowed) {
    failures.push('OUTBOUND_SIGNER_COMMAND must be present in signer allowed_commands.');
  }

  const agentAllowedServices = new Set(agentConfig.outboundSpendPolicy.allowedServices.map((service) => service.toLowerCase()));
  const signerAllowedServices = new Set(signerAgent.allowed_services.map((service) => service.toLowerCase()));
  const servicesNotCovered = [...agentAllowedServices].filter((service) => !signerAllowedServices.has(service));
  matched.service_scope_aligned = servicesNotCovered.length === 0;
  if (!matched.service_scope_aligned) {
    failures.push('Signer allowed_services must cover every agent OUTBOUND_ALLOWED_SERVICES entry.');
  }

  matched.endpoint_allowed = signerAgent.allowed_endpoints.includes(agentConfig.outboundSpendPolicy.targetEndpoint);
  if (!matched.endpoint_allowed) {
    failures.push('Signer allowed_endpoints must include OUTBOUND_TARGET_ENDPOINT.');
  }

  matched.recipient_allowed = signerAgent.allowed_recipients
    .map(normalizeAddress)
    .includes(normalizeAddress(agentConfig.outboundSpendPolicy.targetRecipient));
  if (!matched.recipient_allowed) {
    failures.push('Signer allowed_recipients must include OUTBOUND_TARGET_RECIPIENT.');
  }

  const requestedAmount = parsePositiveInteger(agentConfig.outboundSpendPolicy.targetAmountBaseUnits, 'OUTBOUND_TARGET_AMOUNT_BASE_UNITS', failures);
  const signerPerCall = parsePositiveInteger(signerAgent.per_call_limit_base_units, 'signer per_call_limit_base_units', failures);
  const signerDaily = parsePositiveInteger(signerAgent.daily_limit_base_units, 'signer daily_limit_base_units', failures);
  const agentMaxPerCall = decimalToBaseUnits(agentConfig.outboundSpendPolicy.maxPerCallUsd, agentConfig.tempoTokenDecimals, 'MAX_OUTBOUND_PER_CALL_USD', failures);
  const agentMaxDaily = decimalToBaseUnits(agentConfig.outboundSpendPolicy.maxDailyUsd, agentConfig.tempoTokenDecimals, 'MAX_OUTBOUND_DAILY_USD', failures);

  if (requestedAmount !== null && signerPerCall !== null) {
    matched.requested_amount_within_signer_limit = requestedAmount <= signerPerCall;
    if (!matched.requested_amount_within_signer_limit) {
      failures.push('OUTBOUND_TARGET_AMOUNT_BASE_UNITS must be <= signer per_call_limit_base_units.');
    }
  }

  if (signerPerCall !== null && agentMaxPerCall !== null) {
    matched.signer_per_call_not_wider_than_agent = signerPerCall <= agentMaxPerCall;
    if (!matched.signer_per_call_not_wider_than_agent) {
      failures.push('Signer per_call_limit_base_units must not exceed agent MAX_OUTBOUND_PER_CALL_USD.');
    }
  }

  if (signerDaily !== null && agentMaxDaily !== null) {
    matched.signer_daily_not_wider_than_agent = signerDaily <= agentMaxDaily;
    if (!matched.signer_daily_not_wider_than_agent) {
      failures.push('Signer daily_limit_base_units must not exceed agent MAX_OUTBOUND_DAILY_USD.');
    }
  }

  return buildConsistencyResult(failures, warnings, matched, signerAgent, agentConfig);
}

function buildConsistencyResult(failures, warnings, matched, signerAgent, agentConfig) {
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    matched,
    summary: {
      agent_id: agentConfig.outboundSigner.agentId,
      command: agentConfig.outboundSigner.command,
      signer_policy_found: Boolean(signerAgent),
      signer_policy_enabled: Boolean(signerAgent?.enabled),
      agent_allowed_services_count: agentConfig.outboundSpendPolicy.allowedServices.length,
      signer_allowed_services_count: signerAgent?.allowed_services.length ?? 0,
      signer_allowed_endpoints_count: signerAgent?.allowed_endpoints.length ?? 0,
      signer_allowed_recipients_count: signerAgent?.allowed_recipients.length ?? 0,
      requested_amount_base_units: agentConfig.outboundSpendPolicy.targetAmountBaseUnits,
    },
  };
}

async function loadEnvBundle({ kind, envFile, explicitEnv, includeProcessEnv, reader }) {
  const baseEnv = explicitEnv || (includeProcessEnv ? process.env : {});
  const file = await reader(envFile);
  const env = {
    ...baseEnv,
    ...(file.exists ? file.values : {}),
  };

  return {
    env,
    env_file: {
      path: file.exists ? file.path : (envFile || null),
      exists: file.exists,
      loaded_keys: Object.keys(file.values).sort(),
      kind,
    },
  };
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function normalizeRedisPrefix(value) {
  return String(value || '').trim().toLowerCase();
}

function isProductionRedisPrefix(value) {
  const normalized = String(value || '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,80}$/.test(normalized);
}

function sameNonEmptyValue(left, right) {
  const normalizedLeft = String(left || '').trim();
  const normalizedRight = String(right || '').trim();
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function parsePositiveInteger(value, label, failures) {
  if (!/^\d+$/.test(String(value || ''))) {
    failures.push(`${label} must be a positive integer string.`);
    return null;
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    failures.push(`${label} must be greater than zero.`);
    return null;
  }
  return parsed;
}

function decimalToBaseUnits(value, decimals, label, failures) {
  const raw = String(value || '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    failures.push(`${label} must be a decimal string with up to 6 decimals.`);
    return null;
  }
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > decimals) {
    failures.push(`${label} has more fractional digits than TEMPO_TOKEN_DECIMALS.`);
    return null;
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function parseArgs(args) {
  const values = {
    agentEnvFile: process.env.AGENT_PRODUCTION_ENV_FILE || process.env.APP_ENV_FILE || '',
    signerEnvFile: process.env.SIGNER_ENV_FILE || '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--agent-env-file' && next) {
      values.agentEnvFile = next;
      i += 1;
    } else if (arg === '--signer-env-file' && next) {
      values.signerEnvFile = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/predeploy-pair-readiness.js --agent-env-file .secrets/agent-production.env --signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runPredeployPairReadiness(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
