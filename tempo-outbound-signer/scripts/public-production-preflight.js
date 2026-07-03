import { fileURLToPath } from 'node:url';

const DEFAULT_LEDGER_PROBE_IDEMPOTENCY_KEY = 'signer-public-preflight-no-record';
const FIRST_LIVE_MAX_PER_CALL_BASE_UNITS = 10_000n;
const FIRST_LIVE_MAX_DAILY_BASE_UNITS = 50_000n;
const DEFAULT_EXPECTED_FIRST_LIVE_SERVICE = 'mpp.browserbase.com';
const DEFAULT_EXPECTED_FIRST_LIVE_ENDPOINT = 'https://mpp.browserbase.com/fetch';
const DEFAULT_EXPECTED_FIRST_LIVE_COMMAND = 'fetch_browserbase_page';
const DEFAULT_EXPECTED_FIRST_LIVE_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const DEV_PLACEHOLDER_ADDRESSES = new Set([
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]);

export async function runPublicSignerProductionPreflight(options) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!options.allowHttp) {
    requireHttps(baseUrl);
  }
  if (!options.adminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public signer production preflight.');
  }

  const secretValues = [options.adminToken].filter(Boolean);
  const expectedProvider = options.expectProvider || 'turnkey';
  const expectedAgentId = options.expectAgentId || 'agent-launch-intel';
  const ledgerProbeIdempotencyKey = options.ledgerProbeIdempotencyKey || DEFAULT_LEDGER_PROBE_IDEMPOTENCY_KEY;
  const expectedPolicy = {
    service: options.expectedService || DEFAULT_EXPECTED_FIRST_LIVE_SERVICE,
    endpoint: options.expectedEndpoint || DEFAULT_EXPECTED_FIRST_LIVE_ENDPOINT,
    command: options.expectedCommand || DEFAULT_EXPECTED_FIRST_LIVE_COMMAND,
    recipient: options.expectedRecipient || DEFAULT_EXPECTED_FIRST_LIVE_RECIPIENT,
  };

  const health = await request(baseUrl, 'GET', '/health');
  assertStatus(health, 200, 'signer health');
  assertNoSecretLeak('signer health', health.text, secretValues);
  if (health.body.status !== 'ok') {
    throw new Error(`signer health expected status=ok, got ${JSON.stringify(health.body).slice(0, 500)}`);
  }

  const readiness = await request(baseUrl, 'GET', '/v1/readiness');
  assertStatus(readiness, 200, 'signer readiness');
  assertNoSecretLeak('signer readiness', readiness.text, secretValues);
  if (readiness.body.provider !== expectedProvider) {
    throw new Error(`expected signer provider ${expectedProvider}, got ${readiness.body.provider}`);
  }
  if (readiness.body.ok !== true) {
    throw new Error(`signer readiness is not ok: ${JSON.stringify(readiness.body).slice(0, 700)}`);
  }
  if (readiness.body.admin_token_configured !== true) {
    throw new Error('signer admin token is not configured.');
  }
  const ledger = readiness.body.ledger || {};
  if (ledger.backend !== 'upstash_redis' || ledger.durable_configured !== true) {
    throw new Error(`signer ledger is not durable: ${JSON.stringify(ledger).slice(0, 300)}`);
  }
  const adminRateLimit = assertSafeAdminRateLimit(readiness.body.admin_rate_limit || {});

  const unauthorizedAgents = await request(baseUrl, 'GET', '/v1/agents');
  assertStatus(unauthorizedAgents, 401, 'unauthorized signer agent inventory');
  assertNoSecretLeak('unauthorized signer agent inventory', unauthorizedAgents.text, secretValues);

  const authorizedAgents = await request(baseUrl, 'GET', '/v1/agents', {
    headers: {
      authorization: `Bearer ${options.adminToken}`,
    },
  });
  assertStatus(authorizedAgents, 200, 'authorized signer agent inventory');
  assertNoSecretLeak('authorized signer agent inventory', authorizedAgents.text, secretValues);
  if (!Array.isArray(authorizedAgents.body.agents)) {
    throw new Error('authorized signer agent inventory did not return an agents array.');
  }
  const agentPolicy = authorizedAgents.body.agents.find((agent) => agent.agent_id === expectedAgentId);
  if (!agentPolicy) {
    throw new Error(`expected signer agent policy ${expectedAgentId} was not found.`);
  }
  const agentPolicySafety = assertSafeFirstLiveAgentPolicy(agentPolicy, expectedAgentId, expectedPolicy);

  const ledgerPath = `/v1/agents/${encodeURIComponent(expectedAgentId)}/ledger/${encodeURIComponent(ledgerProbeIdempotencyKey)}`;
  const unauthorizedLedger = await request(baseUrl, 'GET', ledgerPath);
  assertStatus(unauthorizedLedger, 401, 'unauthorized signer ledger lookup');
  assertNoSecretLeak('unauthorized signer ledger lookup', unauthorizedLedger.text, secretValues);

  const authorizedLedger = await request(baseUrl, 'GET', ledgerPath, {
    headers: {
      authorization: `Bearer ${options.adminToken}`,
    },
  });
  assertStatus(authorizedLedger, 404, 'authorized signer empty-ledger lookup');
  assertNoSecretLeak('authorized signer empty-ledger lookup', authorizedLedger.text, secretValues);
  if (authorizedLedger.body?.error !== 'ledger_record_not_found') {
    throw new Error(`expected empty ledger probe to return ledger_record_not_found, got ${JSON.stringify(authorizedLedger.body).slice(0, 500)}`);
  }

  const summary = {
    ok: true,
    read_only: true,
    base_url: baseUrl,
    provider: readiness.body.provider,
    readiness_ok: readiness.body.ok,
    ledger_backend: ledger.backend,
    ledger_durable_configured: ledger.durable_configured,
    admin_rate_limit: adminRateLimit,
    unauthorized_agents_status: unauthorizedAgents.status,
    authorized_agents_status: authorizedAgents.status,
    authorized_agent_count: authorizedAgents.body.agents.length,
    expected_agent_id: expectedAgentId,
    expected_agent_found: true,
    agent_policy_safety: agentPolicySafety,
    ledger_probe_idempotency_key: ledgerProbeIdempotencyKey,
    unauthorized_ledger_status: unauthorizedLedger.status,
    authorized_empty_ledger_status: authorizedLedger.status,
    note: 'Read-only signer production preflight. No payment, signing, MPP fetch, or provider execution route was called.',
  };

  assertNoSecretLeak('signer production preflight summary', JSON.stringify(summary), secretValues);
  return summary;
}

