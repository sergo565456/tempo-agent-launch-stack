import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { runFullStackLiveHandoffCheck } from './full-stack-live-handoff-check.js';
import { runPublicAutonomousReadinessSuite } from './public-autonomous-readiness-suite.js';
import { runPublicInboundReconcile } from './public-inbound-reconcile.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const DISCOVERY_PATHS = [
  '/',
  '/health',
  '/openapi.json',
  '/llms.txt',
  '/.well-known/agent-card.json',
  '/.well-known/x402',
];

const DEFAULT_MPPSCAN_URL = 'https://www.mppscan.com/server/829a2ec0cd95651c49881e21e918a2635f6eea7e9454df284c095821b2f1a893';

const options = parseArgs(process.argv.slice(2));
const summary = await runPublicMonitoringCheck(options);
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) {
  process.exitCode = 1;
}

export async function runPublicMonitoringCheck(options = {}) {
  const agentEnvFile = await readOptionalEnvFile(options.agentEnvFile || '.secrets/agent-production.env', {
    required: true,
  });
  const signerEnvFile = await readOptionalEnvFile(options.signerEnvFile || '../tempo-outbound-signer/.secrets/signer-live.env', {
    required: true,
  });
  const agentEnv = {
    ...process.env,
    ...agentEnvFile.values,
  };
  const signerEnv = {
    ...process.env,
    ...signerEnvFile.values,
  };
  const agentUrl = normalizeBaseUrl(options.agentUrl || agentEnv.PUBLIC_BASE_URL, 'agentUrl');
  const signerUrl = normalizeBaseUrl(options.signerUrl || agentEnv.OUTBOUND_SIGNER_BASE_URL || signerEnv.PUBLIC_BASE_URL, 'signerUrl');
  installFetchResolveOverride({
    ...options,
    agentUrl,
    signerUrl,
  });
  const agentAdminToken = agentEnv.OUTBOUND_ADMIN_TOKEN || '';
  const signerAdminToken = agentEnv.OUTBOUND_SIGNER_ADMIN_TOKEN || signerEnv.SIGNER_ADMIN_TOKEN || '';
  const secretValues = [agentAdminToken, signerAdminToken].filter(Boolean);
  const blockers = [];
  const warnings = [];

  const publicDiscovery = await runPublicDiscoveryChecks(agentUrl, options, secretValues, blockers);
  const mppscan = await runUrlStatusCheck(options.mppscanUrl || DEFAULT_MPPSCAN_URL, 'GET', secretValues, blockers);

  const autonomous = await captureCheck('public autonomous readiness', blockers, () => runPublicAutonomousReadinessSuite({
    agentUrl,
    signerUrl,
    agentAdminToken,
    signerAdminToken,
    expectPaymentMode: 'tempo',
    expectSignerProvider: 'turnkey',
    expectCronAuthGated: (agentEnv.ENABLE_OUTBOUND_CRON || '').toLowerCase() === 'true',
    expectCronReadyToEnable: false,
    expectedService: agentEnv.OUTBOUND_TARGET_SERVICE || undefined,
    expectedCommand: agentEnv.OUTBOUND_SIGNER_COMMAND || undefined,
    expectedEndpoint: agentEnv.OUTBOUND_TARGET_ENDPOINT || undefined,
    expectedRecipient: agentEnv.OUTBOUND_TARGET_RECIPIENT || undefined,
    expectedCurrency: agentEnv.TEMPO_USDC_ADDRESS || undefined,
    expectedChainId: agentEnv.TEMPO_CHAIN_ID ? Number(agentEnv.TEMPO_CHAIN_ID) : undefined,
    expectedAmountBaseUnits: agentEnv.OUTBOUND_TARGET_AMOUNT_BASE_UNITS || undefined,
  }), secretValues);

  const localHandoff = await captureCheck('local full-stack handoff', blockers, () => runFullStackLiveHandoffCheck({
    agentEnvFile: agentEnvFile.path,
    signerEnvFile: signerEnvFile.path,
    accessKeyExpectedAmountBaseUnits: agentEnv.OUTBOUND_TARGET_AMOUNT_BASE_UNITS || undefined,
  }), secretValues);

  const paymentEvents = await runPaymentEventsCheck(agentUrl, agentAdminToken, secretValues, blockers);
  const inbound = options.inboundIdempotencyKey || options.inboundReportId || options.inboundReceiptId
    ? await captureCheck('inbound reconciliation', blockers, () => runPublicInboundReconcile({
      baseUrl: agentUrl,
      agentAdminToken,
      idempotencyKey: options.inboundIdempotencyKey,
      reportId: options.inboundReportId,
      receiptId: options.inboundReceiptId,
      eventLimit: options.eventLimit || 100,
      expectedPaymentMode: 'tempo',
      expectedPaymentMethod: 'tempo_mpp',
    }), secretValues)
    : null;

  if (localHandoff?.warnings?.length) {
    warnings.push(...localHandoff.warnings);
  }
  const output = {
    ok: blockers.length === 0,
    read_only: true,
    generated_at: new Date().toISOString(),
    agent_url: agentUrl,
    signer_url: signerUrl,
    checks: {
      public_discovery: publicDiscovery,
      mppscan,
      autonomous,
      local_handoff: summarizeLocalHandoff(localHandoff),
      payment_events: paymentEvents,
      inbound,
    },
    blockers,
    warnings,
    note: 'Read-only public monitoring check. No report POST, payment, signer fetch, cron bearer, authorized cron, env upload, deploy, or directory submission was executed.',
  };

  assertNoSecretLeak('public monitoring output', JSON.stringify(output), secretValues);
  if (options.writeArtifact !== false) {
    await writeMonitoringArtifact(output);
  }
  return output;
}

