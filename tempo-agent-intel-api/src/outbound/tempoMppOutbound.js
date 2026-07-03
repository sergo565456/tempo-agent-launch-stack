import { loadAgentAccessKeyBundle } from '../runtime/accessKeyReadiness.js';
import { loadMppxClient, loadTempoSdk } from '../runtime/tempoDeps.js';

const BROWSERBASE_FETCH_ENDPOINT = 'https://mpp.browserbase.com/fetch';
const BROWSERBASE_SERVICE = 'mpp.browserbase.com';
const BROWSERBASE_FETCH_COMMAND = 'fetch_browserbase_page';

function getOutboundService(config) {
  return config.outboundSpendPolicy.targetService || BROWSERBASE_SERVICE;
}

function getOutboundEndpoint(config) {
  return config.outboundSpendPolicy.targetEndpoint || BROWSERBASE_FETCH_ENDPOINT;
}

function buildBrowserbaseFetchRequestInit(config) {
  return {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url: config.outboundSpendPolicy.browserbaseFetchUrl,
      format: 'markdown',
    }),
  };
}

export async function runBrowserbaseFetchOutbound(config, options = {}) {
  if (config.outboundSpendPolicy.paymentProvider === 'remote_signer') {
    return runRemoteSignerBrowserbaseOutbound(config, options);
  }

  if (config.outboundSpendPolicy.paymentProvider !== 'local_access_key') {
    throw httpError(500, `Unsupported outbound payment provider: ${config.outboundSpendPolicy.paymentProvider}`);
  }

  return runTempoMppOutboundFetch(config, {
    endpoint: getOutboundEndpoint(config),
    service: getOutboundService(config),
    clientId: 'agent-launch-intel-browserbase-fetch',
    requestInit: buildBrowserbaseFetchRequestInit(config),
  });
}

export function buildBrowserbaseFetchOutboundPreview(config, options = {}) {
  const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey)
    || makeOutboundIdempotencyKey('preview');
  const blockers = [];
  const warnings = [];
  const prepared = buildRemoteSignerBrowserbaseRequest(config, { idempotencyKey });

  if (!config.outboundAdminToken) {
    blockers.push('OUTBOUND_ADMIN_TOKEN is required to trigger the outbound admin route.');
  }

  if (config.outboundSpendPolicy.paymentProvider !== 'remote_signer') {
    blockers.push(`OUTBOUND_PAYMENT_PROVIDER must be remote_signer for the recommended live path; current value is ${config.outboundSpendPolicy.paymentProvider}.`);
  }

  if (!config.outboundSpendPolicy.livePaymentsEnabled) {
    blockers.push('OUTBOUND_LIVE_PAYMENTS is false.');
  }

  if (!config.outboundSigner.baseUrl) {
    blockers.push('OUTBOUND_SIGNER_BASE_URL is required.');
  }

  if (!config.outboundSigner.adminToken) {
    blockers.push('OUTBOUND_SIGNER_ADMIN_TOKEN is required.');
  }

  if (!isAllowedService(config.outboundSpendPolicy, getOutboundService(config), new URL(getOutboundEndpoint(config)).hostname)) {
    blockers.push(`Outbound service ${getOutboundService(config)} is not on the allowlist.`);
  }

  try {
    assertOutboundSignerAmountWithinCap(config);
  } catch (error) {
    blockers.push(error.message);
  }

  if (prepared.signer_url && prepared.signer_url.protocol !== 'https:' && !isLocalhost(prepared.signer_url.hostname)) {
    blockers.push('OUTBOUND_SIGNER_BASE_URL must use HTTPS for public live use.');
  } else if (prepared.signer_url && prepared.signer_url.protocol !== 'https:') {
    warnings.push('OUTBOUND_SIGNER_BASE_URL is using local HTTP; this is allowed only for local diagnostics.');
  }

  return {
    ok: blockers.length === 0,
    read_only: true,
    provider: 'remote_signer',
    outbound_admin_token_configured: Boolean(config.outboundAdminToken),
    signer_admin_token_configured: Boolean(config.outboundSigner.adminToken),
    signer_agent_id: config.outboundSigner.agentId,
    signer_command: config.outboundSigner.command,
    request: {
      method: 'POST',
      url: prepared.redacted_signer_url,
      body: prepared.payload,
    },
    limits: {
      max_per_call_usd: config.outboundSpendPolicy.maxPerCallUsd,
      max_daily_usd: config.outboundSpendPolicy.maxDailyUsd,
      max_amount_base_units: decimalToBaseUnits(config.outboundSpendPolicy.maxPerCallUsd, config.tempoTokenDecimals),
      requested_amount_base_units: config.outboundSpendPolicy.targetAmountBaseUnits,
      token_decimals: config.tempoTokenDecimals,
    },
    blockers,
    warnings,
    note: 'Preview only. No signer request, payment, or outbound MPP fetch was executed.',
  };
}