function assertSafeFirstLiveAgentPolicy(agentPolicy, expectedAgentId, expectedPolicy) {
  const wallet = normalizeAddress(agentPolicy.wallet_address);
  const accessKey = normalizeAddress(agentPolicy.tempo_access_key_address);
  const serviceList = normalizeList(agentPolicy.allowed_services);
  const endpointList = normalizeList(agentPolicy.allowed_endpoints);
  const recipientList = normalizeList(agentPolicy.allowed_recipients).map((address) => address.toLowerCase());
  const commandList = normalizeList(agentPolicy.allowed_commands);
  const perCall = parseBaseUnits(agentPolicy.per_call_limit_base_units, 'per_call_limit_base_units');
  const daily = parseBaseUnits(agentPolicy.daily_limit_base_units, 'daily_limit_base_units');

  if (agentPolicy.agent_id !== expectedAgentId) {
    throw new Error(`signer agent policy id mismatch: expected ${expectedAgentId}, got ${agentPolicy.agent_id}`);
  }
  if (agentPolicy.enabled !== true) {
    throw new Error(`signer agent policy ${expectedAgentId} is not enabled.`);
  }
  if (!isRealAddress(wallet)) {
    throw new Error(`signer agent policy ${expectedAgentId} wallet_address is not a real non-placeholder address.`);
  }
  if (!isRealAddress(accessKey)) {
    throw new Error(`signer agent policy ${expectedAgentId} tempo_access_key_address is not a real non-placeholder address.`);
  }
  if (wallet === accessKey) {
    throw new Error(`signer agent policy ${expectedAgentId} wallet_address and tempo_access_key_address must be different keys.`);
  }
  if (agentPolicy.turnkey_sign_with_configured !== true) {
    throw new Error(`signer agent policy ${expectedAgentId} must have turnkey_sign_with configured.`);
  }
  if (!sameList(serviceList, [expectedPolicy.service])) {
    throw new Error(`signer agent policy ${expectedAgentId} must allow only ${expectedPolicy.service}.`);
  }
  if (!sameList(endpointList, [expectedPolicy.endpoint])) {
    throw new Error(`signer agent policy ${expectedAgentId} must allow only ${expectedPolicy.endpoint}.`);
  }
  if (!sameList(commandList, [expectedPolicy.command])) {
    throw new Error(`signer agent policy ${expectedAgentId} must allow only ${expectedPolicy.command}.`);
  }
  if (!sameList(recipientList, [expectedPolicy.recipient.toLowerCase()])) {
    throw new Error(`signer agent policy ${expectedAgentId} must allow only the pinned first-live recipient.`);
  }
  if (perCall > FIRST_LIVE_MAX_PER_CALL_BASE_UNITS) {
    throw new Error(`signer agent policy ${expectedAgentId} per-call limit exceeds first-live cap.`);
  }
  if (daily > FIRST_LIVE_MAX_DAILY_BASE_UNITS) {
    throw new Error(`signer agent policy ${expectedAgentId} daily limit exceeds first-live cap.`);
  }

  return {
    enabled: true,
    wallet_access_key_distinct: true,
    turnkey_sign_with_configured: true,
    service: expectedPolicy.service,
    endpoint: expectedPolicy.endpoint,
    command: expectedPolicy.command,
    recipient: `${expectedPolicy.recipient.slice(0, 6)}...${expectedPolicy.recipient.slice(-4)}`,
    per_call_limit_base_units: perCall.toString(),
    daily_limit_base_units: daily.toString(),
  };
}