async function runPublicDiscoveryChecks(agentUrl, options, secretValues, blockers) {
  const statuses = {};
  const methods = {};
  for (const path of DISCOVERY_PATHS) {
    const method = path === '/' ? 'GET' : 'HEAD';
    const result = await runUrlStatusCheck(`${agentUrl}${path}`, method, secretValues, blockers);
    statuses[path] = result.status;
    methods[path] = method;
  }

  const rootJson = await request(new URL('/', agentUrl), {
    headers: {
      accept: 'application/json',
    },
  });
  if (rootJson.status !== 200) {
    blockers.push(`root JSON expected 200, got ${rootJson.status}.`);
  }
  assertNoSecretLeak('root JSON', rootJson.text, secretValues);

  const price = rootJson.body?.price?.amount_usd || null;
  if (normalizeMoney(price) !== normalizeMoney(options.expectedPriceUsd || '0.01')) {
    blockers.push(`root JSON price expected ${options.expectedPriceUsd || '0.01'}, got ${price || 'missing'}.`);
  }

  return {
    ok: Object.values(statuses).every((status) => status === 200) && rootJson.status === 200,
    statuses,
    methods,
    root_json_status: rootJson.status,
    service: rootJson.body?.service || null,
    payment_mode: rootJson.body?.payment_mode || null,
    launch_price_usd: price,
  };
}

async function runUrlStatusCheck(url, method, secretValues, blockers) {
  const result = await request(new URL(url), { method });
  assertNoSecretLeak(`${method} ${url}`, result.text, secretValues);
  if (result.status < 200 || result.status >= 400) {
    blockers.push(`${method} ${url} returned HTTP ${result.status}.`);
  }
  return {
    ok: result.status >= 200 && result.status < 400,
    url,
    method,
    status: result.status,
  };
}

async function runPaymentEventsCheck(agentUrl, agentAdminToken, secretValues, blockers) {
  if (!agentAdminToken) {
    blockers.push('OUTBOUND_ADMIN_TOKEN is missing for payment-events monitoring.');
    return null;
  }

  const unauthorized = await request(new URL('/v1/admin/payment-events?limit=1', agentUrl), {
    method: 'GET',
  });
  const authorized = await request(new URL('/v1/admin/payment-events?limit=10', agentUrl), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${agentAdminToken}`,
    },
  });
  assertNoSecretLeak('payment events unauthorized', unauthorized.text, secretValues);
  assertNoSecretLeak('payment events authorized', authorized.text, secretValues);

  if (unauthorized.status !== 401) {
    blockers.push(`payment-events unauthorized check expected 401, got ${unauthorized.status}.`);
  }
  if (authorized.status !== 200) {
    blockers.push(`payment-events authorized check expected 200, got ${authorized.status}.`);
  }
  if (authorized.body?.read_only !== true) {
    blockers.push('payment-events authorized response must be read_only=true.');
  }
  const events = Array.isArray(authorized.body?.events) ? authorized.body.events : [];

  return {
    ok: unauthorized.status === 401 && authorized.status === 200 && authorized.body?.read_only === true,
    read_only: authorized.body?.read_only === true,
    unauthorized_status: unauthorized.status,
    authorized_status: authorized.status,
    total_events: authorized.body?.total_events ?? null,
    returned_events: events.length,
    latest_event: summarizePaymentEvent(events[0] || null),
  };
}

async function captureCheck(label, blockers, fn, secretValues) {
  try {
    const result = await fn();
    assertNoSecretLeak(label, JSON.stringify(result), secretValues);
    return result;
  } catch (error) {
    blockers.push(`${label} failed: ${error.message}`);
    return {
      ok: false,
      error: error.message,
    };
  }
}

async function request(url, init = {}) {
  const response = await fetch(url, init);
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

async function writeMonitoringArtifact(output) {
  const artifactDir = resolve(projectRoot, '.data/monitoring');
  await mkdir(artifactDir, { recursive: true });
  const timestamp = output.generated_at.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(
    resolve(artifactDir, `public-monitoring-check-${timestamp}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8',
  );
}

