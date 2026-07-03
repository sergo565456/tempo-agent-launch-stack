# Development Plan

## Goal

Build a paid analytical agent as an MPP-compatible API. The MVP should prove three things:

1. A customer or external agent can discover the API.
2. A customer or external agent can pay for one report.
3. The report is useful enough that someone would pay again.

## Phase 0 - Product Narrowing

Decide the first exact report type before writing production code.

Recommended first report:

```text
Tempo/MPP opportunity report
```

Input:

- target name or URL;
- question;
- depth: `quick`, `standard`, `deep`;
- optional constraints, such as budget, geography, or category.

Output:

- summary;
- market signals;
- monetization paths;
- competitors;
- risks;
- recommended actions;
- sources.

Do not start with every possible analysis type. Add more only after paid calls exist.

## Phase 1 - Project Skeleton

Create a small HTTP API service.

Suggested stack:

- TypeScript;
- Hono or Fastify;
- `mppx` for MPP payment middleware;
- Zod for request and response validation;
- SQLite for local run/payment logs during MVP;
- OpenAPI generation or a hand-maintained `openapi.json`.

Initial routes:

```text
GET  /health
GET  /openapi.json
POST /v1/analyze
GET  /v1/reports/:id
```

Keep the server stateless except for run logs and report cache.

## Phase 2 - Report Engine

Implement a deterministic pipeline:

1. Validate request.
2. Build research plan.
3. Gather sources.
4. Extract facts.
5. Score opportunities and risks.
6. Generate structured response.
7. Validate response schema.
8. Store report and cost metadata.

Start with web/source gathering as a pluggable interface:

```text
SearchProvider
PageFetchProvider
LLMProvider
CostTracker
ReportStore
```

This keeps the paid API independent from any one vendor.

## Phase 3 - Payment Integration

Protect `POST /v1/analyze` with MPP.

Pricing should map to depth:

```text
quick     fixed price
standard  fixed price
deep      fixed price, later dynamic/session
```

For MVP, fixed charges are simpler than sessions. Sessions can come later for long streaming reports.

Implementation requirements:

- valid `402` challenge;
- idempotency key support;
- no double charge for retries;
- payment receipt attached to report log;
- failed payment events logged without secrets.

## Phase 4 - Discovery And Registration Readiness

Before MPPScan registration, make discovery pass locally.

Checklist:

- `/openapi.json` exists;
- paid endpoint has `x-payment-info`;
- paid endpoint declares `402`;
- request schema is complete;
- response schema is complete;
- `info.x-guidance` explains how an agent should use the API;
- runtime `402` behavior matches OpenAPI metadata.

Validation target:

```text
npx -y @agentcash/discovery@latest discover "$TARGET_URL"
npx -y @agentcash/discovery@latest check "$TARGET_URL"
```

After validation, register the base URL in MPPScan.

## Phase 5 - First Launch

Launch with a tiny, specific promise:

```text
Paid Tempo/MPP market intelligence reports for builders and agents.
```

Distribution:

- MPPScan registration;
- auto.exchange listing if the API-agent format fits;
- a simple landing page with 3 example reports;
- direct outreach to builders in MPP/Tempo/x402 ecosystem;
- posts showing real MPPScan/market observations.

Do not rely only on directory traffic. Early MPP volume is real but still small.

## Phase 6 - Measurement

Track:

- paid requests;
- unpaid probes;
- conversion from `402` challenge to paid retry;
- average revenue per report;
- average tool/LLM cost per report;
- gross margin;
- report latency;
- repeat users;
- which questions people ask.

Early success target:

```text
10 paid reports from non-test users
gross margin positive on standard reports
at least 2 repeat users or agents
```

## Phase 7 - Expansion

Only after the first report type gets usage, add adjacent report types:

1. MPP service reputation report.
2. Crypto/project due-diligence report.
3. Onchain wallet behavior report.
4. Prediction-market opportunity report.

Each new report type should reuse the same payment, discovery, logging, and schema system.

## Phase 8 - Bridge To Variant 2

While running reports, we will already collect internal spend data. Turn that into the future B2B product later:

- per-report cost ledger;
- paid API receipt storage;
- service allowlist;
- price and reliability observations;
- budget policy experiments.

This becomes the foundation for the agent spend firewall, but it should stay internal during variant 1.

## MVP Build Order

1. Create HTTP server.
2. Add schemas.
3. Add report stub returning deterministic mock data.
4. Add OpenAPI discovery.
5. Add local storage.
6. Add real report pipeline.
7. Add MPP payment gate.
8. Add idempotency and receipts.
9. Run discovery validation.
10. Deploy.
11. Register in MPPScan.
12. List on auto.exchange if suitable.

## Biggest Risks

1. Reports are too generic.
   Mitigation: force sources, scores, direct recommendations, and structured output.

2. Directory traffic is too small.
   Mitigation: combine MPPScan with direct distribution and example reports.

3. Tool costs eat margin.
   Mitigation: start with fixed report depth and hard cost caps.

4. Payment integration breaks agent clients.
   Mitigation: validate OpenAPI and runtime `402` before registration.

5. Scope expands into a full platform too early.
   Mitigation: one paid endpoint first.

## Definition Of Done For MVP

- A public URL serves `/health`.
- `/openapi.json` passes discovery checks.
- `POST /v1/analyze` is payment-gated.
- A paid request returns a structured report.
- Report logs include amount paid, cost estimate, receipt reference, and status.
- The API is registered on MPPScan.
- There are at least three example reports for marketing and testing.

