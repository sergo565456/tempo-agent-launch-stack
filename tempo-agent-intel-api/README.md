# Agent Launch Intel API

Paid intelligence API for builders launching x402, MPP, Tempo, Venice, and MCP agent services.

This folder is intentionally separate from the spend-firewall work. The first product is a narrow paid API/MCP-style agent that sells structured reports. Internally it will track tool costs and receipts, but the external product is intelligence-as-an-API.

## Product

The MVP now exposes four paid report endpoints:

```text
POST /v1/analyze
POST /v1/launch-readiness
POST /v1/service-diligence
POST /v1/ecosystem-fit
```

They accept a target project, market, wallet, protocol, or service and return structured decision reports with sources, risks, opportunities, competitors, launch checks, diligence checks, ecosystem fit, and recommended next actions.

## First Niche

Start with launch intelligence for paid agent services:

- Is this x402/MPP/Tempo/Venice niche worth building?
- Is a paid API ready to list in MPPScan, x402 directories, or MCP/Venice surfaces?
- Which existing paid services are safe enough for agents to depend on?
- Which payment ecosystem should the service launch in first?
- What pricing, discovery, receipt, and safety work is missing?

This is narrower than a generic research agent and gives us a clearer reason for users and other agents to pay.

## Documents

- [Development plan](docs/DEVELOPMENT_PLAN.md)
- [Autonomous execution plan](docs/AUTONOMOUS_EXECUTION_PLAN.md)
- [MVP specification](docs/MVP_SPEC.md)
- [Root wallet and Access Key setup](docs/ROOT_ACCESS_KEY_SETUP.md)
- [Multi-rail MPP / x402 launch plan](docs/MULTIRAIL_MPP_X402_LAUNCH_PLAN.md)
- [Security audit checklist](docs/SECURITY_AUDIT_CHECKLIST.md)
- [Deployment and live payment runbook](docs/DEPLOYMENT_LIVE_PAYMENT_RUNBOOK.md)
- [Recommended remote signer path](docs/RECOMMENDED_REMOTE_SIGNER_PATH.md)
- [Public listing profile](docs/PUBLIC_LISTING_PROFILE.md)
- [Repository public quickstart](../docs/PUBLIC_QUICKSTART.md)
- [Listing and launch pack](../docs/LISTING_AND_LAUNCH_PACK.md)

## Current Local MVP

The first local implementation is intentionally zero-dependency Node.js. It already includes:

- `GET /health`;
- `GET /openapi.json`;
- `GET /llms.txt`;
- `GET /.well-known/agent-card.json`;
- `GET /.well-known/x402`;
- `POST /v1/analyze`;
- `POST /v1/launch-readiness`;
- `POST /v1/service-diligence`;
- `POST /v1/ecosystem-fit`;
- `GET /v1/reports/:id`;
- mock `402 Payment Required` flow;
- idempotency-key handling;
- rail-agnostic payment adapter scaffolding for `mock`, `tempo`, `x402`, and `multi`;
- outbound Tempo MPP spend policy with remote-signer mode as the safe live path;
- file-backed report storage under `.data/` locally and runtime temp storage on Vercel;
- Vercel serverless adapter under `api/index.js`;
- local tests and smoke test.

Live Tempo MPP and Base x402 modes are intentionally scaffolded but blocked unless SDK dependencies, recipient wallets, Vercel env secrets, security audit, deployment, and controlled live-payment tests are approved.

## Run Locally

```text
node src/server.js
```

In another terminal:

```text
curl http://127.0.0.1:3000/health
```

Mock unpaid request:

```text
curl -i -X POST http://127.0.0.1:3000/v1/analyze ^
  -H "Content-Type: application/json" ^
  -H "Idempotency-Key: demo-1" ^
  -d "{\"target\":\"Tempo MPP\",\"question\":\"Which paid analytical agent niche should we build first?\",\"depth\":\"quick\"}"
```

Mock paid retry:

```text
curl -i -X POST http://127.0.0.1:3000/v1/analyze ^
  -H "Content-Type: application/json" ^
  -H "Idempotency-Key: demo-1" ^
  -H "X-Mock-Payment: paid" ^
  -d "{\"target\":\"Tempo MPP\",\"question\":\"Which paid analytical agent niche should we build first?\",\"depth\":\"quick\"}"
```

Typed report example:

```text
curl -i -X POST http://127.0.0.1:3000/v1/launch-readiness ^
  -H "Content-Type: application/json" ^
  -H "Idempotency-Key: demo-launch-1" ^
  -H "X-Mock-Payment: paid" ^
  -d "{\"target\":\"Agent Launch Intel API\",\"question\":\"Is this service ready to list as an MPP/x402 paid API?\",\"depth\":\"quick\"}"
```

## Verify

On this Windows machine, `npm test` can hit an environment `EPERM` issue while resolving `C:\Users\PC`. Use direct Node commands:

```text
node --test test\app.test.js
node scripts\smoke-test.js
node scripts\remote-signer-readiness-smoke.js
node scripts\public-outbound-preview-smoke.js http://127.0.0.1:3000 --allow-http --idempotency-key preview-key
node scripts\remote-signer-live-payment-smoke.js
node scripts\remote-signer-e2e-smoke.js
node scripts\security-audit-local.js
```

Vercel build check, without deploying:

```text
npx.cmd vercel build --yes
```

Current verified result:

```text
Build completed successfully.
Output: .vercel/output
```

Public production deploy is intentionally separate and owner-confirmed. Dry-run the gated deploy helper first:

```text
.\scripts\deploy-vercel-production.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -DryRun
```

After manual approval, and only after env upload/readiness is green:

```text
.\scripts\deploy-vercel-production.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -ConfirmProductionDeploy
```

Do not enable live Tempo payments on Vercel until `MPP_SECRET_KEY`, receiver wallets, deploy-safe dependencies, and the remote outbound signer URL/token are configured. Do not put `AGENT_ACCESS_KEY_PRIVATE_KEY` in the public agent runtime unless `OUTBOUND_PAYMENT_PROVIDER=local_access_key` is explicitly approved for a narrow test.

Stop a Codex-started local server:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-server.ps1
```

## Non-Goals For MVP

- No generic chatbot UI.
- No autonomous trading.
- No private-key custody for customers.
- No broad multi-agent platform.
- No spend-firewall product surface yet.
