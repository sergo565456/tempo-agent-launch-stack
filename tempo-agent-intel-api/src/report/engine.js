import { createReportId } from '../utils/id.js';
import { validateAnalyzeResponse } from '../schemas/analyze.js';

const SOURCES = [
  {
    title: 'MPP services directory',
    url: 'https://mpp.dev/services',
    note: 'Lists current machine-payable MPP services and gives agents a discovery starting point.',
  },
  {
    title: 'MPPScan',
    url: 'https://mppscan.org/',
    note: 'Shows live ecosystem activity across agents, servers, transactions, and visible payment volume.',
  },
  {
    title: 'x402 documentation',
    url: 'https://docs.x402.org/',
    note: 'Defines the HTTP 402 payment flow used by paid APIs and agents.',
  },
  {
    title: 'Cloudflare Agents x402',
    url: 'https://developers.cloudflare.com/agents/x402/',
    note: 'Shows a practical agent runtime path for x402 payment-gated endpoints.',
  },
  {
    title: 'Built in Venice',
    url: 'https://builtinvenice.ai/',
    note: 'Catalog of Venice ecosystem projects, MCP tools, x402 clients, and private agent workflows.',
  },
  {
    title: 'Tempo Account Keychain',
    url: 'https://docs.tempo.xyz/protocol/transactions/AccountKeychain',
    note: 'Documents scoped secondary keys and spending limits for safer agent wallet operation.',
  },
  {
    title: 'MPP multi-method discovery',
    url: 'https://mpp.dev/blog/multi-method-discovery',
    note: 'Explains the current multi-offer `x-payment-info` shape for discoverable paid APIs.',
  },
  {
    title: 'MPP payment hooks',
    url: 'https://mpp.dev/blog/payment-hooks',
    note: 'Describes lifecycle hooks for observability, receipts, and support workflows.',
  },
];

const DEPTH_COSTS = {
  quick: {
    price_usd: '0.01',
    estimated_internal_cost_usd: '0.003',
    max_sources: 3,
  },
  standard: {
    price_usd: '0.05',
    estimated_internal_cost_usd: '0.015',
    max_sources: 6,
  },
  deep: {
    price_usd: '0.25',
    estimated_internal_cost_usd: '0.05',
    max_sources: 6,
  },
};

export function generateAnalyzeReport(request, payment, options = {}) {
  const now = options.now || new Date();
  const reportId = options.reportId || createReportId();
  const depthCost = DEPTH_COSTS[request.depth];
  const selectedSources = SOURCES.slice(0, depthCost.max_sources);
  const lower = `${request.target} ${request.question}`.toLowerCase();
  const category = classifyTarget(lower);

  const report = {
    report_id: reportId,
    report_type: request.report_type,
    target: request.target,
    question: request.question,
    summary: buildSummary(request, category),
    confidence: request.depth === 'quick' ? 'medium' : 'high',
    market_signals: buildMarketSignals(category, selectedSources),
    opportunities: buildOpportunities(category),
    risks: buildRisks(category),
    competitors: buildCompetitors(category),
    recommended_actions: buildRecommendedActions(request, category),
    ...buildReportSpecificSections(request, category),
    sources: selectedSources,
    cost_estimate: {
      charged_price_usd: payment.amount_usd || depthCost.price_usd,
      estimated_internal_cost_usd: depthCost.estimated_internal_cost_usd,
      depth: request.depth,
      pricing_model: 'fixed_price_per_report',
      margin_note: 'Local estimate only; verify real LLM/search/tool costs before live launch.',
      outbound_spend_mode: options.outboundPlan?.mode || 'not_planned',
    },
    outbound_spend_plan: options.outboundPlan || null,
    payment: {
      mode: payment.mode,
      method: payment.method || payment.mode,
      status: payment.status,
      receipt_id: payment.receipt_id || null,
      challenge_id: payment.challenge_id || null,
    },
    generated_at: now.toISOString(),
  };

  const validation = validateAnalyzeResponse(report);
  if (!validation.ok) {
    throw new Error(`Generated report failed schema validation: ${validation.errors.join('; ')}`);
  }

  return report;
}

