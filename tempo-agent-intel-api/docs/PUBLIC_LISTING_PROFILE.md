# Public Listing Profile

Updated: 2026-07-02

This file is intentionally non-secret. It is the draft package for MPPScan, mpp.land-style registries, x402 directories, and agent catalog listings.

## Public URLs

```text
agent:  https://tempo-agent-intel-api.vercel.app
signer: https://tempo-outbound-signer.vercel.app
```

Use the canonical agent URL for listings. Direct deployment URLs are not the listing target because Vercel may protect them behind account auth.

Current agent deployment:

```text
deployment_id: dpl_DzXbWiGovkEfgen4ndKqYAdu9oUE
status:        Ready
runtime:       Vercel Functions
payment_mode:  Tempo live inbound
outbound:      remote signer, live enabled
```

Runtime flags:

```text
TEMPO_MPP_LIVE_ENABLED=true
OUTBOUND_LIVE_PAYMENTS=true
ENABLE_OUTBOUND_CRON=true
OUTBOUND_PAYMENT_PROVIDER=remote_signer
OUTBOUND_ALLOW_DYNAMIC_MPP_RECIPIENT=false
```

## Listing Status

```text
ready_for_listing: true
current_blocker: none
```

The production runtime is live, priced, autonomous outbound-capable, and has verified public inbound, manual outbound, and authorized cron payment evidence. Directory submission is now an owner-review/manual-submit step.

The current quick inbound challenge is:

```text
amount: 0.01 USDC.e
receiver: 0xF952062e566fBDcF49d04935aD1ffe3A67a341A9
network: Tempo
```

Verified public inbound payment:

```text
idempotency_key: public-live-tempo-inbound-1782956789317
report_id:       rpt_mr2ufu1j_cfec1a6e3cab478d
amount:          0.25 USDC.e
receiver:        0xF952062e566fBDcF49d04935aD1ffe3A67a341A9
tx:              0x3e5fcb040ecca9ddbcf3e421f1bd5fa5001029ff0f295b9c4d49dde0ba2fa001
status:          paid / payment_verified
```

## Verified Public Discovery

```text
GET /health
GET /openapi.json
GET /llms.txt
GET /.well-known/agent-card.json
GET /.well-known/x402
GET /v1/runtime/tempo-readiness
```

OpenAPI paid endpoint price:

```text
POST /v1/analyze            0.01 USDC.e
POST /v1/launch-readiness   0.01 USDC.e
POST /v1/service-diligence  0.01 USDC.e
POST /v1/ecosystem-fit      0.01 USDC.e
```

Launch pricing tiers:

```text
quick:    0.01 USDC.e
standard: 0.05 USDC.e
deep:     0.25 USDC.e
```

Discovery profile:

```text
payment method: tempo
currency:       0x20c000000000000000000000b9537d11c60e8b50
receiver:       0xF952062e566fBDcF49d04935aD1ffe3A67a341A9
durable store:  Upstash Redis
```

## Verified Outbound Evidence

Manual public outbound payment:

```text
idempotency_key: local-codex-live-20260701-003
agent_event:     payevt_9b1f1f72-0773-4412-9fc2-fc964956cbcd
event_type:      outbound_admin_payment_succeeded
trigger:         admin_manual
service:         graph.codex.io
endpoint:        https://graph.codex.io/graphql
amount:          1000 base units
tx:              0xc95878f29e445ea9344757f09bd4288045d7c7dca7f2030220c87395414b06c2
```

Autonomous cron public outbound payment:

```text
idempotency_key: cron-codex-graphql-2026-07-01
agent_event:     payevt_30ee5961-f6c4-466f-9b76-987ddedf6e76
event_type:      outbound_cron_payment_succeeded
trigger:         vercel_cron
service:         graph.codex.io
endpoint:        https://graph.codex.io/graphql
amount:          1000 base units
tx:              0x3e6f2a163012c6a02b43f98f4cb63c6b77e8e2357f86af7e195f0c8a2c82a217
```

