# Public Quickstart

Agent Launch Intel API is a paid Tempo MPP report service for builders and agents.

Live base URL:

```text
https://tempo-agent-intel-api.vercel.app
```

## Discover

```powershell
curl.exe -sS https://tempo-agent-intel-api.vercel.app/health
curl.exe -sS https://tempo-agent-intel-api.vercel.app/.well-known/agent-card.json
curl.exe -sS https://tempo-agent-intel-api.vercel.app/.well-known/x402
curl.exe -sS https://tempo-agent-intel-api.vercel.app/openapi.json
```

## Paid Reports

Launch price:

```text
0.01 USDC.e per report on Tempo
```

Report endpoints:

```text
POST /v1/analyze
POST /v1/launch-readiness
POST /v1/service-diligence
POST /v1/ecosystem-fit
```

Example request body:

```json
{
  "target": "Example MPP service",
  "question": "Is this service ready to list as a paid agent API?",
  "depth": "quick"
}
```

Expected flow:

1. Call a paid endpoint with `Content-Type: application/json` and a unique `Idempotency-Key`.
2. The service returns a Tempo MPP payment challenge when payment is required.
3. Pay the challenge with a Tempo-compatible MPP client.
4. Retry the same endpoint with the same idempotency key and payment proof.
5. Receive the structured JSON report and receipt metadata.

## Local Development

```powershell
cd tempo-agent-intel-api
npm install
npm test
npm run dev
```

Mock paid local request:

```powershell
curl.exe -i -X POST http://127.0.0.1:3000/v1/launch-readiness `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: demo-launch-1" `
  -H "X-Mock-Payment: paid" `
  -d "{\"target\":\"Example MPP service\",\"question\":\"Is this service ready to list?\",\"depth\":\"quick\"}"
```

## Production Safety

The source repository is public, but runtime secrets are not included. Production use requires private Vercel, Upstash, Turnkey, wallet, and Tempo Access Key configuration outside source control.
