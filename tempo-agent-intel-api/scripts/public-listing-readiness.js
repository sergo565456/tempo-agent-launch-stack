import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { runPublicLiveNextStep } from './public-live-next-step.js';

const DISCOVERY_PATHS = [
  '/health',
  '/openapi.json',
  '/llms.txt',
  '/.well-known/agent-card.json',
  '/.well-known/x402',
];

const PAID_ENDPOINTS = [
  '/v1/analyze',
  '/v1/launch-readiness',
  '/v1/service-diligence',
  '/v1/ecosystem-fit',
];

const DEFAULT_OUTBOUND_IDEMPOTENCY_KEY = 'first-live-browserbase-001';
const DEFAULT_EXPECTED_STANDARD_PRICE_USD = '0.01';

const defaultDeps = {
  runPublicLiveNextStep,
  request,
};

export async function runPublicListingReadiness(options, deps = defaultDeps) {
  const agentUrl = normalizeBaseUrl(options.agentUrl, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
    requireHttps(signerUrl, 'signerUrl');
  }
  if (!options.agentAdminToken) {
    throw new Error('OUTBOUND_ADMIN_TOKEN is required for public listing readiness.');
  }
  if (!options.signerAdminToken) {
    throw new Error('SIGNER_ADMIN_TOKEN is required for public listing readiness.');
  }

  const secretValues = [
    options.agentAdminToken,
    options.signerAdminToken,
    options.cronSecret,
  ].filter(Boolean);

  const nextStep = await deps.runPublicLiveNextStep({
    agentUrl,
    signerUrl,
    agentAdminToken: options.agentAdminToken,
    signerAdminToken: options.signerAdminToken,
    cronSecret: options.cronSecret,
    inboundIdempotencyKey: options.inboundIdempotencyKey,
    inboundReportId: options.inboundReportId,
    inboundReceiptId: options.inboundReceiptId,
    inboundEventLimit: options.inboundEventLimit,
    outboundEventLimit: options.outboundEventLimit,
    outboundIdempotencyKey: options.outboundIdempotencyKey || DEFAULT_OUTBOUND_IDEMPOTENCY_KEY,
    expectedCronIdempotencyKey: options.expectedCronIdempotencyKey,
    expectManualOutboundComplete: true,
    expectCronAuthGated: true,
    expectAuthorizedCronComplete: true,
    allowHttp: options.allowHttp,
    expectedService: options.expectedService,
    expectedCommand: options.expectedCommand,
    expectedEndpoint: options.expectedEndpoint,
    expectedRecipient: options.expectedRecipient,
    expectedCurrency: options.expectedCurrency,
    expectedChainId: options.expectedChainId,
    expectedAmountBaseUnits: options.expectedAmountBaseUnits,
  });

  assertNoSecretLeak('public live next-step listing evidence', JSON.stringify(nextStep), secretValues);

  const discovery = await fetchDiscovery(agentUrl, deps, secretValues);
  const blockers = [
    ...validateNextStep(nextStep),
    ...validateDiscovery(discovery, options),
  ];
  const summary = {
    ok: blockers.length === 0,
    read_only: true,
    ready_for_listing: blockers.length === 0,
    blockers,
    agent_url: agentUrl,
    signer_url: signerUrl,
    launch_stage: nextStep.stage,
    evidence: {
      inbound: nextStep.checks?.inbound_reconciliation || null,
      manual_outbound: nextStep.checks?.manual_outbound_reconciliation || null,
      authorized_cron: nextStep.checks?.authorized_cron_reconciliation || null,
    },
    discovery: summarizeDiscovery(discovery),
    pricing: {
      expected_standard_price_usd: normalizeMoney(options.expectedStandardPriceUsd || DEFAULT_EXPECTED_STANDARD_PRICE_USD),
    },
    listing_profile: {
      name: 'Agent Launch Intel API',
      category: 'Agent Commerce / Analytics / Developer Tooling',
      discovery_urls: [
        `${agentUrl}/llms.txt`,
        `${agentUrl}/openapi.json`,
        `${agentUrl}/.well-known/agent-card.json`,
        `${agentUrl}/.well-known/x402`,
      ],
    },
    next_manual_boundary: blockers.length === 0
      ? 'Owner review and manual submission to MPP directories/listings. Do not submit automatically.'
      : 'Resolve blockers and re-run public listing readiness before directory submission.',
    note: 'Read-only listing readiness. It performs GET-only discovery checks and composes verified payment evidence; no report POST, payment confirmation, signer fetch, env upload, deploy, cron bearer, authorized cron, or directory submission was executed.',
  };

  assertNoSecretLeak('public listing readiness summary', JSON.stringify(summary), secretValues);
  return summary;
}