function classifyTarget(lower) {
  if (lower.includes('venice') || lower.includes('mcp')) {
    return 'venice_mcp';
  }

  if (lower.includes('base') || lower.includes('x402')) {
    return 'base_x402';
  }

  if (lower.includes('wallet') || lower.includes('address') || lower.includes('onchain')) {
    return 'wallet_intel';
  }

  if (lower.includes('mppscan') || lower.includes('directory') || lower.includes('discovery')) {
    return 'discovery_market';
  }

  if (lower.includes('auto.exchange') || lower.includes('agent exchange') || lower.includes('agent marketplace')) {
    return 'agent_marketplace';
  }

  if (lower.includes('tempo') || lower.includes('mpp') || lower.includes('x402') || lower.includes('402')) {
    return 'tempo_mpp';
  }

  return 'general_agent_commerce';
}

function buildSummary(request, category) {
  const prefixByType = {
    opportunity_report: `${request.target} should be evaluated as a paid agent-commerce opportunity, not as a generic chatbot idea.`,
    launch_readiness_report: `${request.target} should be evaluated as a launchable paid API or MCP-style service, with payment discovery, docs, and retry behavior checked before listing.`,
    service_diligence_report: `${request.target} should be evaluated as a paid service dependency: pricing, trust, uptime, discovery quality, and buyer fit matter more than branding.`,
    ecosystem_fit_report: `${request.target} should be evaluated across multiple payment ecosystems instead of assuming Tempo, Base, or Venice is the only distribution channel.`,
  };

  const prefix = prefixByType[request.report_type] || prefixByType.opportunity_report;

  const categoryNotes = {
    tempo_mpp: 'The strongest wedge is a structured paid report or tooling API that helps builders make decisions around MPP discovery, service quality, receipts, routing, or market selection.',
    base_x402: 'Base/x402 is useful as a second payment rail because many builders already understand Base USDC and HTTP 402 services.',
    venice_mcp: 'Venice and MCP demand points toward privacy-preserving research, tool use, and agent workflows rather than a single chain-specific product.',
    discovery_market: 'The clearest near-term buyer is the builder trying to get a paid API listed, trusted, and called by agents.',
    agent_marketplace: 'The marketplace signal is useful but still early; treat listed-agent revenue as validation of payment rails, not proof of broad passive demand.',
    wallet_intel: 'Wallet intelligence can be valuable if the product produces behavior labels and risk signals that are hard to get from raw explorers.',
    general_agent_commerce: 'The idea needs a narrow paid outcome, direct distribution, and evidence that the report saves meaningful time or spend.',
  };

  return `${prefix} ${categoryNotes[category]} For the question "${request.question}", the recommended path is to build a narrow paid API first, measure paid retries and repeat users, then expand only after real demand appears.`;
}

function buildMarketSignals(category, sources) {
  const base = [
    {
      signal: 'MPP and x402 expose machine-readable payment flows through HTTP 402, which lets agents pay for API calls without account creation.',
      importance: 'high',
      source: sources[2]?.url,
      interpretation: 'This makes a paid report endpoint viable as an agent-consumable API rather than only a human SaaS page.',
    },
    {
      signal: 'Live directories and explorers show real agent/server activity, but visible aggregate volume remains early-stage.',
      importance: 'high',
      source: sources[1]?.url,
      interpretation: 'Do not depend on passive directory traffic; combine registration with direct distribution.',
    },
    {
      signal: 'Multi-offer discovery and payment hooks create product space around routing, observability, receipts, and support.',
      importance: 'medium',
      source: sources[4]?.url,
      interpretation: 'Infrastructure-adjacent analytics can earn before consumer autonomous commerce matures.',
    },
  ];

  if (category === 'agent_marketplace') {
    base.push({
      signal: 'Public agent marketplaces show paid agent listings with visible usage and earnings.',
      importance: 'medium',
      source: 'https://auto.exchange/',
      interpretation: 'This validates listing mechanics, but current earnings should be treated as small-sample evidence.',
    });
  }

  if (category === 'wallet_intel') {
    base.push({
      signal: 'Agent payments create a new need to map wallet behavior to agent runs, service calls, and receipts.',
      importance: 'medium',
      source: 'https://mpp.dev/blog/payment-hooks',
      interpretation: 'The wedge is not generic chain analytics; it is payment-context intelligence.',
    });
  }

  if (category === 'venice_mcp') {
    base.push({
      signal: 'Venice ecosystem projects emphasize private research, MCP tools, and x402-compatible agent workflows.',
      importance: 'medium',
      source: 'https://builtinvenice.ai/',
      interpretation: 'The best product angle is launch intelligence and private research tooling, not a Tempo-only analytics surface.',
    });
  }

  return base;
}

