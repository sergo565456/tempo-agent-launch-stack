import { URL } from 'node:url';
import { evaluatePolicy } from './policy.js';
import { readJsonBody, sendJson } from './utils/http.js';
import { hashJson } from './utils/hash.js';
import { utcDay } from './ledger.js';

export function createApp({ config, ledger, provider }) {
  const adminRateLimiter = createFixedWindowRateLimiter(config.adminRateLimit);

  return async function app(req, res) {
    try {
      const url = new URL(req.url, config.publicBaseUrl);

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          status: 'ok',
          service: config.serviceName,
          provider: config.provider,
          agent_count: config.agentWallets.length,
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1/readiness') {
        return sendJson(res, 200, buildReadiness(config));
      }

      if (req.method === 'GET' && url.pathname === '/v1/agents') {
        const rateLimitError = getAdminRateLimitError(req, adminRateLimiter);
        if (rateLimitError) {
          return sendJson(res, rateLimitError.statusCode, rateLimitError.body, rateLimitError.headers);
        }

        const authError = getAdminAuthError(req, config);
        if (authError) {
          return sendJson(res, authError.statusCode, authError.body);
        }

        return sendJson(res, 200, {
          agents: config.agentWallets.map(publicAgentPolicy),
        });
      }

      const ledgerMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/ledger\/([^/]+)$/);
      if (req.method === 'GET' && ledgerMatch) {
        const rateLimitError = getAdminRateLimitError(req, adminRateLimiter);
        if (rateLimitError) {
          return sendJson(res, rateLimitError.statusCode, rateLimitError.body, rateLimitError.headers);
        }

        return await handleLedgerLookup(req, res, {
          config,
          ledger,
          agentId: decodeURIComponent(ledgerMatch[1]),
          idempotencyKey: decodeURIComponent(ledgerMatch[2]),
        });
      }

      const paymentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/payments\/mpp$/);
      if (req.method === 'POST' && paymentMatch) {
        const rateLimitError = getAdminRateLimitError(req, adminRateLimiter);
        if (rateLimitError) {
          return sendJson(res, rateLimitError.statusCode, rateLimitError.body, rateLimitError.headers);
        }

        return await handlePolicyActionRequest(req, res, {
          agentId: paymentMatch[1],
          config,
          ledger,
          provider,
          requiredConfirm: 'sign-one-payment',
          operation: 'direct_payment',
          execute: (approval) => provider.signPayment(approval),
          resultKey: 'signer_result',
        });
      }

      const fetchMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/mpp\/fetch$/);
      if (req.method === 'POST' && fetchMatch) {
        const rateLimitError = getAdminRateLimitError(req, adminRateLimiter);
        if (rateLimitError) {
          return sendJson(res, rateLimitError.statusCode, rateLimitError.body, rateLimitError.headers);
        }

        return await handlePolicyActionRequest(req, res, {
          agentId: fetchMatch[1],
          config,
          ledger,
          provider,
          requiredConfirm: 'fetch-one-mpp-endpoint',
          operation: 'mpp_fetch',
          execute: (approval) => provider.fetchMpp(approval),
          resultKey: 'fetch_result',
        });
      }

      return sendJson(res, 404, {
        error: 'not_found',
        message: 'Route not found',
      });
    } catch (error) {
      return sendJson(res, error.statusCode || 500, {
        error: error.statusCode ? 'request_error' : 'internal_error',
        message: error.message,
      });
    }
  };
}

function createFixedWindowRateLimiter(options = {}) {
  const enabled = options.enabled === true;
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : 60;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 60_000;
  const buckets = new Map();

  return {
    check(req, now = Date.now()) {
      if (!enabled) {
        return { ok: true, enabled: false };
      }

      const key = getRateLimitKey(req, options);
      const current = buckets.get(key);
      if (!current || now >= current.resetAt) {
        buckets.set(key, {
          count: 1,
          resetAt: now + windowMs,
        });
        cleanupExpiredBuckets(buckets, now);
        return { ok: true, enabled: true, remaining: max - 1 };
      }

      if (current.count >= max) {
        return {
          ok: false,
          enabled: true,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
        };
      }

      current.count += 1;
      return {
        ok: true,
        enabled: true,
        remaining: max - current.count,
      };
    },
  };
}

function getAdminRateLimitError(req, adminRateLimiter) {
  const decision = adminRateLimiter.check(req);
  if (decision.ok) {
    return null;
  }

  return {
    statusCode: 429,
    headers: {
      'retry-after': String(decision.retryAfterSeconds),
    },
    body: {
      error: 'rate_limited',
      message: 'Too many signer admin requests from this client. Retry after the indicated window.',
      retry_after_seconds: decision.retryAfterSeconds,
    },
  };
}

