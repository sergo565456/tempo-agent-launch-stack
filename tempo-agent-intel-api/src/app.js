import { URL } from 'node:url';
import { generateAnalyzeReport } from './report/engine.js';
import { validateAnalyzeRequest } from './schemas/analyze.js';
import { createPaymentGateway } from './payments/adapters.js';
import { buildOpenApi } from './openapi.js';
import { buildAgentCard, buildLlmsText, buildX402Discovery } from './discovery.js';
import { buildOutboundSpendPlan } from './outbound/spendPolicy.js';
import { buildBrowserbaseFetchOutboundPreview, buildOutboundReadiness, runBrowserbaseFetchOutbound } from './outbound/tempoMppOutbound.js';
import { buildTempoRuntimeReadiness } from './runtime/accessKeyReadiness.js';
import { buildRootServiceIndex, buildRootServicePage } from './rootPage.js';
import { readJsonBody, sendHead, sendHtml, sendJson, sendText } from './utils/http.js';
import { hashJson } from './utils/id.js';

const REPORT_ROUTES = new Map([
  ['/v1/analyze', null],
  ['/v1/launch-readiness', 'launch_readiness_report'],
  ['/v1/service-diligence', 'service_diligence_report'],
  ['/v1/ecosystem-fit', 'ecosystem_fit_report'],
]);

