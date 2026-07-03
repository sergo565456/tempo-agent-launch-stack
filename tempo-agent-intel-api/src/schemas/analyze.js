export const SUPPORTED_DEPTHS = ['quick', 'standard', 'deep'];
export const SUPPORTED_REPORT_TYPES = [
  'opportunity_report',
  'launch_readiness_report',
  'service_diligence_report',
  'ecosystem_fit_report',
  'tempo_mpp_opportunity',
];

const REPORT_TYPE_ALIASES = {
  tempo_mpp_opportunity: 'opportunity_report',
};

export function validateAnalyzeRequest(input, options = {}) {
  const errors = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Request body must be a JSON object'] };
  }

  const target = normalizeString(input.target);
  const question = normalizeString(input.question);
  const depth = normalizeString(input.depth || 'quick');
  const reportType = normalizeReportType(options.reportType || input.report_type || 'opportunity_report');
  const outputFormat = normalizeString(input.output_format || 'json');
  const constraints = input.constraints && typeof input.constraints === 'object' && !Array.isArray(input.constraints)
    ? input.constraints
    : {};

  if (!target) {
    errors.push('target is required');
  } else if (target.length > 240) {
    errors.push('target must be 240 characters or less');
  }

  if (!question) {
    errors.push('question is required');
  } else if (question.length > 1200) {
    errors.push('question must be 1200 characters or less');
  }

  if (!SUPPORTED_DEPTHS.includes(depth)) {
    errors.push(`depth must be one of: ${SUPPORTED_DEPTHS.join(', ')}`);
  }

  if (!SUPPORTED_REPORT_TYPES.includes(reportType)) {
    errors.push(`report_type must be one of: ${SUPPORTED_REPORT_TYPES.join(', ')}`);
  }

  if (outputFormat !== 'json') {
    errors.push('output_format must be json');
  }

  if (input.constraints && (typeof input.constraints !== 'object' || Array.isArray(input.constraints))) {
    errors.push('constraints must be an object when provided');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      target,
      question,
      depth,
      report_type: reportType,
      output_format: outputFormat,
      constraints,
    },
  };
}

export function normalizeReportType(value) {
  const reportType = normalizeString(value);
  return REPORT_TYPE_ALIASES[reportType] || reportType;
}

export function validateAnalyzeResponse(report) {
  const errors = [];

  for (const key of ['report_id', 'report_type', 'target', 'question', 'summary', 'confidence', 'generated_at']) {
    if (!report[key] || typeof report[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  }

  for (const key of ['market_signals', 'opportunities', 'risks', 'competitors', 'recommended_actions', 'sources']) {
    if (!Array.isArray(report[key])) {
      errors.push(`${key} must be an array`);
    }
  }

  if (!report.cost_estimate || typeof report.cost_estimate !== 'object') {
    errors.push('cost_estimate must be an object');
  }

  if (!report.payment || typeof report.payment !== 'object') {
    errors.push('payment must be an object');
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export const analyzeRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'question'],
  properties: {
    target: {
      type: 'string',
      minLength: 1,
      maxLength: 240,
      description: 'Project, service, market, wallet, protocol, or URL to analyze.',
      examples: ['Tempo', 'https://mppscan.com', 'auto.exchange'],
    },
    question: {
      type: 'string',
      minLength: 1,
      maxLength: 1200,
      description: 'Decision question the report should answer.',
      examples: ['Is this niche worth building a paid agent for?'],
    },
    depth: {
      type: 'string',
      enum: SUPPORTED_DEPTHS,
      default: 'quick',
    },
    report_type: {
      type: 'string',
      enum: SUPPORTED_REPORT_TYPES,
      default: 'opportunity_report',
    },
    output_format: {
      type: 'string',
      enum: ['json'],
      default: 'json',
    },
    constraints: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional constraints such as region, budget, target customer, or launch timeline.',
    },
  },
};

export const analyzeResponseJsonSchema = {
  type: 'object',
  required: [
    'report_id',
    'report_type',
    'target',
    'question',
    'summary',
    'confidence',
    'market_signals',
    'opportunities',
    'risks',
    'competitors',
    'recommended_actions',
    'sources',
    'cost_estimate',
    'payment',
    'generated_at',
  ],
  properties: {
    report_id: { type: 'string' },
    report_type: { type: 'string' },
    target: { type: 'string' },
    question: { type: 'string' },
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    market_signals: { type: 'array', items: { type: 'object' } },
    opportunities: { type: 'array', items: { type: 'object' } },
    risks: { type: 'array', items: { type: 'object' } },
    competitors: { type: 'array', items: { type: 'object' } },
    recommended_actions: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'object' } },
    cost_estimate: { type: 'object' },
    payment: { type: 'object' },
    generated_at: { type: 'string' },
  },
};

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}