function getRateLimitKey(req, options) {
  if (options.trustProxyHeaders) {
    const forwardedFor = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwardedFor) {
      return `xff:${forwardedFor}`;
    }

    const realIp = String(req.headers['x-real-ip'] || '').trim();
    if (realIp) {
      return `xreal:${realIp}`;
    }
  }

  return `socket:${req.socket?.remoteAddress || 'unknown'}`;
}

function cleanupExpiredBuckets(buckets, now) {
  if (buckets.size < 1_000) {
    return;
  }

  for (const [key, bucket] of buckets.entries()) {
    if (now >= bucket.resetAt) {
      buckets.delete(key);
    }
  }
}

async function handleLedgerLookup(req, res, {
  config,
  ledger,
  agentId,
  idempotencyKey,
}) {
  const authError = getAdminAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  const record = await ledger.findByIdempotencyKey(agentId, idempotencyKey);
  if (!record) {
    return sendJson(res, 404, {
      ok: false,
      error: 'ledger_record_not_found',
      message: 'No signer ledger record exists for this agent and idempotency key.',
      agent_id: agentId,
      idempotency_key: idempotencyKey,
    });
  }

  return sendJson(res, 200, {
    ok: true,
    record: publicLedgerRecord(record),
  });
}

async function handlePolicyActionRequest(req, res, {
  agentId,
  config,
  ledger,
  requiredConfirm,
  operation,
  execute,
  resultKey,
}) {
  const authError = getAdminAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  const body = await readJsonBody(req);
  const requestHash = hashJson(body);
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  if (idempotencyKey) {
    const existing = await ledger.findByIdempotencyKey(agentId, idempotencyKey);
    if (existing) {
      return sendExistingLedgerRecord(res, existing, requestHash);
    }
  }

  const day = utcDay();
  const spentTodayBaseUnits = await ledger.sumAgentDay(agentId, day);
  const policyDecision = evaluatePolicy({
    config,
    agentId,
    request: body,
    spentTodayBaseUnits,
    requiredConfirm,
    operation,
  });

  if (!policyDecision.ok) {
    const response = {
      ok: false,
      error: policyDecision.error,
      message: policyDecision.message,
    };

    await ledger.insert({
      day,
      status: 'denied',
      agent_id: agentId,
      idempotency_key: idempotencyKey || null,
      request_hash: requestHash,
      status_code: 403,
      error: policyDecision.error,
      message: policyDecision.message,
      response,
      created_at: new Date().toISOString(),
    });

    return sendJson(res, 403, response);
  }

  const pendingResponse = {
    ok: false,
    error: 'payment_in_progress',
    message: 'A signer action with this idempotency key is already in progress.',
  };
  const reservation = await ledger.reserve({
    day,
    status: 'pending',
    agent_id: agentId,
    idempotency_key: policyDecision.approval.idempotency_key,
    request_hash: requestHash,
    status_code: 409,
    amount_base_units: policyDecision.approval.amount_base_units,
    response: pendingResponse,
    created_at: new Date().toISOString(),
  }, {
    dailyLimitBaseUnits: policyDecision.approval.policy.daily_limit_base_units,
  });

  if (!reservation.ok) {
    if (reservation.reason === 'daily_limit_exceeded') {
      return sendJson(res, 403, {
        ok: false,
        error: 'daily_limit_exceeded',
        message: 'Amount would exceed daily policy limit.',
        spent_today_base_units: reservation.spent_today_base_units,
      });
    }

    return sendExistingLedgerRecord(res, reservation.record, requestHash);
  }

  let actionResult;
  try {
    actionResult = await execute(policyDecision.approval);
  } catch (error) {
    const providerError = config.exposeProviderErrorDetails ? sanitizeProviderError(error) : null;
    const providerContext = sanitizeProviderContext(error?.providerContext);
    const paidOnchain = providerContext?.onchain_recovery?.paid_onchain === true;
    const response = {
      ok: false,
      error: paidOnchain ? 'provider_paid_onchain_response_failed' : 'provider_execution_failed',
      message: paidOnchain
        ? 'Signer verified the payment on-chain, but the downstream MPP service did not return a confirmed usable response.'
        : 'Signer provider failed before returning a confirmed result.',
      ...(providerContext ? { provider_context: providerContext } : {}),
      ...(providerError ? { provider_error: providerError } : {}),
    };

    await ledger.finalize(agentId, policyDecision.approval.idempotency_key, requestHash, {
      status: 'failed',
      status_code: 502,
      error: response.error,
      message: response.message,
      response,
    });

    return sendJson(res, 502, response);
  }

  const response = {
    ok: true,
    approval: policyDecision.approval,
    [resultKey]: actionResult,
  };

  await ledger.finalize(agentId, policyDecision.approval.idempotency_key, requestHash, {
    status: 'approved',
    status_code: 200,
    response,
  });

  return sendJson(res, 200, response);
}