async function fetchDiscovery(agentUrl, deps, secretValues) {
  const results = {};
  for (const path of DISCOVERY_PATHS) {
    const result = await deps.request(new URL(path, agentUrl));
    if (result.status !== 200) {
      throw new Error(`Discovery ${path} expected HTTP 200, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
    }
    assertNoSecretLeak(`public listing discovery ${path}`, result.text, secretValues);
    results[path] = result;
  }
  return results;
}

function validateNextStep(nextStep) {
  const blockers = [];
  if (nextStep.stage !== 'ready_for_listing_review') {
    blockers.push(`Launch stage must be ready_for_listing_review, got ${nextStep.stage}.`);
  }
  if (nextStep.checks?.inbound_reconciliation?.ok !== true) {
    blockers.push('Inbound payment reconciliation evidence is missing or not ok.');
  }
  if (nextStep.checks?.manual_outbound_reconciliation?.ok !== true) {
    blockers.push('Manual outbound payment reconciliation evidence is missing or not ok.');
  }
  if (nextStep.checks?.authorized_cron_reconciliation?.ok !== true) {
    blockers.push('Authorized cron payment reconciliation evidence is missing or not ok.');
  }
  return blockers;
}

function validateDiscovery(discovery, options) {
  const blockers = [];
  const expectedStandardPriceUsd = normalizeMoney(options.expectedStandardPriceUsd || DEFAULT_EXPECTED_STANDARD_PRICE_USD);
  const health = discovery['/health'].body || {};
  if (!['tempo', 'multi'].includes(health.payment_mode)) {
    blockers.push(`Health payment_mode must be tempo or multi, got ${health.payment_mode}.`);
  }
  if (health.storage?.durable_configured !== true) {
    blockers.push('Health must report durable agent storage before listing.');
  }
  if (health.outbound_live_payments !== true) {
    blockers.push('Health must report outbound_live_payments=true before listing the autonomous agent.');
  }

  const openapi = discovery['/openapi.json'].body || {};
  for (const path of PAID_ENDPOINTS) {
    const operation = openapi.paths?.[path]?.post;
    const offers = operation?.['x-payment-info']?.offers;
    if (!Array.isArray(offers) || offers.length === 0) {
      blockers.push(`OpenAPI ${path} is missing x-payment-info offers.`);
      continue;
    }
    if (!offers.some((offer) => offer.method === (options.expectedPaymentMethod || 'tempo'))) {
      blockers.push(`OpenAPI ${path} does not advertise a Tempo payment offer.`);
    }
    const tempoOffer = offers.find((offer) => offer.method === (options.expectedPaymentMethod || 'tempo'));
    const offerPrice = normalizeMoney(tempoOffer?.amount_usd || '');
    if (offerPrice !== expectedStandardPriceUsd) {
      blockers.push(`OpenAPI ${path} listing price must be ${expectedStandardPriceUsd} USD, got ${offerPrice || 'missing'}.`);
    }
  }

  const llmsText = String(discovery['/llms.txt'].body || '');
  for (const expected of ['Agent Launch Intel API', 'Payment mode:', 'POST /v1/analyze']) {
    if (!llmsText.includes(expected)) {
      blockers.push(`llms.txt is missing ${expected}.`);
    }
  }

  const agentCard = discovery['/.well-known/agent-card.json'].body || {};
  if (agentCard.name !== 'Agent Launch Intel API') {
    blockers.push(`agent-card name mismatch: ${agentCard.name}.`);
  }
  if (!Array.isArray(agentCard.payment?.offers) || agentCard.payment.offers.length === 0) {
    blockers.push('agent-card payment offers are missing.');
  }

  const x402 = discovery['/.well-known/x402'].body || {};
  if (!Array.isArray(x402.payment?.offers) || x402.payment.offers.length === 0) {
    blockers.push('x402 discovery payment offers are missing.');
  }
  if (!Array.isArray(x402.resources) || !x402.resources.includes('/v1/analyze')) {
    blockers.push('x402 discovery resources must include /v1/analyze.');
  }

  return blockers;
}

function summarizeDiscovery(discovery) {
  const openapi = discovery['/openapi.json'].body || {};
  const agentCard = discovery['/.well-known/agent-card.json'].body || {};
  const x402 = discovery['/.well-known/x402'].body || {};
  return {
    statuses: Object.fromEntries(Object.entries(discovery).map(([path, result]) => [path, result.status])),
    payment_mode: discovery['/health'].body?.payment_mode ?? null,
    outbound_live_payments: discovery['/health'].body?.outbound_live_payments ?? null,
    durable_storage: discovery['/health'].body?.storage?.durable_configured ?? null,
    paid_endpoint_count: PAID_ENDPOINTS.filter((path) => openapi.paths?.[path]?.post?.['x-payment-info']?.offers?.length).length,
    tempo_standard_prices_usd: Object.fromEntries(PAID_ENDPOINTS.map((path) => {
      const offer = openapi.paths?.[path]?.post?.['x-payment-info']?.offers?.find((candidate) => candidate.method === 'tempo');
      return [path, normalizeMoney(offer?.amount_usd || '') || null];
    })),
    agent_card_offer_count: agentCard.payment?.offers?.length ?? 0,
    x402_offer_count: x402.payment?.offers?.length ?? 0,
  };
}

async function request(url) {
  const response = await fetch(url, { method: 'GET' });
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

function normalizeBaseUrl(value, label) {
  const raw = (value || '').trim().replace(/\/$/, '');
  if (!raw) {
    throw new Error(`${label} is required.`);
  }
  try {
    new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  return raw;
}

function requireHttps(value, label) {
  if (!/^https:\/\//.test(value)) {
    throw new Error(`${label} must be HTTPS. Use --allow-http only for local diagnostics.`);
  }
}

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin or cron token.`);
    }
  }
}