function buildOpportunities(category) {
  const common = [
    {
      name: 'Paid opportunity report API',
      why_now: 'Builders are exploring MPP/Tempo/x402 niches and need decision-grade summaries with sources.',
      difficulty: 'low',
      monetization: 'Fixed price per report, then subscription for recurring scouting.',
    },
    {
      name: 'Discovery readiness report',
      why_now: 'Paid APIs must expose correct OpenAPI and 402 metadata before directories can index them.',
      difficulty: 'medium',
      monetization: 'Paid scan plus implementation package.',
    },
  ];

  const categorySpecific = {
    tempo_mpp: [
      {
        name: 'MPP service reputation scanner',
        why_now: 'Agents need reliability and pricing evidence before spending.',
        difficulty: 'medium',
        monetization: 'Pay-per-score and monitoring subscription.',
      },
    ],
    base_x402: [
      {
        name: 'x402 launch readiness scanner',
        why_now: 'Base/x402 services need clear payment discovery, facilitator behavior, receipts, and retry safety.',
        difficulty: 'medium',
        monetization: 'Paid scan plus recurring monitoring for listed endpoints.',
      },
    ],
    venice_mcp: [
      {
        name: 'Private agent research launch pack',
        why_now: 'Venice builders need privacy-forward MCP/x402 workflows with credible sources and payment-ready APIs.',
        difficulty: 'medium',
        monetization: 'Paid readiness report, then recurring ecosystem scouting.',
      },
    ],
    discovery_market: [
      {
        name: 'MPPScan registration doctor',
        why_now: 'Many builders can create an API but fail machine-readable discovery requirements.',
        difficulty: 'low',
        monetization: 'Free basic validator, paid fix pack.',
      },
    ],
    agent_marketplace: [
      {
        name: 'Agent listing packager',
        why_now: 'Agents need positioning, pricing, examples, OpenAPI, and safety copy before listing.',
        difficulty: 'medium',
        monetization: 'Launch package plus revenue share.',
      },
    ],
    wallet_intel: [
      {
        name: 'Agent-payment wallet labels',
        why_now: 'Payment-native agents will need wallet behavior labels tied to service usage.',
        difficulty: 'high',
        monetization: 'Pay-per-wallet lookup and batch reports.',
      },
    ],
    general_agent_commerce: [
      {
        name: 'Vertical paid research endpoint',
        why_now: 'A narrow report with a clear buyer is easier to sell than a broad assistant.',
        difficulty: 'medium',
        monetization: 'Fixed report price and monthly digest.',
      },
    ],
  };

  return [...common, ...(categorySpecific[category] || categorySpecific.general_agent_commerce)];
}

function buildRisks(category) {
  const risks = [
    {
      risk: 'Directory traffic may be too small for passive revenue.',
      severity: 'high',
      mitigation: 'Use MPPScan/auto.exchange as proof and discovery, but sell directly to builders.',
    },
    {
      risk: 'Reports may feel like generic LLM output.',
      severity: 'high',
      mitigation: 'Require sources, scoring, concrete recommended actions, and explicit confidence.',
    },
    {
      risk: 'Payment integration can double-charge or break retries.',
      severity: 'medium',
      mitigation: 'Use idempotency keys, receipt logging, and mock 402 tests before live MPP.',
    },
  ];

  if (category === 'wallet_intel') {
    risks.push({
      risk: 'Wallet attribution can be wrong.',
      severity: 'high',
      mitigation: 'Use confidence labels and avoid claiming identity from behavior alone.',
    });
  }

  return risks;
}

function buildCompetitors(category) {
  const competitors = [
    {
      name: 'Generic search/LLM wrappers',
      pressure: 'high',
      differentiation: 'They provide raw answers; this product sells structured, payment-market-specific decisions.',
    },
    {
      name: 'MPP service directory',
      pressure: 'medium',
      differentiation: 'Directories show supply; this product interprets gaps, risks, and launch path.',
    },
  ];

  if (category === 'wallet_intel') {
    competitors.push({
      name: 'General crypto analytics platforms',
      pressure: 'high',
      differentiation: 'Focus on agent-payment context, receipts, and service usage rather than broad token analytics.',
    });
  }

  return competitors;
}