export async function buildOutboundReadiness(config) {
  const blockers = [];
  const warnings = [];
  const readiness = {
    ok: false,
    read_only: true,
    payment_provider: config.outboundSpendPolicy.paymentProvider,
    live_payments_enabled: config.outboundSpendPolicy.livePaymentsEnabled,
    admin_endpoint_configured: Boolean(config.outboundAdminToken),
    policy: {
      allowed_services: config.outboundSpendPolicy.allowedServices,
      deny_unknown_services: config.outboundSpendPolicy.denyUnknownServices,
      max_per_call_usd: config.outboundSpendPolicy.maxPerCallUsd,
      max_daily_usd: config.outboundSpendPolicy.maxDailyUsd,
      target_service: getOutboundService(config),
      target_endpoint: getOutboundEndpoint(config),
      target_amount_base_units: config.outboundSpendPolicy.targetAmountBaseUnits,
      target_recipient: config.outboundSpendPolicy.targetRecipient,
      allow_dynamic_mpp_recipient: config.outboundSpendPolicy.allowDynamicMppRecipient === true,
      browserbase_fetch_url: config.outboundSpendPolicy.browserbaseFetchUrl,
    },
    remote_signer: null,
    blockers,
    warnings,
  };

  if (!config.outboundSpendPolicy.livePaymentsEnabled) {
    blockers.push('OUTBOUND_LIVE_PAYMENTS is false.');
  }

  if (!isAllowedService(config.outboundSpendPolicy, getOutboundService(config), new URL(getOutboundEndpoint(config)).hostname)) {
    blockers.push(`Outbound service ${getOutboundService(config)} is not on the allowlist.`);
  }

  try {
    assertOutboundSignerAmountWithinCap(config);
  } catch (error) {
    blockers.push(error.message);
  }

  if (config.outboundSpendPolicy.paymentProvider === 'remote_signer') {
    readiness.remote_signer = await probeRemoteSignerReadiness(config, { blockers, warnings });
  } else if (config.outboundSpendPolicy.paymentProvider === 'local_access_key') {
    warnings.push('local_access_key mode requires local Tempo Access Key readiness; remote signer is the recommended live path.');
  } else {
    blockers.push(`Unsupported outbound payment provider: ${config.outboundSpendPolicy.paymentProvider}`);
  }

  readiness.ok = blockers.length === 0;
  return readiness;
}