function normalizeMoney(value) {
  const raw = String(value || '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    return '';
  }
  const [whole, fraction = ''] = raw.split('.');
  return `${Number.parseInt(whole, 10)}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function parseArgs(args) {
  const values = {
    agentUrl: process.env.PUBLIC_AGENT_BASE_URL || '',
    signerUrl: process.env.PUBLIC_SIGNER_BASE_URL || '',
    agentAdminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    signerAdminToken: process.env.SIGNER_ADMIN_TOKEN || process.env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
    cronSecret: process.env.CRON_SECRET || '',
    inboundIdempotencyKey: process.env.INBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    inboundReportId: process.env.INBOUND_RECONCILE_REPORT_ID || '',
    inboundReceiptId: process.env.INBOUND_RECONCILE_RECEIPT_ID || '',
    inboundEventLimit: Number(process.env.INBOUND_RECONCILE_EVENT_LIMIT || 100),
    outboundEventLimit: Number(process.env.OUTBOUND_RECONCILE_EVENT_LIMIT || process.env.INBOUND_RECONCILE_EVENT_LIMIT || 100),
    outboundIdempotencyKey: process.env.OUTBOUND_LIVE_IDEMPOTENCY_KEY || DEFAULT_OUTBOUND_IDEMPOTENCY_KEY,
    expectedCronIdempotencyKey: process.env.OUTBOUND_CRON_EXPECTED_IDEMPOTENCY_KEY || '',
    allowHttp: false,
    expectedService: process.env.EXPECTED_OUTBOUND_SERVICE || 'mpp.browserbase.com',
    expectedCommand: process.env.EXPECTED_OUTBOUND_COMMAND || 'fetch_browserbase_page',
    expectedEndpoint: process.env.EXPECTED_OUTBOUND_ENDPOINT || undefined,
    expectedRecipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || undefined,
    expectedCurrency: process.env.EXPECTED_OUTBOUND_CURRENCY || undefined,
    expectedChainId: process.env.EXPECTED_OUTBOUND_CHAIN_ID ? Number(process.env.EXPECTED_OUTBOUND_CHAIN_ID) : undefined,
    expectedAmountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || '10000',
    expectedStandardPriceUsd: process.env.EXPECTED_LISTING_STANDARD_PRICE_USD || DEFAULT_EXPECTED_STANDARD_PRICE_USD,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--agent-url' && next) {
      values.agentUrl = next;
      i += 1;
    } else if (arg === '--signer-url' && next) {
      values.signerUrl = next;
      i += 1;
    } else if (arg === '--agent-admin-token-env' && next) {
      values.agentAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--signer-admin-token-env' && next) {
      values.signerAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--cron-secret-env' && next) {
      values.cronSecret = process.env[next] || '';
      i += 1;
    } else if (arg === '--inbound-idempotency-key' && next) {
      values.inboundIdempotencyKey = next;
      i += 1;
    } else if (arg === '--inbound-report-id' && next) {
      values.inboundReportId = next;
      i += 1;
    } else if (arg === '--inbound-receipt-id' && next) {
      values.inboundReceiptId = next;
      i += 1;
    } else if (arg === '--inbound-event-limit' && next) {
      values.inboundEventLimit = Number(next);
      i += 1;
    } else if (arg === '--outbound-event-limit' && next) {
      values.outboundEventLimit = Number(next);
      i += 1;
    } else if (arg === '--outbound-idempotency-key' && next) {
      values.outboundIdempotencyKey = next;
      i += 1;
    } else if (arg === '--expected-cron-idempotency-key' && next) {
      values.expectedCronIdempotencyKey = next;
      i += 1;
    } else if (arg === '--expected-standard-price-usd' && next) {
      values.expectedStandardPriceUsd = next;
      i += 1;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-listing-readiness.js --agent-url https://agent.example --signer-url https://signer.example --inbound-idempotency-key ... --expected-cron-idempotency-key cron-browserbase-fetch-YYYY-MM-DD');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installFetchResolveOverrideFromEnv();
  const summary = await runPublicListingReadiness(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function installFetchResolveOverrideFromEnv() {
  const overrides = new Map();
  addResolveOverride(overrides, process.env.PUBLIC_AGENT_RESOLVE_HOST, process.env.PUBLIC_AGENT_RESOLVE_IP);
  addResolveOverride(overrides, process.env.PUBLIC_SIGNER_RESOLVE_HOST, process.env.PUBLIC_SIGNER_RESOLVE_IP);
  if (overrides.size === 0) {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === 'string' ? input : input.url);
    const host = url.hostname.toLowerCase();
    const ip = overrides.get(host);
    if (!ip) {
      return originalFetch(input, init);
    }
    return fetchViaResolvedIp({ input, init, url, host, ip });
  };
}

function addResolveOverride(overrides, rawHost, rawIp) {
  const host = (rawHost || '').trim().toLowerCase();
  const ip = (rawIp || '').trim();
  if (host && ip) {
    overrides.set(host, ip);
  }
}

async function fetchViaResolvedIp({ input, init, url, host, ip }) {
  const request = typeof input === 'string' || input instanceof URL ? null : input;
  const method = init.method || request?.method || 'GET';
  const headers = new Headers(request?.headers || {});
  for (const [key, value] of new Headers(init.headers || {})) {
    headers.set(key, value);
  }
  headers.set('host', host);
  const body = init.body || null;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ip,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method,
      servername: host,
      headers: Object.fromEntries(headers),
      timeout: 20_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value));
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Fetch resolve override timed out for ${host} via ${ip}`)));
    req.on('error', reject);
    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}