function buildRecommendedActions(request, category) {
  const actionsByType = {
    opportunity_report: [
      'Keep the first endpoint narrow: one report type, one schema, one paid outcome.',
      'Ship mock 402 and OpenAPI discovery before touching real payment credentials.',
      'Register only after runtime 402 behavior matches the discovery document.',
    ],
    launch_readiness_report: [
      'Compare OpenAPI payment discovery with actual unpaid 402 responses.',
      'Add llms.txt, agent card, examples, pricing, and receipt/error behavior before public listing.',
      'Run mock unpaid, mock paid, replay, and idempotency tests before any live payment.',
    ],
    service_diligence_report: [
      'Check whether the service exposes machine-readable price, method, network, and receipt details.',
      'Treat directory presence as one signal, not proof of reliability or revenue.',
      'Use a tiny controlled paid call only after the service passes static discovery checks.',
    ],
    ecosystem_fit_report: [
      'Launch with Tempo MPP and Base/x402 discovery surfaces, then add Venice positioning if the service has privacy or MCP relevance.',
      'Keep one core API and expose multiple payment offers instead of fragmenting the product.',
      'Track where paid retries actually arrive from before committing to one ecosystem.',
    ],
  };

  const actions = [...(actionsByType[request.report_type] || actionsByType.opportunity_report)];

  const sharedActions = [
    'Keep the first endpoint narrow: one report type, one schema, one paid outcome.',
    'Ship mock 402 and OpenAPI discovery before touching real payment credentials.',
    'Register only after runtime 402 behavior matches the discovery document.',
  ];

  for (const action of sharedActions) {
    if (!actions.includes(action)) {
      actions.push(action);
    }
  }

  if (request.depth !== 'quick') {
    actions.push('Prepare three public example reports to prove quality before asking for paid traffic.');
  }

  if (category === 'discovery_market') {
    actions.push('Add a discovery check that compares OpenAPI `x-payment-info` with the live 402 challenge.');
  } else if (category === 'agent_marketplace') {
    actions.push('Package the agent with listing copy, price tiers, examples, and a non-live demo call.');
  } else if (category === 'wallet_intel') {
    actions.push('Start with public-address-only inputs and mark all identity claims as inferred.');
  } else {
    actions.push('Track paid retries, repeat buyers, report latency, and gross margin from day one.');
  }

  return actions;
}

function buildReportSpecificSections(request, category) {
  if (request.report_type === 'launch_readiness_report') {
    return {
      launch_score: category === 'discovery_market' ? 76 : 68,
      readiness_checks: [
        {
          check: 'OpenAPI exposes a paid operation with x-payment-info offers.',
          status: 'required',
          why_it_matters: 'Agents need to discover price and payment method before calling.',
        },
        {
          check: 'Runtime unpaid call returns HTTP 402 with matching payment metadata.',
          status: 'required',
          why_it_matters: 'Directories and buyers should not trust stale OpenAPI claims.',
        },
        {
          check: 'Idempotency-Key prevents duplicate fulfillment on paid retries.',
          status: 'required',
          why_it_matters: 'Payment retries are normal; double fulfillment makes support and accounting fragile.',
        },
        {
          check: 'llms.txt and agent-card describe endpoints, price, examples, and safety boundaries.',
          status: 'recommended',
          why_it_matters: 'Machine-readable docs improve agent-to-agent discovery.',
        },
      ],
    };
  }

  if (request.report_type === 'service_diligence_report') {
    return {
      diligence_checks: [
        {
          area: 'payment_discovery',
          finding: 'Verify method, token, network, amount, receiver, and retry instructions before paying.',
          risk: 'medium',
        },
        {
          area: 'market_activity',
          finding: 'Use visible directory and explorer activity as a weak signal until a paid call is tested.',
          risk: 'medium',
        },
        {
          area: 'dependency_quality',
          finding: 'Prefer services with receipts, stable schemas, clear rate limits, and explicit refund/error behavior.',
          risk: 'high',
        },
      ],
      trust_score: category === 'tempo_mpp' || category === 'base_x402' ? 72 : 61,
    };
  }

  if (request.report_type === 'ecosystem_fit_report') {
    return {
      ecosystem_fit: [
        {
          ecosystem: 'Tempo MPP',
          fit: 'high',
          use_when: 'The service targets agent-native payments, MPPScan visibility, and Tempo stablecoin settlement.',
        },
        {
          ecosystem: 'Base x402',
          fit: 'high',
          use_when: 'The buyer base prefers Base USDC, x402 middleware, or Cloudflare/agent runtime integrations.',
        },
        {
          ecosystem: 'Venice / MCP',
          fit: category === 'venice_mcp' ? 'high' : 'medium',
          use_when: 'The product angle is private research, MCP tools, inference workflows, or Venice-native distribution.',
        },
      ],
    };
  }

  return {
    opportunity_score: category === 'tempo_mpp' || category === 'base_x402' ? 78 : 66,
  };
}