export function createApp({ config, store, paymentLedger = null }) {
  const paymentGateway = createPaymentGateway(config);
  const reportRateLimiter = createFixedWindowRateLimiter(config.reportRateLimit);

  return async function app(req, res) {
    try {
      const url = new URL(req.url, config.publicBaseUrl);

      if (req.method === 'HEAD') {
        const contentType = getPublicHeadContentType(url.pathname, req);
        if (contentType) {
          return sendHead(res, 200, contentType);
        }
      }

      if (req.method === 'GET' && url.pathname === '/') {
        if (acceptsJson(req)) {
          return sendJson(res, 200, buildRootServiceIndex(config));
        }
        return sendHtml(res, 200, buildRootServicePage(config));
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          status: 'ok',
          service: config.serviceName,
          name: 'Agent Launch Intel API',
          payment_mode: config.paymentMode,
          payment_rails: config.enabledPaymentRails,
          outbound_live_payments: config.outboundSpendPolicy.livePaymentsEnabled,
          storage: {
            backend: config.storageBackend,
            durable_configured: config.storageBackend === 'upstash_redis'
              && Boolean(config.upstashRedis.restUrl)
              && config.upstashRedis.restTokenConfigured,
          },
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1/runtime/tempo-readiness') {
        const readiness = await buildTempoRuntimeReadiness(config, {
          requireAccessKey: config.outboundSpendPolicy.livePaymentsEnabled
            && config.outboundSpendPolicy.paymentProvider === 'local_access_key',
        });
        return sendJson(res, 200, config.exposeRuntimeReadinessDetails
          ? readiness
          : summarizeTempoRuntimeReadiness(readiness));
      }

      if (req.method === 'GET' && url.pathname === '/openapi.json') {
        return sendJson(res, 200, buildOpenApi(config));
      }

      if (req.method === 'GET' && url.pathname === '/llms.txt') {
        return sendText(res, 200, buildLlmsText(config));
      }

      if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
        return sendJson(res, 200, buildAgentCard(config));
      }

      if (req.method === 'GET' && url.pathname === '/.well-known/x402') {
        return sendJson(res, 200, buildX402Discovery(config));
      }

      if (req.method === 'POST' && REPORT_ROUTES.has(url.pathname)) {
        const rateLimitDecision = reportRateLimiter.check(req);
        if (!rateLimitDecision.ok) {
          return sendJson(res, 429, {
            error: 'rate_limited',
            message: 'Too many paid report requests from this client. Retry after the indicated window.',
            retry_after_seconds: rateLimitDecision.retryAfterSeconds,
          }, {
            'retry-after': String(rateLimitDecision.retryAfterSeconds),
          });
        }
        return await handleCreateReport(req, res, config, store, paymentGateway, paymentLedger, REPORT_ROUTES.get(url.pathname));
      }

      if (req.method === 'POST' && url.pathname === '/v1/admin/outbound/browserbase-fetch') {
        return await handleAdminBrowserbaseOutbound(req, res, config, paymentLedger);
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/outbound/browserbase-fetch/preview') {
        return await handleAdminBrowserbaseOutboundPreview(req, res, config, url);
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/outbound/readiness') {
        return await handleAdminOutboundReadiness(req, res, config);
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/outbound/cron/readiness') {
        return await handleAdminOutboundCronReadiness(req, res, config, paymentLedger);
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/payment-events') {
        return await handleAdminPaymentEvents(req, res, config, paymentLedger, url);
      }

      if (req.method === 'GET' && url.pathname === '/api/cron/outbound/browserbase-fetch') {
        return await handleCronBrowserbaseOutbound(req, res, config, paymentLedger);
      }

      const reportMatch = url.pathname.match(/^\/v1\/reports\/([^/]+)$/);
      if (req.method === 'GET' && reportMatch) {
        return await handleGetReport(req, res, config, store, reportMatch[1], url);
      }

      return sendJson(res, 404, {
        error: 'not_found',
        message: 'Route not found',
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return sendJson(res, statusCode, {
        error: statusCode === 500 ? 'internal_error' : 'request_error',
        message: error.message,
      });
    }
  };
}

function createFixedWindowRateLimiter(options = {}) {
  const enabled = options.enabled === true;
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : 30;
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

function acceptsJson(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/html');
}

function getPublicHeadContentType(pathname, req) {
  if (pathname === '/') {
    return acceptsJson(req)
      ? 'application/json; charset=utf-8'
      : 'text/html; charset=utf-8';
  }

  if (pathname === '/health' || pathname === '/openapi.json') {
    return 'application/json; charset=utf-8';
  }

  if (pathname === '/llms.txt') {
    return 'text/plain; charset=utf-8';
  }

  if (pathname === '/.well-known/agent-card.json' || pathname === '/.well-known/x402') {
    return 'application/json; charset=utf-8';
  }

  return null;
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

async function handleCreateReport(req, res, config, store, paymentGateway, paymentLedger, forcedReportType) {
  const idempotencyKey = req.headers['idempotency-key'] || null;

  if (shouldIssuePreValidationPaymentChallenge(req, config)) {
    const probeRequest = buildPaymentProbeReportRequest(forcedReportType);
    const paymentDecision = await paymentGateway.evaluate(req, probeRequest);
    if (!paymentDecision.ok) {
      await recordPaymentEvent(paymentLedger, {
        type: paymentDecision.statusCode === 402 ? 'challenge_created' : 'live_payment_blocked',
        idempotency_key: idempotencyKey,
        request_hash: hashJson(probeRequest),
        report_type: probeRequest.report_type,
        payment_mode: config.paymentMode,
        status_code: paymentDecision.statusCode,
        error: paymentDecision.body?.error || null,
        discovery_probe: true,
        remote_addr: req.socket?.remoteAddress || null,
      });

      return sendJson(
        res,
        paymentDecision.statusCode,
        paymentDecision.body,
        paymentDecision.headers || {},
      );
    }
  }

  const body = await readJsonBody(req);
  const validation = validateAnalyzeRequest(body, { reportType: forcedReportType });

  if (!validation.ok) {
    return sendJson(res, 400, {
      error: 'invalid_request',
      details: validation.errors,
    });
  }

  const analyzeRequest = validation.value;
  const requestHash = hashJson(analyzeRequest);

  if (config.requireIdempotencyKeyForPaid && !idempotencyKey) {
    return sendJson(res, 400, {
      error: 'idempotency_key_required',
      message: 'Idempotency-Key header is required for live paid report routes.',
    });
  }

  const existing = await store.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    return sendExistingReportRecord(res, existing, requestHash);
  }

  const paymentDecision = await paymentGateway.evaluate(req, analyzeRequest);
  if (!paymentDecision.ok) {
    await recordPaymentEvent(paymentLedger, {
      type: paymentDecision.statusCode === 402 ? 'challenge_created' : 'live_payment_blocked',
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      report_type: analyzeRequest.report_type,
      payment_mode: config.paymentMode,
      status_code: paymentDecision.statusCode,
      error: paymentDecision.body?.error || null,
      remote_addr: req.socket?.remoteAddress || null,
    });

    return sendJson(
      res,
      paymentDecision.statusCode,
      paymentDecision.body,
      paymentDecision.headers || {},
    );
  }

  const reservation = await store.reserveIdempotency(idempotencyKey, requestHash, {
    report_type: analyzeRequest.report_type,
    payment_mode: paymentDecision.payment.mode,
    payment_method: paymentDecision.payment.method,
    payment_status: paymentDecision.payment.status,
    receipt_id: paymentDecision.payment.receipt_id,
  });
  if (!reservation.ok) {
    return sendExistingReportRecord(res, reservation.record, requestHash);
  }

  const outboundPlan = buildOutboundSpendPlan(config, analyzeRequest);
  const report = generateAnalyzeReport(analyzeRequest, paymentDecision.payment, { outboundPlan });
  const reportRecord = {
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    report,
    metadata: {
      created_at: report.generated_at,
      report_type: report.report_type,
      payment_mode: paymentDecision.payment.mode,
      payment_method: paymentDecision.payment.method,
      payment_status: paymentDecision.payment.status,
      receipt_id: paymentDecision.payment.receipt_id,
      remote_addr: req.socket?.remoteAddress || null,
    },
  };

  if (idempotencyKey) {
    await store.finalizeIdempotency(idempotencyKey, requestHash, reportRecord);
  } else {
    await store.insert(reportRecord);
  }

  await recordPaymentEvent(paymentLedger, {
    type: 'payment_verified',
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    report_id: report.report_id,
    report_type: report.report_type,
    payment_mode: paymentDecision.payment.mode,
    payment_method: paymentDecision.payment.method,
    payment_status: paymentDecision.payment.status,
    receipt_id: paymentDecision.payment.receipt_id,
    remote_addr: req.socket?.remoteAddress || null,
  });

  return sendJson(res, 200, report, {
    'payment-receipt': paymentDecision.payment.receipt_id || '',
  });
}

export function shouldIssuePreValidationPaymentChallenge(req, config) {
  return config.tempoMppLiveEnabled === true
    && paymentModeIncludesTempo(config)
    && !hasInboundPaymentCredential(req);
}

function paymentModeIncludesTempo(config) {
  if (config.paymentMode === 'tempo') {
    return true;
  }

  return config.paymentMode === 'multi' && config.enabledPaymentRails.includes('tempo');
}

function hasInboundPaymentCredential(req) {
  const authorization = req.headers.authorization || '';
  return /^Payment\s+/i.test(authorization);
}

function buildPaymentProbeReportRequest(forcedReportType) {
  return {
    target: 'discovery-probe',
    question: 'Return the payment challenge for machine-readable service discovery.',
    depth: 'quick',
    report_type: forcedReportType || 'opportunity_report',
    output_format: 'json',
    constraints: {},
  };
}

function sendExistingReportRecord(res, existing, requestHash) {
  if (existing.request_hash !== requestHash) {
    return sendJson(res, 409, {
      error: 'idempotency_conflict',
      message: 'Idempotency-Key was already used with a different request body.',
    });
  }

  if (existing.status === 'pending' || !existing.report) {
    return sendJson(res, 409, {
      error: 'report_in_progress',
      message: 'A report with this Idempotency-Key is already being generated.',
    }, {
      'x-report-cache': 'pending-reservation',
    });
  }

  return sendJson(res, 200, existing.report, {
    'x-report-cache': 'idempotent-replay',
  });
}

async function recordPaymentEvent(paymentLedger, event) {
  if (!paymentLedger) {
    return null;
  }

  return paymentLedger.insert(event);
}

async function handleGetReport(req, res, config, store, reportId, url) {
  const record = await store.findById(reportId);
  if (!record) {
    return sendJson(res, 404, {
      error: 'report_not_found',
      message: 'No report exists for the provided id.',
    });
  }

  if (config.requireReportAccessProof && !hasReportAccessProof(req, url, record)) {
    return sendJson(res, 401, {
      error: 'report_access_proof_required',
      message: 'Provide the matching Idempotency-Key header or receipt_id query/header to retrieve this paid report.',
    });
  }

  return sendJson(res, 200, {
    report: record.report,
    metadata: {
      created_at: record.metadata.created_at,
      payment_mode: record.metadata.payment_mode,
      payment_method: record.metadata.payment_method,
      payment_status: record.metadata.payment_status,
      receipt_id: record.metadata.receipt_id,
    },
  });
}

function hasReportAccessProof(req, url, record) {
  const suppliedIdempotencyKey = normalizeProofValue(
    req.headers['idempotency-key'] || url.searchParams.get('idempotency_key'),
  );
  const suppliedReceiptId = normalizeProofValue(
    req.headers['x-report-receipt-id']
      || req.headers['payment-receipt']
      || url.searchParams.get('receipt_id'),
  );

  const expectedIdempotencyKey = normalizeProofValue(record.idempotency_key);
  if (expectedIdempotencyKey && suppliedIdempotencyKey === expectedIdempotencyKey) {
    return true;
  }

  const expectedReceiptId = normalizeProofValue(record.metadata?.receipt_id);
  return Boolean(expectedReceiptId && suppliedReceiptId === expectedReceiptId);
}

function normalizeProofValue(value) {
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

async function handleAdminBrowserbaseOutbound(req, res, config, paymentLedger) {
  const authError = getOutboundAdminAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  const body = await readJsonBody(req);
  if (body.confirm !== 'run-one-outbound-payment') {
    return sendJson(res, 400, {
      error: 'confirmation_required',
      message: 'Set confirm to run-one-outbound-payment to trigger exactly one outbound MPP payment attempt.',
    });
  }

  const idempotencyKey = body.idempotency_key;
  try {
    const result = await runBrowserbaseFetchOutbound(config, {
      idempotencyKey,
    });
    const ledgerEvent = await recordPaymentEvent(paymentLedger, {
      type: 'outbound_admin_payment_succeeded',
      trigger: 'admin_manual',
      idempotency_key: idempotencyKey || null,
      payment_provider: result.provider,
      signer_agent_id: result.signer_agent_id,
      signer_command: result.signer_command,
      service: result.service,
      endpoint: result.endpoint,
      amount_base_units: result.requested_amount_base_units,
      receipt_reference: result.signer_response?.fetch_result?.receipt?.reference || null,
      remote_addr: req.socket?.remoteAddress || null,
    });

    return sendJson(res, 200, {
      ...result,
      ledger_event_id: ledgerEvent?.event_id ?? null,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const ledgerEvent = await recordPaymentEvent(paymentLedger, {
      type: 'outbound_admin_payment_failed',
      trigger: 'admin_manual',
      idempotency_key: idempotencyKey || null,
      status_code: statusCode,
      error: error.message,
      remote_addr: req.socket?.remoteAddress || null,
    });

    return sendJson(res, statusCode, {
      error: statusCode === 500 ? 'internal_error' : 'outbound_admin_payment_failed',
      message: error.message,
      idempotency_key: idempotencyKey || null,
      ledger_event_id: ledgerEvent?.event_id ?? null,
    });
  }
}

async function handleAdminBrowserbaseOutboundPreview(req, res, config, url) {
  const authError = getOutboundAdminAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  return sendJson(res, 200, buildBrowserbaseFetchOutboundPreview(config, {
    idempotencyKey: url.searchParams.get('idempotency_key') || '',
  }));
}

async function handleAdminOutboundReadiness(req, res, config) {
  const authError = getOutboundAdminAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  return sendJson(res, 200, await buildOutboundReadiness(config));
}

async function handleAdminOutboundCronReadiness(req, res, config, paymentLedger) {
  const authError = getOutboundAdminAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  return sendJson(res, 200, await buildOutboundCronReadiness(config, paymentLedger));
}

async function handleAdminPaymentEvents(req, res, config, paymentLedger, url) {
  const authError = getOutboundAdminAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  if (!paymentLedger) {
    return sendJson(res, 503, {
      error: 'payment_ledger_not_configured',
      message: 'Payment ledger is not configured for this runtime.',
    });
  }

  const limit = parseListLimit(url.searchParams.get('limit'), 50, 2000);
  const events = await paymentLedger.list();
  return sendJson(res, 200, {
    ok: true,
    read_only: true,
    limit,
    total_events: events.length,
    events: events.slice(-limit).reverse(),
  });
}

function parseListLimit(value, fallback, max) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

async function handleCronBrowserbaseOutbound(req, res, config, paymentLedger) {
  const authError = getOutboundCronAuthError(req, config);
  if (authError) {
    return sendJson(res, authError.statusCode, authError.body);
  }

  const armingError = await getOutboundCronArmingError(config, paymentLedger);
  if (armingError) {
    return sendJson(res, armingError.statusCode, armingError.body);
  }

  const idempotencyKey = buildCronOutboundIdempotencyKey(config);
  try {
    const result = await runBrowserbaseFetchOutbound(config, {
      idempotencyKey,
    });
    const ledgerEvent = await recordPaymentEvent(paymentLedger, {
      type: 'outbound_cron_payment_succeeded',
      trigger: 'vercel_cron',
      idempotency_key: idempotencyKey,
      payment_provider: result.provider,
      signer_agent_id: result.signer_agent_id,
      signer_command: result.signer_command,
      service: result.service,
      endpoint: result.endpoint,
      amount_base_units: result.requested_amount_base_units,
      receipt_reference: result.signer_response?.fetch_result?.receipt?.reference || null,
      remote_addr: req.socket?.remoteAddress || null,
    });

    return sendJson(res, 200, {
      trigger: 'vercel_cron',
      read_only: false,
      idempotency_key: idempotencyKey,
      ledger_event_id: ledgerEvent?.event_id ?? null,
      result,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const ledgerEvent = await recordPaymentEvent(paymentLedger, {
      type: 'outbound_cron_payment_failed',
      trigger: 'vercel_cron',
      idempotency_key: idempotencyKey,
      status_code: statusCode,
      error: error.message,
      remote_addr: req.socket?.remoteAddress || null,
    });

    return sendJson(res, statusCode, {
      error: statusCode === 500 ? 'internal_error' : 'outbound_cron_payment_failed',
      message: error.message,
      idempotency_key: idempotencyKey,
      ledger_event_id: ledgerEvent?.event_id ?? null,
    });
  }
}

function getOutboundAdminAuthError(req, config) {
  if (!config.outboundAdminToken) {
    return {
      statusCode: 503,
      body: {
        error: 'outbound_admin_not_configured',
        message: 'Outbound admin endpoint is disabled until OUTBOUND_ADMIN_TOKEN is configured.',
      },
    };
  }

  const expectedAuth = `Bearer ${config.outboundAdminToken}`;
  if ((req.headers.authorization || '') !== expectedAuth) {
    return {
      statusCode: 401,
      body: {
        error: 'unauthorized',
        message: 'Valid outbound admin bearer token is required.',
      },
    };
  }

  return null;
}

function getOutboundCronAuthError(req, config) {
  if (!config.outboundCron.enabled) {
    return {
      statusCode: 503,
      body: {
        error: 'outbound_cron_disabled',
        message: 'Outbound cron is disabled until ENABLE_OUTBOUND_CRON=true is configured.',
      },
    };
  }

  if (!config.outboundCron.secret || config.outboundCron.secret.length < 32) {
    return {
      statusCode: 503,
      body: {
        error: 'cron_secret_not_configured',
        message: 'Outbound cron requires a strong CRON_SECRET.',
      },
    };
  }

  if ((req.headers.authorization || '') !== `Bearer ${config.outboundCron.secret}`) {
    return {
      statusCode: 401,
      body: {
        error: 'unauthorized',
        message: 'Valid cron bearer token is required.',
      },
    };
  }

  if (!config.outboundSpendPolicy.livePaymentsEnabled) {
    return {
      statusCode: 503,
      body: {
        error: 'outbound_live_payments_disabled',
        message: 'Outbound cron refuses to run while OUTBOUND_LIVE_PAYMENTS is false.',
      },
    };
  }

  return null;
}

async function getOutboundCronArmingError(config, paymentLedger) {
  if (config.outboundCron.requireVerifiedManualPayment === false) {
    return null;
  }

  if (!config.outboundCron.armingIdempotencyKey) {
    return {
      statusCode: 503,
      body: {
        error: 'outbound_cron_not_armed',
        message: 'Set OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY to the verified first manual outbound payment idempotency key before cron can spend.',
      },
    };
  }

  if (!paymentLedger) {
    return {
      statusCode: 503,
      body: {
        error: 'payment_ledger_not_configured',
        message: 'Payment ledger is required to verify the first manual outbound payment before cron can spend.',
      },
    };
  }

  const manualEvent = await findCronArmingManualOutboundEvent(config, paymentLedger);
  if (!manualEvent) {
    return {
      statusCode: 503,
      body: {
        error: 'outbound_cron_not_armed',
        message: 'No matching successful manual outbound payment event was found in the durable payment ledger.',
        required_idempotency_key: config.outboundCron.armingIdempotencyKey,
      },
    };
  }

  return null;
}

async function buildOutboundCronReadiness(config, paymentLedger) {
  const enableBlockers = [];
  const runBlockers = [];
  const warnings = [];
  const nextIdempotencyKey = buildCronOutboundIdempotencyKey(config);
  const preview = buildBrowserbaseFetchOutboundPreview(config, {
    idempotencyKey: nextIdempotencyKey,
  });

  enableBlockers.push(...preview.blockers);
  warnings.push(...preview.warnings);

  const cronSecretStrong = Boolean(config.outboundCron.secret && config.outboundCron.secret.length >= 32);
  if (!cronSecretStrong) {
    enableBlockers.push('CRON_SECRET must be configured with at least 32 characters before outbound cron can run.');
  }

  if (config.outboundCron.requireVerifiedManualPayment !== true) {
    enableBlockers.push('OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT must remain true before outbound cron can spend.');
  }

  if (!config.outboundCron.armingIdempotencyKey) {
    enableBlockers.push('OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY must be set to the verified first manual outbound payment idempotency key.');
  }

  let manualEvent = null;
  if (!paymentLedger) {
    enableBlockers.push('Payment ledger is required to verify the first manual outbound payment before cron can spend.');
  } else if (config.outboundCron.armingIdempotencyKey && config.outboundCron.requireVerifiedManualPayment === true) {
    manualEvent = await findCronArmingManualOutboundEvent(config, paymentLedger);
    if (!manualEvent) {
      enableBlockers.push('No matching successful manual outbound payment event was found in the durable payment ledger.');
    }
  }

  if (!config.outboundCron.enabled) {
    runBlockers.push('ENABLE_OUTBOUND_CRON is false; authorized cron route cannot run yet.');
  }

  const readyToEnable = enableBlockers.length === 0;
  const readyToRunAuthorized = readyToEnable && config.outboundCron.enabled;

  return {
    ok: readyToRunAuthorized,
    read_only: true,
    ready_to_enable: readyToEnable,
    ready_to_run_authorized: readyToRunAuthorized,
    cron: {
      enabled: config.outboundCron.enabled,
      secret_configured: Boolean(config.outboundCron.secret),
      strong_secret_configured: cronSecretStrong,
      idempotency_prefix: config.outboundCron.idempotencyPrefix,
      next_idempotency_key: nextIdempotencyKey,
      require_verified_manual_payment: config.outboundCron.requireVerifiedManualPayment,
      arming_idempotency_key_configured: Boolean(config.outboundCron.armingIdempotencyKey),
      arming_idempotency_key: config.outboundCron.armingIdempotencyKey || null,
    },
    outbound: {
      payment_provider: config.outboundSpendPolicy.paymentProvider,
      live_payments_enabled: config.outboundSpendPolicy.livePaymentsEnabled,
      signer_agent_id: config.outboundSigner.agentId,
      signer_command: config.outboundSigner.command,
      service: config.outboundSpendPolicy.targetService,
      endpoint: config.outboundSpendPolicy.targetEndpoint,
      amount_base_units: config.outboundSpendPolicy.targetAmountBaseUnits,
      max_per_call_usd: config.outboundSpendPolicy.maxPerCallUsd,
      max_daily_usd: config.outboundSpendPolicy.maxDailyUsd,
      preview_ok: preview.ok,
    },
    arming: serializeCronArmingEvent(manualEvent, config),
    blockers: [...enableBlockers, ...runBlockers],
    warnings,
    note: 'Read-only readiness only. No cron bearer token, signer request, payment, or downstream MPP fetch was executed.',
  };
}

async function findCronArmingManualOutboundEvent(config, paymentLedger) {
  const events = await paymentLedger.list();
  return events.find((event) => isCronArmingManualOutboundEvent(event, config)) || null;
}

function serializeCronArmingEvent(event, config) {
  if (!event) {
    return {
      found: false,
      expected_idempotency_key: config.outboundCron.armingIdempotencyKey || null,
    };
  }

  return {
    found: true,
    expected_idempotency_key: config.outboundCron.armingIdempotencyKey,
    event_id: event.event_id || null,
    type: event.type,
    trigger: event.trigger,
    idempotency_key: event.idempotency_key,
    payment_provider: event.payment_provider,
    signer_agent_id: event.signer_agent_id,
    signer_command: event.signer_command,
    service: event.service,
    endpoint: event.endpoint,
    amount_base_units: event.amount_base_units,
    receipt_reference: event.receipt_reference || null,
    created_at: event.created_at || null,
  };
}

function isCronArmingManualOutboundEvent(event, config) {
  return event?.type === 'outbound_admin_payment_succeeded'
    && event.trigger === 'admin_manual'
    && event.idempotency_key === config.outboundCron.armingIdempotencyKey
    && event.payment_provider === config.outboundSpendPolicy.paymentProvider
    && event.signer_agent_id === config.outboundSigner.agentId
    && event.signer_command === config.outboundSigner.command
    && event.service === config.outboundSpendPolicy.targetService
    && event.endpoint === config.outboundSpendPolicy.targetEndpoint
    && event.amount_base_units === config.outboundSpendPolicy.targetAmountBaseUnits;
}

function buildCronOutboundIdempotencyKey(config, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const prefix = String(config.outboundCron.idempotencyPrefix || 'cron-browserbase-fetch')
    .replace(/[^a-zA-Z0-9._:-]/g, '-')
    .slice(0, 96);
  return `${prefix}-${day}`;
}

export function methodNotAllowed(res) {
  return sendText(res, 405, 'Method Not Allowed');
}

function summarizeTempoRuntimeReadiness(readiness) {
  return {
    ok: readiness.ok,
    live_enabled: readiness.live_enabled,
    network: {
      name: readiness.network.name,
      chain_id: readiness.network.chain_id,
      currency: readiness.network.currency,
      token_decimals: readiness.network.token_decimals,
    },
    receiver: readiness.receiver,
    mpp: {
      secret_configured: readiness.mpp.secret_configured,
      realm_configured: Boolean(readiness.mpp.realm),
      wait_for_confirmation: readiness.mpp.wait_for_confirmation,
    },
    deps: {
      node_modules_found: readiness.deps.node_modules_found,
      mppx_server_found: readiness.deps.mppx_server_found,
      viem_found: readiness.deps.viem_found,
    },
    access_key: {
      required: readiness.access_key.required,
      configured: Boolean(
        readiness.access_key.env_file_exists
          || readiness.access_key.root_account_address
          || readiness.access_key.access_key_address
          || readiness.access_key.private_key_configured,
      ),
    },
    onchain: {
      checked: readiness.onchain.checked,
      authorized: readiness.onchain.authorized,
    },
    blockers: readiness.blockers.map(redactReadinessMessage),
    warnings: readiness.warnings.map(redactReadinessMessage),
  };
}

function redactReadinessMessage(message) {
  if (/AGENT_ACCESS_KEY/i.test(message)) {
    return 'Agent Access Key is not configured or not ready';
  }

  if (/MPP_SECRET_KEY|TEMPO_MPP_SECRET_KEY/i.test(message)) {
    return 'MPP server secret is missing or not ready';
  }

  if (/dependency|module/i.test(message)) {
    return 'Required runtime dependency is missing or not ready';
  }

  return message;
}
