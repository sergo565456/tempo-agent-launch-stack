import { getDiscoveryOffers } from './payments/adapters.js';

export function buildLlmsText(config) {
  const offers = getDiscoveryOffers(config)
    .map((offer) => `${offer.method}:${offer.network || 'local'}:${offer.amount} ${offer.currency}`)
    .join(', ');

  return [
    '# Agent Launch Intel API',
    '',
    'Paid intelligence API for builders launching x402, MPP, Tempo, Venice, and MCP agent services.',
    '',
    '## Endpoints',
    '',
    '- POST /v1/analyze: general opportunity report.',
    '- POST /v1/launch-readiness: paid service launch readiness report.',
    '- POST /v1/service-diligence: due diligence report for an existing paid agent/API service.',
    '- POST /v1/ecosystem-fit: compare launch fit across Tempo MPP, Base x402, Venice, and agent directories.',
    '- GET /v1/reports/{report_id}: retrieve a stored report with the original Idempotency-Key or receipt_id proof in live payment modes.',
    '',
    '## Payment',
    '',
    `Payment mode: ${config.paymentMode}`,
    `Offers: ${offers || 'none'}`,
    '',
    'Local mock mode: retry unpaid 402 responses with X-Mock-Payment: paid and the same Idempotency-Key.',
    '',
    '## Safety',
    '',
    'The runtime does not load an owner/root wallet. Outbound Tempo MPP spending is dry-run only unless explicitly enabled with a capped allowlist.',
  ].join('\n');
}

export function buildAgentCard(config) {
  return {
    name: 'Agent Launch Intel API',
    service_id: config.serviceName,
    version: '0.2.0',
    description: 'Paid launch and diligence reports for agent-payment services across Tempo MPP, Base x402, Venice, and MCP ecosystems.',
    url: config.publicBaseUrl,
    endpoints: [
      { method: 'POST', path: '/v1/analyze', report_type: 'opportunity_report' },
      { method: 'POST', path: '/v1/launch-readiness', report_type: 'launch_readiness_report' },
      { method: 'POST', path: '/v1/service-diligence', report_type: 'service_diligence_report' },
      { method: 'POST', path: '/v1/ecosystem-fit', report_type: 'ecosystem_fit_report' },
    ],
    payment: {
      mode: config.paymentMode,
      rails: config.enabledPaymentRails,
      offers: getDiscoveryOffers(config),
    },
    outbound_spend_policy: {
      live_payments_enabled: config.outboundSpendPolicy.livePaymentsEnabled,
      max_per_call_usd: config.outboundSpendPolicy.maxPerCallUsd,
      max_daily_usd: config.outboundSpendPolicy.maxDailyUsd,
      allowed_services: config.outboundSpendPolicy.allowedServices,
    },
  };
}

export function buildX402Discovery(config) {
  return {
    service: 'Agent Launch Intel API',
    version: '0.2.0',
    payment: {
      offers: getDiscoveryOffers(config),
    },
    resources: [
      '/v1/analyze',
      '/v1/launch-readiness',
      '/v1/service-diligence',
      '/v1/ecosystem-fit',
    ],
    notes: [
      config.tempoMppLiveEnabled
        ? 'Tempo MPP live mode is enabled; paid report endpoints require a verified Tempo payment credential and stable Idempotency-Key.'
        : 'Tempo MPP live mode is scaffolded but blocked until mppx and recipient wallet are configured.',
      'Base x402 live mode is scaffolded but blocked until recipient wallet and middleware are configured.',
    ],
  };
}
