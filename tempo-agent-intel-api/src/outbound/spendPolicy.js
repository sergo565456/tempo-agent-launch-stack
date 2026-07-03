const DEFAULT_ALLOWED_SERVICES = [
  'mpp.dev',
  'mppscan.org',
  'parallelmpp.dev',
  'mpp.browserbase.com',
  'firecrawl',
];

const DEFAULT_CANDIDATE_CALLS = [
  {
    service: 'mppscan.org',
    purpose: 'Check visible MPP ecosystem activity and service discovery signals.',
    estimated_cost_usd: '0.00',
  },
  {
    service: 'mpp.dev',
    purpose: 'Refresh payment/discovery documentation before launch guidance.',
    estimated_cost_usd: '0.00',
  },
  {
    service: 'mpp.browserbase.com',
    purpose: 'Optional paid Browserbase fetch for current source gathering when live outbound spend is enabled.',
    estimated_cost_usd: '0.01',
  },
];

export function buildOutboundSpendPlan(config, request) {
  const policy = config.outboundSpendPolicy;
  const plannedCalls = DEFAULT_CANDIDATE_CALLS.map((candidate) => {
    const decision = evaluateSpendCandidate(policy, candidate);
    return {
      ...candidate,
      decision: decision.decision,
      reason: decision.reason,
      live_payment: false,
    };
  });

  return {
    mode: policy.livePaymentsEnabled ? 'live_guarded' : 'dry_run',
    live_payments_enabled: policy.livePaymentsEnabled,
    report_type: request.report_type,
    policy: {
      payment_provider: policy.paymentProvider,
      max_per_call_usd: policy.maxPerCallUsd,
      max_daily_usd: policy.maxDailyUsd,
      allowed_services: policy.allowedServices,
      deny_unknown_services: policy.denyUnknownServices,
      target_service: policy.targetService,
      target_endpoint: policy.targetEndpoint,
      target_amount_base_units: policy.targetAmountBaseUnits,
    },
    planned_calls: plannedCalls,
    receipts: [],
    status: policy.livePaymentsEnabled
      ? 'live spending requires explicit per-run approval before any downstream payment'
      : 'dry run only; no downstream MPP payment was attempted',
  };
}

function evaluateSpendCandidate(policy, candidate) {
  if (!policy.allowedServices.includes(candidate.service) && policy.denyUnknownServices) {
    return {
      decision: 'blocked',
      reason: 'service is not on the outbound MPP allowlist',
    };
  }

  if (decimalGreaterThan(candidate.estimated_cost_usd, policy.maxPerCallUsd)) {
    return {
      decision: 'blocked',
      reason: 'estimated cost exceeds max_per_call_usd',
    };
  }

  if (!policy.livePaymentsEnabled) {
    return {
      decision: 'dry_run_allowed',
      reason: 'candidate is allowed by policy, but live outbound payments are disabled',
    };
  }

  return {
    decision: 'requires_runtime_approval',
    reason: 'live outbound spending is enabled but this implementation still requires explicit approval before paying',
  };
}

function decimalGreaterThan(left, right) {
  return Number.parseFloat(left) > Number.parseFloat(right);
}

export function parseAllowedServices(raw) {
  if (!raw) {
    return DEFAULT_ALLOWED_SERVICES;
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