function sanitizeProviderError(error) {
  return {
    name: sanitizeDiagnosticText(error?.name || null),
    code: sanitizeDiagnosticText(error?.code || null),
    short_message: sanitizeDiagnosticText(error?.shortMessage || null),
    message: sanitizeDiagnosticText(error?.message || null),
    activity_id: sanitizeDiagnosticText(error?.activityId || null),
    activity_status: sanitizeDiagnosticText(error?.activityStatus || null),
    activity_type: sanitizeDiagnosticText(error?.activityType || null),
    status_code: Number.isInteger(error?.statusCode) ? error.statusCode : null,
  };
}

function sanitizeProviderContext(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return JSON.parse(JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') {
      return current.toString();
    }
    if (typeof current === 'string') {
      return sanitizeDiagnosticText(current);
    }
    return current;
  }));
}

function sanitizeDiagnosticText(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value)
    .replace(/0x[a-fA-F0-9]{64,}/g, '[redacted_hex]')
    .replace(/\b[A-Za-z0-9+/=_-]{80,}\b/g, '[redacted_long_token]')
    .slice(0, 500);
}

function sendExistingLedgerRecord(res, existing, requestHash) {
  if (existing.request_hash !== requestHash) {
    return sendJson(res, 409, {
      error: 'idempotency_conflict',
      message: 'Idempotency key was already used with a different request body.',
    });
  }

  if (existing.status === 'pending') {
    return sendJson(res, 409, existing.response, {
      'x-signer-cache': 'pending-reservation',
    });
  }

  return sendJson(res, existing.status_code || 200, existing.response, {
    'x-signer-cache': 'idempotent-replay',
  });
}

function publicLedgerRecord(record) {
  return {
    day: record.day,
    status: record.status,
    agent_id: record.agent_id,
    idempotency_key: record.idempotency_key,
    status_code: record.status_code,
    amount_base_units: record.amount_base_units ?? null,
    error: record.error ?? null,
    message: record.message ?? null,
    created_at: record.created_at,
    response: record.response,
  };
}

function getAdminAuthError(req, config) {
  if (!config.signerAdminToken) {
    return {
      statusCode: 503,
      body: {
        error: 'signer_admin_not_configured',
        message: 'SIGNER_ADMIN_TOKEN must be configured before admin routes are enabled.',
      },
    };
  }

  if ((req.headers.authorization || '') !== `Bearer ${config.signerAdminToken}`) {
    return {
      statusCode: 401,
      body: {
        error: 'unauthorized',
        message: 'Valid signer bearer token is required.',
      },
    };
  }

  return null;
}

function buildReadiness(config) {
  return {
    ok: config.provider === 'mock' || (
      config.provider === 'turnkey'
      && Boolean(config.turnkey.organizationId)
      && Boolean(config.turnkey.apiPublicKey)
      && config.turnkey.apiPrivateKeyConfigured
      && Boolean(config.turnkey.policyId)
      && config.turnkey.signWithMode === 'wallet'
      && !config.turnkey.sponsorWith
    ),
    provider: config.provider,
    admin_token_configured: Boolean(config.signerAdminToken),
    agent_count: config.agentWallets.length,
    tempo: {
      chain_id: config.tempoChainId,
      rpc_configured: Boolean(config.tempoRpcUrl),
      currency: config.tempoUsdcAddress,
      token_decimals: config.tempoTokenDecimals,
    },
    turnkey: {
      organization_configured: Boolean(config.turnkey.organizationId),
      api_public_key_configured: Boolean(config.turnkey.apiPublicKey),
      api_private_key_configured: config.turnkey.apiPrivateKeyConfigured,
      policy_configured: Boolean(config.turnkey.policyId),
      sign_with_configured: Boolean(config.turnkey.signWith),
      sign_with_mode: config.turnkey.signWithMode,
    },
    ledger: {
      backend: config.ledgerBackend,
      durable_configured: config.ledgerBackend === 'upstash_redis'
        && Boolean(config.upstashRedis.restUrl)
        && config.upstashRedis.restTokenConfigured,
    },
    admin_rate_limit: {
      enabled: config.adminRateLimit.enabled,
      max: config.adminRateLimit.max,
      window_ms: config.adminRateLimit.windowMs,
    },
  };
}

function publicAgentPolicy(agent) {
  return {
    agent_id: agent.agent_id,
    wallet_address: agent.wallet_address,
    tempo_access_key_address: agent.tempo_access_key_address,
    turnkey_sign_with_configured: Boolean(agent.turnkey_sign_with),
    enabled: agent.enabled,
    per_call_limit_base_units: agent.per_call_limit_base_units,
    daily_limit_base_units: agent.daily_limit_base_units,
    allowed_services: agent.allowed_services,
    allowed_endpoints: agent.allowed_endpoints,
    allowed_recipients: agent.allowed_recipients,
    allowed_commands: agent.allowed_commands,
    allowed_browserbase_fetch_urls: agent.allowed_browserbase_fetch_urls || [],
    allow_dynamic_mpp_recipient: agent.allow_dynamic_mpp_recipient === true,
  };
}
