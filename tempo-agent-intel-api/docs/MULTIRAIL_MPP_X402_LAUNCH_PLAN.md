# Multi-Rail MPP / x402 Launch Plan

Updated: 2026-06-05

## Goal

Refactor `Tempo Agent Intel API` from a local mock-paid Tempo/MPP research MVP into a real payment-native agent service.

The target product is:

```text
Agent Launch Intel API
```

It sells launch and diligence reports for builders creating paid agent services across:

- Tempo / MPP;
- Base / x402;
- Venice / x402 / MCP;
- agent marketplaces and directories;
- MPPScan and x402 discovery surfaces.

## Final Product Shape

One service, multiple payment rails:

```text
POST /v1/analyze
POST /v1/launch-readiness
POST /v1/service-diligence
POST /v1/ecosystem-fit
```

Payments:

```text
Tempo MPP charge
Base x402 charge
mock mode for local testing
```

The agent may later use external paid Tempo MPP services through a strict spend policy:

```text
Agent runtime
  -> Spend policy / allowlist
  -> Tempo MPP paid services
  -> Receipt + cost ledger
```

## Phase 1 - Reposition The Product

Rename the working concept from:

```text
Tempo Agent Intel API
```

to:

```text
Agent Launch Intel API
```

Keep the package folder name for now unless a public rebrand is needed.

Update public copy:

```text
Paid intelligence API for builders launching x402, MPP, Tempo, Venice, and MCP agent services.
```

Core promise:

```text
Find the right agent-payment niche, prepare a paid endpoint for discovery, and verify launch readiness before spending.
```

## Phase 2 - Split Report Types

Current endpoint:

```text
POST /v1/analyze
```

Keep it as a general wrapper, but internally route to typed reports:

### 1. Opportunity Report

Use when the customer asks:

```text
Should I build this paid agent service?
Where is the demand?
What is the pricing?
Who are the competitors?
```

Output:

- market signals;
- competitors;
- monetization paths;
- risks;
- recommended first paid endpoint.

### 2. Launch Readiness Report

Use when the customer has an API/MCP service and wants to list it.

Checks:

- OpenAPI presence;
- `402` behavior;
- `x-payment-info`;
- `llms.txt`;
- MCP docs or tool manifest;
- pricing clarity;
- listing copy;
- examples;
- receipt/idempotency behavior.

### 3. Service Diligence Report

Use when the customer wants to evaluate an existing paid MPP/x402 service.

Checks:

- endpoint availability;
- pricing;
- directory presence;
- last activity;
- visible usage/volume where available;
- discovery quality;
- likely buyer;
- differentiation.

### 4. Ecosystem Fit Report

Use when the customer asks where to launch.

Compares:

- Tempo MPP;
- Base x402;
- Venice ecosystem;
- MPPScan;
- x402 directories;
- auto.exchange;
- MCP marketplaces.

## Phase 3 - Refactor Payment Layer

Replace the current `mockPayment.js` shape with a rail-agnostic payment interface:

```text
PaymentAdapter
  - createChallenge(request)
  - verifyCredential(request)
  - attachReceipt(result)
  - discoveryOffers()
```

Adapters:

```text
MockPaymentAdapter
TempoMppChargeAdapter
BaseX402ChargeAdapter
```

Environment:

```text
PAYMENT_MODE=mock|tempo|x402|multi
ENABLED_PAYMENT_RAILS=tempo,x402
RECEIVE_TEMPO_ADDRESS=
RECEIVE_BASE_ADDRESS=
MAX_REPORT_PRICE_USD=
```

Keep `mock` mode as the default for local tests.

## Phase 4 - Update Discovery

OpenAPI must advertise multiple offers using the current multi-offer `x-payment-info` shape:

```json
{
  "x-payment-info": {
    "offers": [
      {
        "method": "tempo",
        "intent": "charge",
        "amount": "250000",
        "currency": "0x20c000000000000000000000b9537d11c60e8b50"
      },
      {
        "method": "x402",
        "intent": "charge",
        "amount": "250000",
        "currency": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "network": "base"
      }
    ]
  }
}
```

Add:

```text
GET /llms.txt
GET /.well-known/agent-card.json
GET /.well-known/x402
```

Goal:

- MPPScan can index it;
- x402 directories can index it;
- agents can understand the price before calling;
- humans can read how to pay and what they get.

## Phase 5 - Real MPP Service Integration

Tempo MPP:

1. Recheck current `mppx` docs.
2. Install/configure `mppx`.
3. Add `tempo.charge()`.
4. Replace mock `402` only behind `PAYMENT_MODE=tempo` or `multi`.
5. Attach payment hooks:
   - challenge created;
   - payment success;
   - payment failed;
   - receipt reference.
6. Store all payment events in the ledger.

Do not use an expired Access Key. Generate or configure a fresh wallet/access key before live tests.

## Phase 6 - Base x402 Integration

Base x402:

1. Recheck current x402 docs.
2. Add x402 middleware or a small adapter around the facilitator flow.
3. Use Base USDC receive address.
4. Start on testnet or a tiny mainnet price.
5. Verify:
   - unpaid request returns `402`;
   - paid retry returns `200`;
   - receipt/reference is stored;
   - replay does not return a second paid result.

## Phase 7 - Inbound Revenue Wallet Design

Separate wallets:

```text
Inbound revenue wallet
Outbound agent-spend wallet
Owner treasury/root wallet
```