function summarizeLocalHandoff(result) {
  if (!result || result.ok === false) {
    return result;
  }
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    agent_ok: result.agent?.ok ?? null,
    signer_ok: result.signer?.ok ?? null,
    pair_ok: result.pair_consistency?.ok ?? null,
    signer_access_key_ok: result.signer_access_key_readiness?.ok ?? null,
    signer_access_key_agents: result.signer_access_key_readiness?.agents ?? [],
    blockers: result.blockers || [],
    warnings: result.warnings || [],
  };
}

function summarizePaymentEvent(event) {
  if (!event) {
    return null;
  }
  return {
    event_id: event.event_id || null,
    type: event.type || null,
    created_at: event.created_at || null,
    payment_status: event.payment_status || null,
    payment_mode: event.payment_mode || null,
    payment_method: event.payment_method || null,
    report_id: event.report_id || null,
    report_type: event.report_type || null,
    service: event.service || null,
    trigger: event.trigger || null,
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
  if (!raw.startsWith('https://')) {
    throw new Error(`${label} must be HTTPS.`);
  }
  return raw;
}

function normalizeMoney(value) {
  const raw = String(value || '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    return '';
  }
  const [whole, fraction = ''] = raw.split('.');
  return `${Number.parseInt(whole, 10)}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin token.`);
    }
  }
}

function parseArgs(args) {
  const values = {
    agentEnvFile: '.secrets/agent-production.env',
    signerEnvFile: '../tempo-outbound-signer/.secrets/signer-live.env',
    agentUrl: '',
    signerUrl: '',
    mppscanUrl: DEFAULT_MPPSCAN_URL,
    expectedPriceUsd: '0.01',
    eventLimit: 100,
    inboundIdempotencyKey: '',
    inboundReportId: '',
    inboundReceiptId: '',
    writeArtifact: true,
    agentResolveIp: process.env.PUBLIC_AGENT_RESOLVE_IP || '',
    signerResolveIp: process.env.PUBLIC_SIGNER_RESOLVE_IP || '',
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
    } else if (arg === '--agent-url' && next) {
      values.agentUrl = next;
      i += 1;
    } else if (arg === '--signer-url' && next) {
      values.signerUrl = next;
      i += 1;
    } else if (arg === '--mppscan-url' && next) {
      values.mppscanUrl = next;
      i += 1;
    } else if (arg === '--expected-price-usd' && next) {
      values.expectedPriceUsd = next;
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
    } else if (arg === '--event-limit' && next) {
      values.eventLimit = Number(next);
      i += 1;
    } else if (arg === '--no-write-artifact') {
      values.writeArtifact = false;
    } else if (arg === '--agent-resolve-ip' && next) {
      values.agentResolveIp = next;
      i += 1;
    } else if (arg === '--signer-resolve-ip' && next) {
      values.signerResolveIp = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-monitoring-check.js [--inbound-idempotency-key key] [--agent-resolve-ip 64.29.17.3] [--signer-resolve-ip 64.29.17.3]');
      process.exit(0);
    }
  }

  return values;
}

function installFetchResolveOverride(options) {
  const overrides = new Map();
  addResolveOverride(overrides, hostFromUrl(options.agentUrl), options.agentResolveIp);
  addResolveOverride(overrides, hostFromUrl(options.signerUrl), options.signerResolveIp);
  addResolveOverride(overrides, process.env.PUBLIC_AGENT_RESOLVE_HOST, options.agentResolveIp);
  addResolveOverride(overrides, process.env.PUBLIC_SIGNER_RESOLVE_HOST, options.signerResolveIp);
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
    if (!ip || url.protocol !== 'https:') {
      return originalFetch(input, init);
    }
    return fetchViaResolvedIp({ input, init, url, host, ip });
  };
}

function hostFromUrl(value) {
  if (!value) {
    return '';
  }
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
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

  return new Promise((resolveResponse, reject) => {
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
        resolveResponse(new Response(Buffer.concat(chunks), {
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
