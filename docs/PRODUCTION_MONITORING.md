# Production Monitoring

This checklist is read-only. It is intended for public uptime, payment health, and safety monitoring.

## Public Checks

Check these endpoints:

```text
https://tempo-agent-intel-api.vercel.app/
https://tempo-agent-intel-api.vercel.app/health
https://tempo-agent-intel-api.vercel.app/openapi.json
https://tempo-agent-intel-api.vercel.app/llms.txt
https://tempo-agent-intel-api.vercel.app/.well-known/agent-card.json
https://tempo-agent-intel-api.vercel.app/.well-known/x402
```

Expected public state:

- HTTP 200 for discovery surfaces.
- `payment_mode=tempo`.
- Launch price remains `0.01` USDC.e per report.
- Durable storage is configured.
- Outbound live payments are enabled only behind signer/admin/cron policy gates.

## Private Operator Checks

Run from a private operator environment that has `.secrets/` or hosted secret access:

```powershell
cd tempo-agent-intel-api
npm run monitor:public
```

The monitor should stay read-only. It must not post a report, create a payment, send a signer request, upload env, deploy, or call an authorized cron route.

## Watch Items

- Public API availability.
- MPPScan availability.
- Payment-events admin route remains bearer-gated.
- Latest inbound paid report event.
- Latest outbound signer event.
- Outbound cron remains auth-gated and armed only by verified manual outbound payment.
- Agent wallet balance.
- Tempo Access Key expiry and remaining limit.
- Vercel function errors and latency.
- Upstash read/write errors.

## Alert Triggers

- Any discovery endpoint returns non-2xx.
- Public price differs from `0.01` USDC.e.
- Payment-events route returns non-401 without admin token.
- Authorized monitor cannot read payment events.
- Access Key is close to expiry or remaining limit is too low for scheduled checks.
- Outbound ledger shows denied, failed, or amount-mismatch events.
- Vercel reports repeated 5xx, timeout, or cold-start failures.
