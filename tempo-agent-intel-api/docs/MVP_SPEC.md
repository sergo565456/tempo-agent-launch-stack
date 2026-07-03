# MVP Specification

## One-Line Product

Agent Intel API sells concise, sourced, structured intelligence reports to humans and agents through a paid MPP-compatible HTTP endpoint.

## Target User

1. Builders exploring Tempo, MPP, x402, crypto, AI-agent, and payment-agent opportunities.
2. Agents that need a paid specialist tool for market or protocol analysis.
3. Small teams that want quick diligence before building a niche product.

## Core Endpoint

```http
POST /v1/analyze
```

Example request:

```json
{
  "target": "MPPScan",
  "question": "Are there underserved niches for a paid analytical agent on Tempo?",
  "depth": "standard",
  "output_format": "json"
}
```

Example response:

```json
{
  "summary": "Short conclusion for decision makers.",
  "confidence": "medium",
  "market_signals": [
    {
      "signal": "MPPScan shows live paid usage across hundreds of servers.",
      "importance": "high",
      "source": "https://mppscan.org/"
    }
  ],
  "opportunities": [
    {
      "name": "Paid MPP service reputation scanner",
      "why_now": "Agents need reliable endpoint selection before spending.",
      "difficulty": "medium",
      "monetization": "pay-per-report or subscription"
    }
  ],
  "risks": [
    {
      "risk": "Market is still early and payment volume is small.",
      "mitigation": "Start with low-cost reports and direct distribution."
    }
  ],
  "competitors": [],
  "recommended_actions": [
    "Build a narrow paid report endpoint.",
    "Publish OpenAPI discovery.",
    "Register in MPPScan after runtime 402 validation."
  ],
  "sources": []
}
```

## Depth Tiers

```text
quick     $0.01        1-3 sources, short conclusion
standard  $2-$5        5-10 sources, structured report
deep      $10-$30      broader research, competitor table, source appendix
```

Final prices should be tested low first. The goal is to validate paid calls, not maximize revenue on day one.

## Payment Flow

1. Client calls `POST /v1/analyze`.
2. Server returns `402 Payment Required` if no valid payment credential is present.
3. Client pays through MPP/Tempo or another supported rail later.
4. Client retries the same request with payment authorization.
5. Server verifies payment.
6. Server runs the report.
7. Server returns JSON plus payment receipt metadata.

## Discovery Requirements

Expose:

```text
GET /openapi.json
```

The OpenAPI document must include:

- request and response schemas;
- `402` response;
- `x-payment-info`;
- high-level `info.x-guidance`;
- stable operation IDs;
- clear descriptions written for agent clients.

## Internal Cost Tracking

Every report run should store:

- request id;
- user or agent id if known;
- paid amount;
- external tool costs;
- LLM cost estimate;
- sources used;
- latency;
- final status;
- margin estimate.

This is internal only in MVP, but it becomes the seed for the later spend-control product.

## Quality Bar

A paid report is useful only if it is better than a single generic prompt. The MVP must provide:

- sourced claims;
- structured output;
- explicit confidence;
- direct recommendations;
- clear caveats;
- repeatable schema.
