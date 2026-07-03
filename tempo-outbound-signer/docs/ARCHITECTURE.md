# Architecture

The signer is a separate security boundary between hosted agents and wallet keys.

```text
Remote agent
  -> signer API
  -> policy engine
  -> signing provider
  -> Tempo payment
```

In the current MVP, the signing provider is `mock`, so no real wallet signature is created. The value is the policy layer:

- one wallet policy per agent;
- per-call spending cap;
- daily spending cap;
- service allowlist;
- recipient allowlist;
- chain and token checks;
- idempotency ledger with pending reservation before external execution;
- bearer-token protected API;
- no raw private keys in Vercel agent runtime.

## Default agent policy

`agent-launch-intel` can request only:

- command: `fetch_browserbase_page`
- service: `mpp.browserbase.com`
- endpoint host: `mpp.browserbase.com`
- recipient: `0x9d27dc344b981264208583a6fc88b8c137d9e4b3`
- currency: Tempo USDC.e
- chain id: `4217`
- per-call cap: `0.01 USDC.e`
- daily cap: `0.05 USDC.e`

## Production target

Replace `mock` with `turnkey` after a Turnkey organization and policy are created. The hosted agent should call the signer with Vercel OIDC or an equivalent short-lived service identity. The signer should call Turnkey with its own credentials and never return private material.

The remote runtime scaffold is intentionally thin:

- `api/[...path].js` adapts Vercel `/api/...` requests to the same Node app;
- `vercel.json` rewrites `/health` and `/v1/...` to the function;
- `.vercelignore` excludes local ledgers, logs, env files, and `.secrets`;
- `scripts/live-readiness-check.js` blocks live mode until Turnkey, HTTPS, real wallet metadata, strict policy, and strong admin auth are present;
- production autonomous mode requires `SIGNER_LEDGER_BACKEND=upstash_redis` so idempotency and daily caps survive multiple serverless instances.