Rules:

- inbound revenue wallet only receives report payments;
- outbound wallet has tiny balance and daily cap;
- owner treasury is never loaded into runtime;
- no root key in app env;
- no private key in docs or git.

## Phase 8 - Let Agent Use Tempo MPP Services

This is outbound spend and must be guarded separately from receiving report payments.

First allowlist:

```text
search/scrape provider
MPPScan/service directory fetch
maybe one LLM/inference endpoint
```

Add an internal spend policy:

```json
{
  "live_outbound_enabled": false,
  "max_per_call_usd": "0.05",
  "max_daily_usd": "0.50",
  "allowed_services": [
    "parallelmpp.dev",
    "firecrawl",
    "mpp.dev",
    "mppscan.org"
  ],
  "deny_unknown_services": true
}
```

Flow:

1. Agent plans source gathering.
2. Cost estimator predicts downstream MPP spend.
3. Spend policy approves/rejects.
4. Agent pays allowed service.
5. Receipt is stored.
6. Final customer report includes a cost ledger summary.

No live outbound spending until inbound paid service is verified.

## Phase 9 - Deployment Without Home IP

Preferred first deploy:

```text
Vercel Functions or Cloudflare Workers
```

Reason:

- user PC can be off;
- no home IP exposure;
- public URL for MPPScan/x402 directories;
- easy env separation.

Deployment requirements:

- `PUBLIC_BASE_URL`;
- receive wallet env values;
- no root wallet;
- no expired Access Key;
- secret scan before deploy;
- public OpenAPI and `llms.txt`;
- health check.

## Phase 10 - Security Audit

Run security audit before any live payment or public listing.

Audit scope:

- payment bypass;
- replay/double fulfillment;
- idempotency conflicts;
- challenge/result binding;
- receipt verification;
- pricing tampering;
- PII leakage in payment metadata;
- private key leakage;
- `.secrets`, `.env`, `.data` exposure;
- OpenAPI claims vs runtime behavior;
- outbound spend policy bypass;
- SSRF through source fetching;
- prompt injection causing paid calls;
- downstream paid-service allowlist bypass.

Minimum checks:

```text
node --test
secret scan
privacy/local-only check
OpenAPI discovery check
mock unpaid/paid smoke
live-mode dry run
dependency audit after adding SDKs
manual code review of payment adapters
```

Use the Codex Security workflow for a full scan before public launch.

## Phase 11 - Controlled Live Payment Test

Inbound payment test:

1. Deploy public URL.
2. Call `POST /v1/launch-readiness` without payment.
3. Confirm `402`.
4. Pay tiny amount:

```text
$0.01-$0.05
```

5. Retry with payment credential.
6. Confirm `200`.
7. Confirm report generated.
8. Confirm receipt stored.
9. Confirm no duplicate fulfillment on replay.
10. Confirm funds received.

Outbound Tempo MPP test:

1. Keep `ENABLE_OUTBOUND_CRON=false`.
2. Use `OUTBOUND_PAYMENT_PROVIDER=remote_signer`; do not put `AGENT_ACCESS_KEY_PRIVATE_KEY` in the public agent runtime.
3. Dry-run source plan.
4. Enable one allowlisted provider only.
5. Set:

```text
OUTBOUND_LIVE_PAYMENTS=true
OUTBOUND_PAYMENT_PROVIDER=remote_signer
OUTBOUND_DENY_UNKNOWN_SERVICES=true
```

6. Keep first-live caps:

```text
MAX_OUTBOUND_PER_CALL_USD=0.01
MAX_OUTBOUND_DAILY_USD=0.05
```

7. Run one paid downstream call only through the guarded public launch flow with explicit owner confirmation.
8. Verify signer ledger, agent payment ledger, wallet balance delta, and receipt.
9. Leave cron disabled until `public-cron-arming-readiness.js` proves the manual outbound event can arm autonomous spend.

Do not switch `OUTBOUND_LIVE_PAYMENTS` back to false for the production autonomous launch path; it is still gated by admin token, explicit confirmation for manual calls, signer policy, idempotency, and cron arming.

## Phase 12 - Public Listing

Only after successful live tests:

1. Register on MPPScan.
2. Prepare x402 directory/Bazaar-style listing.
3. Prepare Built-in-Venice-style submission if Venice integration is real.
4. Publish example reports.
5. Add docs:
   - pricing;
   - endpoints;
   - payment methods;
   - privacy;
   - refund/error behavior;
   - receipt verification.

## Recommended Build Order

1. Product rename/copy update.
2. Add typed report endpoints.
3. Add rail-agnostic payment adapter interface.
4. Keep mock adapter passing all tests.
5. Add OpenAPI multi-offer discovery.
6. Add `llms.txt`.
7. Add Tempo MPP adapter.
8. Add Base x402 adapter.
9. Add payment event ledger.
10. Add outbound spend policy in dry-run mode.
11. Add deploy config.
12. Run security audit.
13. Run inbound live payment.
14. Run outbound Tempo MPP micro-call.
15. Register/list publicly.

## Hard Stop Points

Stop and require explicit approval before:

- installing new payment SDKs if network access is required;
- configuring real receiving wallets;
- generating or authorizing a new Access Key;
- deploying a public URL;
- running the first real inbound payment;
- enabling outbound live payments;
- registering in MPPScan/x402 directories;
- submitting to Built in Venice.
