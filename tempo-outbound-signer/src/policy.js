export function evaluatePolicy({
  config,
  agentId,
  request,
  spentTodayBaseUnits = '0',
  requiredConfirm = 'sign-one-payment',
  operation = 'direct_payment',
}) {
  const agent = config.agentWallets.find((item) => item.agent_id === agentId);
  if (!agent) {
    return deny('unknown_agent', `No wallet policy exists for agent ${agentId}.`);
  }

  if (!agent.enabled) {
    return deny('agent_disabled', `Agent ${agentId} is disabled.`);
  }

  const normalized = normalizePaymentRequest(request);
  if (!normalized.ok) {
    return deny('invalid_request', normalized.error);
  }

  const payment = normalized.value;
  if (payment.confirm !== requiredConfirm) {
    return deny('confirmation_required', `Request must include confirm=${requiredConfirm}.`);
  }

  if (!agent.allowed_commands.includes(payment.command)) {
    return deny('command_not_allowed', `Command ${payment.command} is not allowed for ${agentId}.`);
  }

  if (!agent.allowed_services.includes(payment.service)) {
    return deny('service_not_allowed', `Service ${payment.service} is not allowed for ${agentId}.`);
  }

  const endpoint = new URL(payment.endpoint);
  if (endpoint.protocol !== 'https:') {
    return deny('https_required', 'Outbound service endpoint must use HTTPS.');
  }

  if (endpoint.hostname.toLowerCase() !== payment.service.toLowerCase()) {
    return deny('service_endpoint_mismatch', 'Service name must match endpoint hostname.');
  }

  if (!agent.allowed_endpoints.includes(endpoint.href)) {
    return deny('endpoint_not_allowed', 'Endpoint is not on the agent allowlist.');
  }

  const allowDynamicMppRecipient = operation === 'mpp_fetch'
    && agent.allow_dynamic_mpp_recipient === true;

  if (!allowDynamicMppRecipient && !addressEqual(payment.recipient, agent.allowed_recipients)) {
    return deny('recipient_not_allowed', 'Recipient is not on the agent allowlist.');
  }

  if (payment.currency.toLowerCase() !== config.tempoUsdcAddress.toLowerCase()) {
    return deny('currency_not_allowed', 'Currency must match configured Tempo USDC.e.');
  }

  if (payment.chain_id !== config.tempoChainId) {
    return deny('chain_not_allowed', 'Chain id must match configured Tempo chain.');
  }

  if (payment.command === 'fetch_browserbase_page') {
    const fetchUrlDecision = validateBrowserbaseFetchUrl(payment.browserbase_fetch_url, agent);
    if (!fetchUrlDecision.ok) {
      return deny(fetchUrlDecision.error, fetchUrlDecision.message);
    }
  }

  if (BigInt(payment.amount_base_units) > BigInt(agent.per_call_limit_base_units)) {
    return deny('per_call_limit_exceeded', 'Amount exceeds per-call policy limit.');
  }

  const spentToday = BigInt(spentTodayBaseUnits);
  const amount = BigInt(payment.amount_base_units);
  const dailyLimit = BigInt(agent.daily_limit_base_units);
  if (spentToday + amount > dailyLimit) {
    return deny('daily_limit_exceeded', 'Amount would exceed daily policy limit.');
  }

  return {
    ok: true,
    approval: {
      approval_id: `appr_${Date.now().toString(36)}_${payment.idempotency_key.slice(0, 18)}`,
      agent_id: agent.agent_id,
      payer_wallet: agent.wallet_address,
      tempo_access_key_address: agent.tempo_access_key_address,
      turnkey_sign_with: agent.turnkey_sign_with || agent.wallet_address,
      command: payment.command,
      service: payment.service,
      endpoint: payment.endpoint,
      recipient: payment.recipient,
      requested_recipient: payment.recipient,
      allow_dynamic_mpp_recipient: allowDynamicMppRecipient,
      currency: payment.currency,
      chain_id: payment.chain_id,
      amount_base_units: payment.amount_base_units,
      browserbase_fetch_url: payment.browserbase_fetch_url || null,
      idempotency_key: payment.idempotency_key,
      operation,
      policy: {
        provider: config.provider,
        per_call_limit_base_units: agent.per_call_limit_base_units,
        daily_limit_base_units: agent.daily_limit_base_units,
        spent_today_before_base_units: spentToday.toString(),
        spent_today_after_base_units: (spentToday + amount).toString(),
      },
      approved_at: new Date().toISOString(),
    },
  };
}

function normalizePaymentRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('Request body must be a JSON object.');
  }

  const value = {
    confirm: normalizeString(input.confirm),
    idempotency_key: normalizeString(input.idempotency_key),
    command: normalizeString(input.command),
    service: normalizeString(input.service).toLowerCase(),
    endpoint: normalizeString(input.endpoint),
    recipient: normalizeString(input.recipient),
    currency: normalizeString(input.currency),
    chain_id: Number(input.chain_id),
    amount_base_units: String(input.amount_base_units || ''),
    browserbase_fetch_url: normalizeString(input.browserbase_fetch_url),
  };

  if (!/^[a-z0-9][a-z0-9:_-]{2,120}$/.test(value.idempotency_key)) {
    return invalid('idempotency_key is required and must be stable.');
  }
  if (!value.command) {
    return invalid('command is required.');
  }
  if (!/^[a-z0-9.-]+$/.test(value.service)) {
    return invalid('service must be a hostname-like value.');
  }
  try {
    new URL(value.endpoint);
  } catch {
    return invalid('endpoint must be a valid URL.');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(value.recipient)) {
    return invalid('recipient must be an EVM address.');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(value.currency)) {
    return invalid('currency must be an EVM token address.');
  }
  if (!Number.isInteger(value.chain_id) || value.chain_id <= 0) {
    return invalid('chain_id must be a positive integer.');
  }
  if (!/^\d+$/.test(value.amount_base_units) || BigInt(value.amount_base_units) <= 0n) {
    return invalid('amount_base_units must be a positive integer string.');
  }

  return { ok: true, value };
}

function validateBrowserbaseFetchUrl(value, agent) {
  if (!value) {
    return {
      ok: false,
      error: 'browserbase_fetch_url_required',
      message: 'browserbase_fetch_url is required for fetch_browserbase_page.',
    };
  }

  let normalized;
  try {
    normalized = new URL(value).href;
  } catch {
    return {
      ok: false,
      error: 'browserbase_fetch_url_invalid',
      message: 'browserbase_fetch_url must be a valid HTTPS URL.',
    };
  }

  if (!normalized.startsWith('https://')) {
    return {
      ok: false,
      error: 'browserbase_fetch_url_https_required',
      message: 'browserbase_fetch_url must use HTTPS.',
    };
  }

  const allowed = new Set((agent.allowed_browserbase_fetch_urls || []).map((item) => item.toLowerCase()));
  if (!allowed.has(normalized.toLowerCase())) {
    return {
      ok: false,
      error: 'browserbase_fetch_url_not_allowed',
      message: 'browserbase_fetch_url is not on the agent allowlist.',
    };
  }

  return { ok: true };
}

function deny(code, message) {
  return {
    ok: false,
    error: code,
    message,
  };
}

function invalid(error) {
  return { ok: false, error };
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function addressEqual(address, list) {
  return list.some((item) => item.toLowerCase() === address.toLowerCase());
}
