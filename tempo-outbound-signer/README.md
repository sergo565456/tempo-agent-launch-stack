# Tempo Outbound Signer

Policy-gated signer boundary for remote Tempo MPP agent payments.

This project exists so Vercel-hosted agents do not need raw private keys. Agents call this signer with a narrow payment command; the signer verifies policy and then asks a signing provider to approve the action or complete a guarded MPP fetch.

Current state:

- `mock` provider by default; safe local development.
- `turnkey` provider implements direct wallet-mode Tempo transfers when real runtime secrets are configured.
- `turnkey` provider implements a fail-closed `TURNKEY_SIGN_WITH_MODE=access_key` raw-signing wrapper for Tempo Account Keychain / Access Key signing. It requires explicit Access Key signer values, `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`, on-chain Access Key readiness, and owner approval before live use.
- `turnkey` provider also implements a guarded outbound MPP fetch path via `mppx/client`.
- `readiness:access-key-signing` proves local Keychain V2 wrapper primitives without calling Turnkey, RPC, payment, or MPP routes.
- No real Turnkey credentials.
- No private keys in source or env templates.
- One default public policy for `agent-launch-intel` and Browserbase ratings.

## Local run

```powershell
npm test
node scripts\security-audit-local.js
node scripts\access-key-signing-capability.js
node scripts\smoke-test.js
node scripts\vercel-handler-smoke.js
node scripts\public-smoke-test.js https://your-signer.vercel.app --expect-provider turnkey --require-ready
```

To run the mock API:

```powershell
$env:SIGNER_ADMIN_TOKEN='local-dev-token'
node src\server.js
```

Example mock request:

```powershell
curl.exe -sS -X POST http://127.0.0.1:3100/v1/agents/agent-launch-intel/payments/mpp `
  -H "authorization: Bearer local-dev-token" `
  -H "content-type: application/json" `
  -d "{\"confirm\":\"sign-one-payment\",\"idempotency_key\":\"demo-1\",\"command\":\"fetch_browserbase_page\",\"service\":\"mpp.browserbase.com\",\"endpoint\":\"https://mpp.browserbase.com/fetch\",\"recipient\":\"0x9d27dc344b981264208583a6fc88b8c137d9e4b3\",\"currency\":\"0x20c000000000000000000000b9537d11c60e8b50\",\"chain_id\":4217,\"amount_base_units\":\"1000\"}"
```

## Boundary

This signer does not make production payments yet. The next live boundary is creating a real Turnkey organization, creating per-agent wallets there, configuring a strict Turnkey policy, and supplying those values through the hosted runtime secret manager.

`TURNKEY_SIGN_WITH_MODE=wallet` remains the simplest first-live path. `TURNKEY_SIGN_WITH_MODE=access_key` is implemented locally but fail-closed behind explicit raw-signing env values, `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`, a reviewed Turnkey raw-signing policy, on-chain Tempo Access Key readiness, and a separate owner-approved live smoke. The local capability probe verifies the installed SDK primitives without calling Turnkey, RPC, payment, or MPP routes.

Guarded outbound MPP fetch:

```text
POST /v1/agents/:agentId/mpp/fetch
```

The request must use `confirm=fetch-one-mpp-endpoint`. The signer validates service, exact endpoint, recipient, token, chain, amount, per-call limit, daily limit, and the live MPP challenge before creating a payment credential.

## Remote Runtime Scaffold

The Vercel-compatible handler lives in `api/[...path].js`. It maps `/api/health` and `/api/v1/...` back to the same local app routes, while `vercel.json` rewrites `/health` and `/v1/...` to that function.

Before any live test, run:

```powershell
node scripts\live-readiness-check.js
```

This check is expected to fail until real Turnkey org/API/policy values, real agent wallet/access-key addresses, HTTPS `PUBLIC_BASE_URL`, and a strong `SIGNER_ADMIN_TOKEN` are configured outside source.