async function runRemoteSignerBrowserbaseOutbound(config, options = {}) {
  if (!config.outboundSpendPolicy.livePaymentsEnabled) {
    throw httpError(501, 'Outbound live payments are disabled.');
  }

  if (!config.outboundSigner.baseUrl) {
    throw httpError(501, 'OUTBOUND_SIGNER_BASE_URL is required for remote_signer outbound payments.');
  }

  if (!config.outboundSigner.adminToken) {
    throw httpError(501, 'OUTBOUND_SIGNER_ADMIN_TOKEN is required for remote_signer outbound payments.');
  }

  if (!isAllowedService(config.outboundSpendPolicy, getOutboundService(config), new URL(getOutboundEndpoint(config)).hostname)) {
    throw httpError(403, `Outbound service ${getOutboundService(config)} is not on the allowlist.`);
  }

  assertOutboundSignerAmountWithinCap(config);

  const { signer_url: signerUrl, payload } = buildRemoteSignerBrowserbaseRequest(config, {
    idempotencyKey: normalizeIdempotencyKey(options.idempotencyKey) || makeOutboundIdempotencyKey(),
  });

  const response = await fetch(signerUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.outboundSigner.adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await parseJsonResponse(response);

  if (!response.ok) {
    throw httpError(response.status, `Remote outbound signer rejected request: ${body.message || body.error || response.status}`);
  }

  return {
    ok: true,
    provider: 'remote_signer',
    signer_url: redactSignerUrl(signerUrl),
    signer_agent_id: config.outboundSigner.agentId,
    signer_command: config.outboundSigner.command,
    service: getOutboundService(config),
    endpoint: getOutboundEndpoint(config),
    max_amount_base_units: decimalToBaseUnits(config.outboundSpendPolicy.maxPerCallUsd, config.tempoTokenDecimals),
    requested_amount_base_units: config.outboundSpendPolicy.targetAmountBaseUnits,
    recipient: body.fetch_result?.recipient || body.approval?.recipient || config.outboundSpendPolicy.targetRecipient,
    requested_recipient: body.approval?.requested_recipient || config.outboundSpendPolicy.targetRecipient,
    allow_dynamic_mpp_recipient: config.outboundSpendPolicy.allowDynamicMppRecipient === true,
    browserbase_fetch_url: config.outboundSpendPolicy.browserbaseFetchUrl,
    signer_response: body,
  };
}

function buildRemoteSignerBrowserbaseRequest(config, { idempotencyKey }) {
  const signerUrl = config.outboundSigner.baseUrl
    ? new URL(`/v1/agents/${encodeURIComponent(config.outboundSigner.agentId)}/mpp/fetch`, config.outboundSigner.baseUrl)
    : null;
  const payload = {
    confirm: 'fetch-one-mpp-endpoint',
    idempotency_key: idempotencyKey,
    command: config.outboundSigner.command || BROWSERBASE_FETCH_COMMAND,
    service: getOutboundService(config),
    endpoint: getOutboundEndpoint(config),
    recipient: config.outboundSpendPolicy.targetRecipient,
    allow_dynamic_mpp_recipient: config.outboundSpendPolicy.allowDynamicMppRecipient === true,
    currency: config.tempoCurrencyAddress,
    chain_id: config.tempoChainId,
    amount_base_units: config.outboundSpendPolicy.targetAmountBaseUnits,
    browserbase_fetch_url: config.outboundSpendPolicy.browserbaseFetchUrl,
  };

  return {
    signer_url: signerUrl,
    redacted_signer_url: signerUrl ? redactSignerUrl(signerUrl) : '',
    payload,
  };
}

async function probeRemoteSignerReadiness(config, { blockers, warnings }) {
  const result = {
    configured: Boolean(config.outboundSigner.baseUrl && config.outboundSigner.adminToken),
    base_url: config.outboundSigner.baseUrl ? redactBaseUrl(config.outboundSigner.baseUrl) : '',
    agent_id: config.outboundSigner.agentId,
    command: config.outboundSigner.command,
    health: null,
    readiness: null,
    agent_policy: null,
  };

  if (!config.outboundSigner.baseUrl) {
    blockers.push('OUTBOUND_SIGNER_BASE_URL is required.');
    return result;
  }

  if (!config.outboundSigner.adminToken) {
    blockers.push('OUTBOUND_SIGNER_ADMIN_TOKEN is required.');
    return result;
  }

  let baseUrl;
  try {
    baseUrl = new URL(config.outboundSigner.baseUrl);
  } catch {
    blockers.push('OUTBOUND_SIGNER_BASE_URL must be a valid URL.');
    return result;
  }

  if (baseUrl.protocol !== 'https:' && !isLocalhost(baseUrl.hostname)) {
    blockers.push('OUTBOUND_SIGNER_BASE_URL must use HTTPS for public live use.');
  } else if (baseUrl.protocol !== 'https:') {
    warnings.push('OUTBOUND_SIGNER_BASE_URL is using local HTTP; this is allowed only for local diagnostics.');
  }

  try {
    const [health, signerReadiness, agents] = await Promise.all([
      fetchSignerJson(baseUrl, '/health'),
      fetchSignerJson(baseUrl, '/v1/readiness'),
      fetchSignerJson(baseUrl, '/v1/agents', {
        authorization: `Bearer ${config.outboundSigner.adminToken}`,
      }),
    ]);

    result.health = {
      status: health.status,
      ok: health.status === 200 && health.body?.status === 'ok',
      provider: health.body?.provider ?? null,
      agent_count: health.body?.agent_count ?? null,
    };
    result.readiness = {
      status: signerReadiness.status,
      ok: Boolean(signerReadiness.body?.ok),
      provider: signerReadiness.body?.provider ?? null,
      admin_token_configured: Boolean(signerReadiness.body?.admin_token_configured),
      turnkey: {
        organization_configured: Boolean(signerReadiness.body?.turnkey?.organization_configured),
        api_public_key_configured: Boolean(signerReadiness.body?.turnkey?.api_public_key_configured),
        api_private_key_configured: Boolean(signerReadiness.body?.turnkey?.api_private_key_configured),
        policy_configured: Boolean(signerReadiness.body?.turnkey?.policy_configured),
        sign_with_mode: signerReadiness.body?.turnkey?.sign_with_mode ?? null,
      },
      ledger: {
        backend: signerReadiness.body?.ledger?.backend ?? null,
        durable_configured: Boolean(signerReadiness.body?.ledger?.durable_configured),
      },
      admin_rate_limit: summarizeAdminRateLimit(signerReadiness.body?.admin_rate_limit),
    };
    result.agent_policy = summarizeSignerAgentPolicy(agents.body, config.outboundSigner.agentId);

    if (!result.health.ok) {
      blockers.push(`Remote signer health is not ok: HTTP ${health.status}.`);
    }
    if (signerReadiness.status !== 200 || !result.readiness.ok) {
      blockers.push(`Remote signer readiness is not ok: HTTP ${signerReadiness.status}.`);
    }
    if (agents.status !== 200) {
      blockers.push(`Remote signer agent policy inventory rejected admin token: HTTP ${agents.status}.`);
    } else if (!result.agent_policy?.found) {
      blockers.push(`Remote signer does not expose policy for agent ${config.outboundSigner.agentId}.`);
    }
  } catch (error) {
    blockers.push(`Remote signer readiness probe failed: ${error.message}`);
  }

  return result;
}

async function fetchSignerJson(baseUrl, path, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'GET',
    headers,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return {
    status: response.status,
    body,
  };
}

function summarizeAdminRateLimit(rateLimit) {
  if (!rateLimit || typeof rateLimit !== 'object') {
    return null;
  }

  return {
    enabled: rateLimit.enabled === true,
    max: Number.isFinite(Number(rateLimit.max)) ? Number(rateLimit.max) : null,
    window_ms: Number.isFinite(Number(rateLimit.window_ms)) ? Number(rateLimit.window_ms) : null,
  };
}

function summarizeSignerAgentPolicy(body, agentId) {
  const agents = Array.isArray(body?.agents) ? body.agents : [];
  const agent = agents.find((item) => item.agent_id === agentId);
  if (!agent) {
    return {
      found: false,
      agent_id: agentId,
    };
  }

  return {
    found: true,
    agent_id: agent.agent_id,
    enabled: Boolean(agent.enabled),
    wallet_address: agent.wallet_address,
    tempo_access_key_address: agent.tempo_access_key_address,
    per_call_limit_base_units: agent.per_call_limit_base_units,
    daily_limit_base_units: agent.daily_limit_base_units,
    allowed_services: agent.allowed_services,
    allowed_endpoints: agent.allowed_endpoints,
    allowed_recipients: agent.allowed_recipients,
    allow_dynamic_mpp_recipient: agent.allow_dynamic_mpp_recipient === true,
    allowed_commands: agent.allowed_commands,
  };
}

async function runTempoMppOutboundFetch(config, { endpoint, service, clientId, requestInit }) {
  if (!config.outboundSpendPolicy.livePaymentsEnabled) {
    throw httpError(501, 'Outbound live payments are disabled.');
  }

  const url = new URL(endpoint);
  if (url.protocol !== 'https:') {
    throw httpError(400, 'Outbound endpoint must use HTTPS.');
  }

  if (!isAllowedService(config.outboundSpendPolicy, service, url.hostname)) {
    throw httpError(403, `Outbound service ${service} is not on the allowlist.`);
  }

  const accessBundle = await loadAgentAccessKeyBundle(config);
  assertAccessBundleReady(accessBundle);

  const maxAmountBaseUnits = decimalToBaseUnits(config.outboundSpendPolicy.maxPerCallUsd, config.tempoTokenDecimals);
  const sdk = await loadTempoSdk(config);
  const mppxClient = await loadMppxClient(config);
  const account = sdk.Account.fromSecp256k1(accessBundle.private_key, {
    access: accessBundle.root_account_address,
  });

  if (account.address.toLowerCase() !== accessBundle.root_account_address.toLowerCase()) {
    throw httpError(500, 'Access Key account resolves to an unexpected root account.');
  }

  if (account.accessKeyAddress.toLowerCase() !== accessBundle.access_key_address.toLowerCase()) {
    throw httpError(500, 'Access Key private key does not match configured Access Key address.');
  }

  const client = sdk.createClient({
    account,
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const before = await readAccessState({ config, sdk, accessBundle });
  let selectedChallenge = null;

  const payment = mppxClient.Mppx.create({
    polyfill: false,
    methods: [
      mppxClient.tempo.charge({
        account: client.account,
        clientId,
        getClient: async () => client,
      }),
    ],
    onChallenge: async (challenge, helpers) => {
      selectedChallenge = summarizeChallenge(challenge);
      validateChallenge(challenge, config, maxAmountBaseUnits);
      return helpers.createCredential();
    },
  });

  const response = await payment.fetch(url.toString(), requestInit || {
    headers: { accept: 'application/json' },
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw httpError(502, `Outbound service returned HTTP ${response.status}: ${responseText.slice(0, 180)}`);
  }

  const receiptHeader = response.headers.get('payment-receipt') || '';
  if (!receiptHeader) {
    throw httpError(502, 'Outbound service response did not include a payment-receipt header.');
  }

  const after = await readAccessState({ config, sdk, accessBundle });

  return {
    ok: true,
    service,
    endpoint: url.toString(),
    max_amount_base_units: maxAmountBaseUnits,
    payer_account: accessBundle.root_account_address,
    payer_access_key: accessBundle.access_key_address,
    challenge: selectedChallenge,
    receipt: decodeReceiptSummary(receiptHeader),
    response_status: response.status,
    response_preview: previewJsonOrText(responseText),
    before,
    after,
  };
}

function assertAccessBundleReady(accessBundle) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(accessBundle.root_account_address)) {
    throw httpError(500, 'AGENT_ROOT_ACCOUNT_ADDRESS is missing or invalid.');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(accessBundle.access_key_address)) {
    throw httpError(500, 'AGENT_ACCESS_KEY_ADDRESS is missing or invalid.');
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(accessBundle.private_key)) {
    throw httpError(500, 'AGENT_ACCESS_KEY_PRIVATE_KEY is missing or invalid.');
  }
}

function assertOutboundSignerAmountWithinCap(config) {
  const maxAmountBaseUnits = decimalToBaseUnits(config.outboundSpendPolicy.maxPerCallUsd, config.tempoTokenDecimals);
  const requested = config.outboundSpendPolicy.targetAmountBaseUnits;

  if (!/^\d+$/.test(requested) || BigInt(requested) <= 0n) {
    throw httpError(500, 'OUTBOUND_TARGET_AMOUNT_BASE_UNITS must be a positive integer string.');
  }

  if (BigInt(requested) > BigInt(maxAmountBaseUnits)) {
    throw httpError(402, `Outbound signer amount ${requested} exceeds cap ${maxAmountBaseUnits}.`);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function redactSignerUrl(url) {
  return `${url.origin}${url.pathname}`;
}

function makeOutboundIdempotencyKey(prefix = 'agent-intel-browserbase') {
  return `${prefix}-${Date.now()}`;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(trimmed)) {
    throw httpError(400, 'idempotency_key must contain only letters, numbers, dots, underscores, colons, or hyphens.');
  }
  return trimmed;
}

function redactBaseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin;
  } catch {
    return '';
  }
}

function isLocalhost(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function validateChallenge(challenge, config, maxAmountBaseUnits) {
  if (challenge.method !== 'tempo') {
    throw httpError(502, `Unexpected outbound payment method: ${challenge.method}`);
  }
  if (challenge.request.currency.toLowerCase() !== config.tempoCurrencyAddress.toLowerCase()) {
    throw httpError(502, `Unexpected outbound currency: ${challenge.request.currency}`);
  }
  if (!isEvmAddress(challenge.request.recipient)
    || addressEqual(challenge.request.recipient, '0x0000000000000000000000000000000000000000')) {
    throw httpError(502, `Unexpected outbound recipient: ${challenge.request.recipient}`);
  }
  if (!config.outboundSpendPolicy.allowDynamicMppRecipient
    && !addressEqual(challenge.request.recipient, config.outboundSpendPolicy.targetRecipient)) {
    throw httpError(502, `Unexpected outbound recipient: ${challenge.request.recipient}`);
  }
  if (BigInt(challenge.request.amount) > BigInt(maxAmountBaseUnits)) {
    throw httpError(402, `Outbound challenge amount ${challenge.request.amount} exceeds cap ${maxAmountBaseUnits}.`);
  }
  const chainId = Number(challenge.request.methodDetails?.chainId ?? 0);
  if (chainId !== config.tempoChainId) {
    throw httpError(502, `Unexpected outbound chain id: ${chainId}`);
  }
}

function addressEqual(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function isEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

async function readAccessState({ config, sdk, accessBundle }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const [balance, remaining] = await Promise.all([
    sdk.Actions.token.getBalance(readClient, {
      account: accessBundle.root_account_address,
      token: config.tempoCurrencyAddress,
    }),
    sdk.Actions.accessKey.getRemainingLimit(readClient, {
      account: accessBundle.root_account_address,
      accessKey: accessBundle.access_key_address,
      token: config.tempoCurrencyAddress,
    }),
  ]);

  return {
    balance: formatTokenAmount(balance, config.tempoTokenDecimals),
    remaining_limit: formatTokenAmount(remaining.remaining, config.tempoTokenDecimals),
  };
}

function isAllowedService(policy, service, hostname) {
  if (!policy.denyUnknownServices) {
    return true;
  }
  const allowed = new Set(policy.allowedServices.map((item) => item.toLowerCase()));
  return allowed.has(service.toLowerCase()) || allowed.has(hostname.toLowerCase());
}

function summarizeChallenge(challenge) {
  return {
    id: challenge.id,
    method: challenge.method,
    intent: challenge.intent,
    realm: challenge.realm,
    expires: challenge.expires,
    amount: challenge.request.amount,
    currency: challenge.request.currency,
    recipient: challenge.request.recipient,
    chain_id: challenge.request.methodDetails?.chainId ?? null,
  };
}

function decimalToBaseUnits(decimal, decimals) {
  if (!/^\d+(\.\d{1,6})?$/.test(decimal)) {
    throw httpError(500, `Invalid outbound decimal cap: ${decimal}`);
  }
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw httpError(500, `Outbound cap has more fractional digits than token decimals (${decimals}).`);
  }
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

function formatTokenAmount(raw, decimals = 6) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return {
    raw: value.toString(),
    formatted: fraction ? `${whole}.${fraction}` : `${whole}.00`,
  };
}

function decodeReceiptSummary(header) {
  try {
    const receipt = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    return {
      method: receipt.method ?? null,
      intent: receipt.intent ?? null,
      reference: receipt.reference ?? null,
      recipient: receipt.recipient ?? null,
      amount: receipt.amount ?? null,
      currency: receipt.currency ?? null,
      chain_id: receipt.methodDetails?.chainId ?? null,
    };
  } catch {
    return { decoded: false };
  }
}

function previewJsonOrText(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return {
        type: 'array',
        length: parsed.length,
        first_item: parsed[0] ?? null,
      };
    }
    return {
      type: 'object',
      keys: Object.keys(parsed).slice(0, 20),
      sample: parsed,
    };
  } catch {
    return {
      type: 'text',
      preview: text.slice(0, 500),
    };
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