function assertSafeAdminRateLimit(rateLimit) {
  if (rateLimit.enabled !== true) {
    throw new Error(`signer admin rate limit is not enabled: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  const max = Number(rateLimit.max);
  if (!Number.isInteger(max) || max < 1 || max > 120) {
    throw new Error(`signer admin rate limit max must be between 1 and 120: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  const windowMs = Number(rateLimit.window_ms);
  if (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 3_600_000) {
    throw new Error(`signer admin rate limit window_ms must be between 1000 and 3600000: ${JSON.stringify(rateLimit).slice(0, 300)}`);
  }

  return {
    enabled: true,
    max,
    window_ms: windowMs,
  };
}

function normalizeAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '') ? value.toLowerCase() : '';
}

function isRealAddress(value) {
  return /^0x[a-f0-9]{40}$/.test(value || '') && !DEV_PLACEHOLDER_ADDRESSES.has(value);
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseBaseUnits(value, label) {
  if (!/^\d+$/.test(String(value || ''))) {
    throw new Error(`signer agent policy ${label} must be a base-unit integer string.`);
  }
  return BigInt(value);
}

async function request(baseUrl, method, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...init,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    status: response.status,
    body,
    text,
  };
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
  }
}

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin token.`);
    }
  }
}

function normalizeBaseUrl(value) {
  const raw = (value || '').trim().replace(/\/$/, '');
  if (!raw) {
    throw new Error('baseUrl is required.');
  }

  try {
    new URL(raw);
  } catch {
    throw new Error('baseUrl must be a valid URL.');
  }

  return raw;
}

function requireHttps(value) {
  if (!/^https:\/\//.test(value)) {
    throw new Error('Public signer production preflight requires HTTPS. Use --allow-http only for local diagnostics.');
  }
}

function parseArgs(args) {
  const values = {
    baseUrl: process.env.PUBLIC_SIGNER_BASE_URL || '',
    adminToken: process.env.SIGNER_ADMIN_TOKEN || '',
    expectProvider: process.env.EXPECT_SIGNER_PROVIDER || 'turnkey',
    expectAgentId: process.env.EXPECT_SIGNER_AGENT_ID || 'agent-launch-intel',
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || DEFAULT_EXPECTED_FIRST_LIVE_SERVICE,
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || DEFAULT_EXPECTED_FIRST_LIVE_ENDPOINT,
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || DEFAULT_EXPECTED_FIRST_LIVE_COMMAND,
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || DEFAULT_EXPECTED_FIRST_LIVE_RECIPIENT,
    ledgerProbeIdempotencyKey: process.env.SIGNER_LEDGER_PROBE_IDEMPOTENCY_KEY || DEFAULT_LEDGER_PROBE_IDEMPOTENCY_KEY,
    allowHttp: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--') && !values.baseUrl) {
      values.baseUrl = arg;
    } else if (arg === '--base-url' && next) {
      values.baseUrl = next;
      i += 1;
    } else if (arg === '--admin-token-env' && next) {
      values.adminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--expect-provider' && next) {
      values.expectProvider = next;
      i += 1;
    } else if (arg === '--expect-agent-id' && next) {
      values.expectAgentId = next;
      i += 1;
    } else if (arg === '--expected-service' && next) {
      values.expectedService = next;
      i += 1;
    } else if (arg === '--expected-endpoint' && next) {
      values.expectedEndpoint = next;
      i += 1;
    } else if (arg === '--expected-command' && next) {
      values.expectedCommand = next;
      i += 1;
    } else if (arg === '--expected-recipient' && next) {
      values.expectedRecipient = next;
      i += 1;
    } else if (arg === '--ledger-probe-idempotency-key' && next) {
      values.ledgerProbeIdempotencyKey = next;
      i += 1;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-production-preflight.js https://signer.example [--expect-provider turnkey] [--expect-agent-id agent-launch-intel] [--expected-service graph.codex.io] [--expected-endpoint https://graph.codex.io/graphql] [--expected-command codex_graphql_query] [--expected-recipient 0x...] [--admin-token-env SIGNER_ADMIN_TOKEN]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicSignerProductionPreflight(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
