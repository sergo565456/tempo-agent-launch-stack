# Agent Launch Intel Stack

[![Node.js](https://img.shields.io/badge/node-22.x-1f6feb)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Tempo](https://img.shields.io/badge/payments-Tempo%20MPP-45d6a3)](https://tempo-agent-intel-api.vercel.app/.well-known/agent-card.json)
[![Price](https://img.shields.io/badge/price-%240.01%2Freport-45d6a3)](https://tempo-agent-intel-api.vercel.app)

Public source for **Agent Launch Intel API**, a paid Tempo MPP service that sells structured launch and diligence reports for agent-payment builders.

Live service: <https://tempo-agent-intel-api.vercel.app>  
MPPScan listing: <https://www.mppscan.com/server/829a2ec0cd95651c49881e21e918a2635f6eea7e9454df284c095821b2f1a893>  
Agent card: <https://tempo-agent-intel-api.vercel.app/.well-known/agent-card.json>  
OpenAPI: <https://tempo-agent-intel-api.vercel.app/openapi.json>

## What It Does

Agent Launch Intel API helps builders and other agents answer narrow commercial questions before launching or depending on paid agent services:

- Is this x402, MPP, Tempo, Venice, or MCP service niche worth building?
- Is a paid API ready to list in agent-payment directories?
- Which ecosystem should a service launch in first?
- What pricing, discovery, receipt, and safety work is missing?
- Is a third-party paid service safe enough for an agent to use?

The launch price is **0.01 USDC.e per report** on Tempo.

## Paid Endpoints

```text
POST /v1/analyze
POST /v1/launch-readiness
POST /v1/service-diligence
POST /v1/ecosystem-fit
```

Discovery surfaces:

```text
GET /health
GET /llms.txt
GET /openapi.json
GET /.well-known/agent-card.json
GET /.well-known/x402
```

## Repository Layout

- `tempo-agent-intel-api` - public paid Tempo MPP API and report engine.
- `tempo-outbound-signer` - policy-gated remote signer for the agent's own outbound MPP spending.
- `docs/PUBLIC_QUICKSTART.md` - short public usage guide.
- `docs/LISTING_AND_LAUNCH_PACK.md` - listing fields, directory copy, and launch posts.
- `docs/PRODUCTION_MONITORING.md` - read-only production monitor checklist.
- `docs/SECURITY_OPERATIONS.md` - security operations and rotation checklist.
- `SECURITY.md` - responsible disclosure and operational security notes.

Runtime material is intentionally excluded from GitHub: `.secrets/`, `.data/`, `.vercel/`, `.agents/`, `.tmp/`, `node_modules/`, generated output, test artifacts, logs, and real `.env` files.

## Quickstart

Install and test both services locally:

```powershell
cd tempo-agent-intel-api
npm install
npm test
npm run audit:local

cd ..\tempo-outbound-signer
npm install
npm test
npm run audit:local
```

Run the agent API locally in mock-payment mode:

```powershell
cd tempo-agent-intel-api
npm run dev
```

Then call a mock paid report:

```powershell
curl.exe -i -X POST http://127.0.0.1:3000/v1/launch-readiness `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: demo-launch-1" `
  -H "X-Mock-Payment: paid" `
  -d "{\"target\":\"Agent Launch Intel API\",\"question\":\"Is this service ready to list as a paid MPP API?\",\"depth\":\"quick\"}"
```

See [Public Quickstart](docs/PUBLIC_QUICKSTART.md) for live discovery, Tempo payment flow, and integration notes.

## Security Model

The public agent runtime does not need root wallet keys. Outbound spending is delegated to a separate signer service with policy checks, daily caps, idempotency, and Turnkey/Tempo Access Key readiness gates.

This repository does not contain production secrets, private keys, root wallet keys, Turnkey credentials, Upstash tokens, Vercel env values, local canary wallets, or live runtime state.

See [SECURITY.md](SECURITY.md) and [Security Publish Audit](SECURITY_PUBLISH_AUDIT_2026-07-03.md).

## License

MIT License. See [LICENSE](LICENSE).
