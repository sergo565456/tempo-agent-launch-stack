import { analyzeRequestJsonSchema, analyzeResponseJsonSchema } from './schemas/analyze.js';
import { getDiscoveryOffers } from './payments/adapters.js';

const REPORT_OPERATIONS = [
  {
    path: '/v1/analyze',
    operationId: 'createOpportunityReport',
    summary: 'Create a paid opportunity report.',
    description: 'Evaluates whether a paid agent, MPP, x402, Venice, or MCP service idea is worth building.',
    reportType: 'opportunity_report',
  },
  {
    path: '/v1/launch-readiness',
    operationId: 'createLaunchReadinessReport',
    summary: 'Create a paid launch readiness report.',
    description: 'Checks whether a paid API or MCP-style service is ready for MPP/x402 discovery and listing.',
    reportType: 'launch_readiness_report',
  },
  {
    path: '/v1/service-diligence',
    operationId: 'createServiceDiligenceReport',
    summary: 'Create a paid service due diligence report.',
    description: 'Evaluates an existing paid MPP/x402 service before an agent depends on it or pays it.',
    reportType: 'service_diligence_report',
  },
  {
    path: '/v1/ecosystem-fit',
    operationId: 'createEcosystemFitReport',
    summary: 'Create a paid ecosystem fit report.',
    description: 'Compares Tempo MPP, Base x402, Venice, MCP, and agent directories for a launch target.',
    reportType: 'ecosystem_fit_report',
  },
];

export function buildOpenApi(config) {
  const baseUrl = config.publicBaseUrl;
  const paths = {
    '/health': buildHealthPath(),
    '/openapi.json': buildOpenApiPath(),
    '/llms.txt': buildTextDiscoveryPath('Machine-readable service guidance for LLM agents.'),
    '/.well-known/agent-card.json': buildJsonDiscoveryPath('Machine-readable agent card.'),
    '/.well-known/x402': buildJsonDiscoveryPath('x402-compatible discovery document.'),
    '/v1/reports/{report_id}': buildGetReportPath(),
  };

  for (const operation of REPORT_OPERATIONS) {
    paths[operation.path] = {
      post: buildReportPostOperation(config, operation),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent Launch Intel API',
      version: '0.2.0',
      summary: 'Paid launch and diligence reports for agent-payment builders.',
      description: 'A machine-readable paid report API for builders launching x402, MPP, Tempo, Venice, and MCP agent services.',
      contact: {
        email: 'sergo565456@gmail.com',
      },
      'x-guidance': 'Call a report endpoint with a target and decision question. If the server returns 402, pay using the advertised Tempo MPP offer and retry the same request with the same Idempotency-Key. Use GET /v1/reports/{report_id} with the original Idempotency-Key or receipt_id proof to retrieve a paid report.',
    },
    'x-discovery': {
      ownershipProofs: [
        'https://github.com/sergo565456/tempo-agent-launch-stack',
        'https://www.mppscan.com/server/829a2ec0cd95651c49881e21e918a2635f6eea7e9454df284c095821b2f1a893',
      ],
    },
    externalDocs: {
      url: 'https://github.com/sergo565456/tempo-agent-launch-stack',
      description: 'Public source, launch notes, and operator documentation.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        reportAccessProof: {
          type: 'apiKey',
          in: 'header',
          name: 'Idempotency-Key',
          description: 'Original paid report Idempotency-Key. A receipt_id query parameter is also accepted for paid report retrieval.',
        },
      },
    },
    paths,
  };
}

function buildReportPostOperation(config, operation) {
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: `${operation.description} In local mock mode, retry with X-Mock-Payment: paid.`,
    'x-payment-info': buildPaymentInfo(config, 'quick'),
    parameters: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Recommended. Reuse the same key when retrying after payment to avoid duplicate report records.',
      },
      {
        name: 'X-Mock-Payment',
        in: 'header',
        required: false,
        schema: { type: 'string', enum: ['paid'] },
        description: 'Local mock mode only. Use `paid` to simulate a paid retry.',
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            ...analyzeRequestJsonSchema,
            properties: {
              ...analyzeRequestJsonSchema.properties,
              report_type: {
                type: 'string',
                enum: [operation.reportType],
                default: operation.reportType,
                description: 'Optional for typed endpoints. The route sets this value.',
              },
            },
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Structured report generated successfully.',
        content: {
          'application/json': {
            schema: analyzeResponseJsonSchema,
          },
        },
      },
      '400': {
        description: 'Invalid request.',
      },
      '402': {
        description: 'Payment required before report generation.',
      },
      '409': {
        description: 'Idempotency key was reused with a different request body.',
      },
      '501': {
        description: 'Selected live payment rail is scaffolded but not configured.',
      },
    },
  };
}

function buildHealthPath() {
  return {
    get: {
      operationId: 'healthCheck',
      summary: 'Check service health.',
      security: [],
      responses: {
        '200': {
          description: 'Service is healthy.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  service: { type: 'string' },
                  payment_mode: { type: 'string' },
                  payment_rails: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildOpenApiPath() {
  return {
    get: {
      operationId: 'getOpenApi',
      summary: 'Fetch OpenAPI discovery.',
      security: [],
      responses: {
        '200': {
          description: 'OpenAPI document.',
        },
      },
    },
  };
}

function buildTextDiscoveryPath(summary) {
  return {
    get: {
      operationId: 'getLlmsText',
      summary,
      security: [],
      responses: {
        '200': {
          description: summary,
          content: {
            'text/plain': {
              schema: { type: 'string' },
            },
          },
        },
      },
    },
  };
}

function buildJsonDiscoveryPath(summary) {
  return {
    get: {
      summary,
      security: [],
      responses: {
        '200': {
          description: summary,
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
      },
    },
  };
}

function buildGetReportPath() {
  return {
    get: {
      operationId: 'getReport',
      summary: 'Fetch a stored report by id.',
      security: [{ reportAccessProof: [] }],
      parameters: [
        {
          name: 'report_id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Live payment modes require either this original report idempotency key or receipt_id proof.',
        },
        {
          name: 'receipt_id',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Live payment modes require either this payment receipt id or the original Idempotency-Key.',
        },
      ],
      responses: {
        '200': {
          description: 'Stored report record.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  report: analyzeResponseJsonSchema,
                  metadata: { type: 'object' },
                },
              },
            },
          },
        },
        '404': {
          description: 'Report not found.',
        },
        '401': {
          description: 'Report access proof is required in live payment modes.',
        },
      },
    },
  };
}

function buildPaymentInfo(config, depth) {
  const offers = getDiscoveryOffers(config, depth);
  const primaryOffer = offers[0] || {};
  const amountUsd = primaryOffer.amount_usd || config.pricesUsd?.[depth] || '0.01';

  return {
    price: {
      mode: 'fixed',
      currency: 'USD',
      amount: amountUsd,
    },
    protocols: offers.map((offer) => {
      if (offer.method === 'tempo') {
        return {
          mpp: {
            method: 'tempo',
            intent: offer.intent || 'charge',
            currency: offer.currency || '',
          },
        };
      }

      if (offer.method === 'x402') {
        return { x402: {} };
      }

      return {
        [offer.method || 'payment']: {
          intent: offer.intent || 'charge',
          currency: offer.currency || '',
        },
      };
    }),
    offers,
  };
}