Both transactions were read-only reconciled on Tempo:

```text
chain_id: 4217
transfer_from: 0x631d167128B76089Db346C823be4E0062c3a5873
transfer_to:   0xc12B5D802Da90d14a8b35dEc1cFb6fd5ceeDE60B
amount:        1000 base units
fee:           1071 base units
status:        0x1
```

Cron readiness:

```text
enabled:                 true
auth gated:              true
unauthorized cron route: HTTP 401
arming idempotency key:  local-codex-live-20260701-003
```

## Service Description

Short:

```text
Agent Launch Intel API sells structured launch, diligence, and ecosystem-fit reports for builders creating paid agent services across Tempo MPP, Base x402, Venice, MCP, and agent directories.
```

Long:

```text
Agent Launch Intel API helps builders and agents decide what to build, where to list, and which paid APIs are safe to depend on. It returns structured reports with opportunity scoring, launch-readiness checks, service diligence, ecosystem-fit comparisons, risk notes, pricing guidance, and next actions.
```

## Listing Copy

Name:

```text
Agent Launch Intel API
```

Category:

```text
Agent Commerce / Analytics / Developer Tooling
```

Discovery:

```text
https://tempo-agent-intel-api.vercel.app/llms.txt
https://tempo-agent-intel-api.vercel.app/openapi.json
https://tempo-agent-intel-api.vercel.app/.well-known/agent-card.json
https://tempo-agent-intel-api.vercel.app/.well-known/x402
```

One-line pitch:

```text
Paid launch intelligence for builders shipping Tempo MPP, Base x402, Venice, MCP, and other agent-commerce services.
```

Safety note:

```text
The service never loads an owner/root wallet. Public inbound Tempo MPP is live. Autonomous outbound spending uses a separate remote signer, strict service/endpoint/recipient caps, durable ledgers, and cron arming from a verified manual outbound payment.
```

Submit only after:

```text
public Tempo MPP 402 challenge: verified
public inbound paid retry: verified
manual outbound remote-signer payment: verified
authorized cron payment: verified
receipt / tx reference: verified for outbound
OpenAPI x-payment-info: verified
listing readiness gate: ready_for_listing=true
```

## Next Listing Gate Command

Latest verified listing gate command:

```text
$env:EXPECTED_OUTBOUND_SERVICE='graph.codex.io'
$env:EXPECTED_OUTBOUND_COMMAND='codex_graphql_query'
$env:EXPECTED_OUTBOUND_ENDPOINT='https://graph.codex.io/graphql'
$env:EXPECTED_OUTBOUND_RECIPIENT='0xc12B5D802Da90d14a8b35dEc1cFb6fd5ceeDE60B'
$env:EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS='1000'
npm run listing:readiness -- --agent-url https://tempo-agent-intel-api.vercel.app --signer-url https://tempo-outbound-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-1782956789317 --inbound-report-id rpt_mr2ufu1j_cfec1a6e3cab478d --outbound-idempotency-key local-codex-live-20260701-003 --expected-cron-idempotency-key cron-codex-graphql-2026-07-02 --expected-standard-price-usd 0.01
```

The listing gate is read-only. It performs GET-only discovery checks, composes verified launch evidence, and refuses listing readiness unless the launch stage is `ready_for_listing_review` and each paid report endpoint advertises the expected cheap launch price.

## Residual Risks

```text
shared_upstash_backend: accepted for this no-card production path; agent/signer use distinct production prefixes, but the shared Upstash token can access both namespaces if compromised.
signer_access_key_expiry: current signer Access Key expires 2026-07-04T06:57:55Z. A fresh Access Key plan was generated, but Turnkey API-only user cannot create the required one-time authorizeKey policy. Owner-level Turnkey policy creation is needed to complete rotation.
local_vercel_edge_timeout: previously observed on this workstation, but the latest public readiness, reconciliation, and listing checks passed through the canonical Vercel aliases without changing system proxy/DNS settings.
```
