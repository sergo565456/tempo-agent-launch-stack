# Live Deployment Runbook

This runbook is the handoff from safe local mock mode to the first controlled outbound Tempo MPP live test.

Pinned custody/signing research: see `docs/RECOMMENDED_TURNKEY_TEMPO_PATH.md`.
Secret env template: see `docs/SIGNER_LIVE_ENV_TEMPLATE.md`.

## Current Boundary

The project is ready for:

- local mock signer tests;
- Vercel-compatible handler smoke tests;
- direct Turnkey wallet-mode signing adapter tests;
- fail-closed Turnkey Access Key raw-signing adapter tests;
- guarded outbound MPP fetch adapter tests;
- live readiness validation.

The project is not ready to sign real payments until Turnkey organization, wallet/account, policy, and real agent wallet/access-key values are configured outside source control. `TURNKEY_SIGN_WITH_MODE=wallet` is the simplest first-live path. `TURNKEY_SIGN_WITH_MODE=access_key` is implemented locally but requires dedicated raw-signing env values, `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`, on-chain Tempo Access Key readiness, raw-signing policy review, and separate owner approval before live use.

## Required Secret Environment

Configure these in the hosted runtime secret manager, not in committed files:

Required variables:

- `SIGNER_PROVIDER` with value `turnkey`;
- `SIGNER_ADMIN_TOKEN`, a strong random token with at least 32 chars;
- `SIGNER_ADMIN_RATE_LIMIT_ENABLED=true`;
- `SIGNER_ADMIN_RATE_LIMIT_MAX=60`;
- `SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS=60000`;
- `SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS=true` for hosted Vercel production;
- `PUBLIC_BASE_URL`, the HTTPS deployed signer domain;
- `TURNKEY_ORGANIZATION_ID`;
- `TURNKEY_API_PUBLIC_KEY`;
- `TURNKEY_API_PRIVATE_KEY`;
- `TURNKEY_POLICY_ID`;
- `TURNKEY_SIGNER_API_USER_ID`, the API-only user that should be allowed by Turnkey policy consensus;
- `TURNKEY_SIGN_WITH_MODE` with value `wallet` for the simplest first-live path, or `access_key` only after the dedicated raw-signing policy review and owner approval;
- for `TURNKEY_SIGN_WITH_MODE=access_key` only: `TURNKEY_ACCESS_KEY_SIGN_WITH`, `TURNKEY_ACCESS_KEY_PUBLIC_KEY`, `TURNKEY_ACCESS_KEY_POLICY_ID`, and `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`;
- `AGENT_WALLETS_JSON`, with real agent wallet and Tempo Access Key addresses.

`PUBLIC_BASE_URL` and production `UPSTASH_REDIS_REST_URL` must be real deployed HTTPS URLs. The live readiness, Turnkey handoff, and policy draft gates reject template/reserved hostnames such as `your-signer.vercel.app`, `.example`, `.test`, `.invalid`, and labels named `example`, `test`, `invalid`, `your`, or containing `placeholder`.

Runtime requirement:

- deploy on Node `22.x`, matching `package.json` and `package-lock.json`.

For the first live test, keep:

```text
LIVE_READINESS_MODE=test
SIGNER_LEDGER_DURABLE=false
SIGNER_LEDGER_BACKEND=file
```

For production autonomous mode, do not run with an ephemeral file ledger. Production mode requires a durable hosted ledger backend:

```text
LIVE_READINESS_MODE=production
SIGNER_LEDGER_DURABLE=true
SIGNER_LEDGER_BACKEND=upstash_redis
SIGNER_LEDGER_REDIS_PREFIX=tempo-outbound-signer-prod
UPSTASH_REDIS_REST_URL=<from hosted Redis>
UPSTASH_REDIS_REST_TOKEN=<secret token>
SIGNER_ADMIN_RATE_LIMIT_ENABLED=true
SIGNER_ADMIN_RATE_LIMIT_MAX=60
SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS=60000
SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS=true
```

The implemented durable ledger path uses Upstash Redis REST commands with an atomic reservation step before the external MPP action. This protects idempotency and daily spend caps across multiple serverless instances.

## Agent Wallet Policy Shape

Use this shape, replacing only the wallet and access-key addresses with real values:

```json
[
  {
    "agent_id": "agent-launch-intel",
    "wallet_address": "0x...",
    "tempo_access_key_address": "0x...",
    "turnkey_sign_with": "",
    "enabled": true,
    "per_call_limit_base_units": "10000",
    "daily_limit_base_units": "50000",
    "allowed_services": ["mpp.browserbase.com"],
    "allowed_endpoints": ["https://mpp.browserbase.com/fetch"],
    "allowed_recipients": ["0x9d27dc344b981264208583a6fc88b8c137d9e4b3"],
    "allowed_commands": ["fetch_browserbase_page"]
  }
]
```

The first test caps are intentionally tiny:

- per call: `0.01 USDC.e`;
- daily: `0.05 USDC.e`.

## Pre-Live Command Sequence

Run from `D:\Agents_402\tempo-outbound-signer`:

```powershell
node --test test\policy.test.js test\app.test.js
node --test test\turnkeyProvider.test.js
node scripts\security-audit-local.js
node scripts\smoke-test.js
node scripts\vercel-handler-smoke.js
node scripts\turnkey-live-handoff-check.js --env-file .secrets\signer-live.env
node scripts\turnkey-policy-draft.js --env-file .secrets\signer-live.env --expected-amount-base-units 1000 --signer-api-user-id <TURNKEY_SIGNER_API_USER_ID>
node scripts\tempo-access-key-readiness.js --env-file .secrets\signer-live.env
node scripts\live-readiness-check.js
node scripts\live-readiness-check.js --env-file .secrets\signer-live.env
```

Expected result before real setup: local tests and smoke checks pass, while `turnkey-live-handoff-check.js` and `live-readiness-check.js` fail with missing Turnkey/HTTPS/real wallet values.

Expected result after real setup: all commands pass.

The handoff checker is read-only. It loads only env key names and configuration booleans, rejects `TURNKEY_SIGN_WITH` / `agent.turnkey_sign_with` mismatch before a real signing attempt, enforces the pinned first-live caps, and does not call Turnkey, sign, pay, fetch MPP services, upload env, or deploy.

The policy draft is read-only too. It composes the first-live Turnkey policy candidate from the same signer policy: `TRANSACTION_TYPE_TEMPO`, wallet/account scope, Tempo chain, fee token, one token-transfer call, exact recipient calldata slice, and exact first-live amount calldata slice. Treat the generated body as an owner-review draft; create the policy manually in Turnkey, then store the resulting `TURNKEY_POLICY_ID`.

The Tempo Access Key readiness check is read-only. It queries Account Keychain metadata and remaining limit for the configured agent wallet/access-key pair, requires a real non-placeholder Access Key, limited spend policy, usable short expiry, remaining limit at least the first live amount, and remaining limit no wider than the first-live cap. It does not call Turnkey, sign, pay, fetch MPP services, upload env, or deploy. The public agent's full-stack handoff and local live-boundary gates also call this readiness check by default before env upload/deploy approval.

After readiness passes and the deployment is approved, preview the signer env upload from the local secret file:

```powershell
.\scripts\add-vercel-live-env.ps1 -EnvFile .secrets\signer-live.env -Target production -DryRun
```

The upload helper reruns `turnkey-live-handoff-check.js`, `live-readiness-check.js`, and `tempo-access-key-readiness.js` before it can call Vercel.

After manual approval, upload signer env:

```powershell
.\scripts\add-vercel-live-env.ps1 -EnvFile .secrets\signer-live.env -Target production -ConfirmSignerUpload
```

The signer env uploader is fail-closed: without `-DryRun` or `-ConfirmSignerUpload`, it refuses to call `vercel env add`.

After env upload and manual deploy approval, dry-run the guarded signer deploy:

```powershell
.\scripts\deploy-vercel-live.ps1 -EnvFile .secrets\signer-live.env -DryRun
```

Then deploy only with explicit confirmation:

```powershell
.\scripts\deploy-vercel-live.ps1 -EnvFile .secrets\signer-live.env -ConfirmSignerDeploy
```

The deploy helper reruns `turnkey-live-handoff-check.js`, `live-readiness-check.js`, and `tempo-access-key-readiness.js`, refuses without `-DryRun` or `-ConfirmSignerDeploy`, runs a local secret-looking literal sweep on `.vercel\output` after build and before deploy, and never uploads env or calls MPP fetch/payment routes.

After deployment, run a read-only public smoke. This does not call signing or payment routes:

```powershell
node scripts\public-smoke-test.js https://your-signer.vercel.app --expect-provider turnkey --require-ready --require-durable-ledger
```

If you want to verify the admin inventory gate without printing the token, keep the token in the environment:

```powershell
$env:SIGNER_ADMIN_TOKEN='<do not paste into docs>'
node scripts\public-smoke-test.js https://your-signer.vercel.app --expect-provider turnkey --require-ready --require-durable-ledger
```

Then run the stricter public production preflight:

```powershell
node scripts\public-production-preflight.js https://your-signer.vercel.app --expect-provider turnkey --expect-agent-id agent-launch-intel
```

Required local env:

```text
SIGNER_ADMIN_TOKEN=<signer admin token>
```

This checks signer health, readiness, durable Upstash ledger status, safe signer admin route rate limiting, admin inventory auth gating, expected agent policy presence, admin-gated ledger lookup, and admin-token non-leakage. It is read-only and does not call payment, signing, MPP fetch, or provider execution routes.

## First Live Payment Rule

The first real outbound payment must be:

- one call only;
- exact endpoint allowlist;
- exact recipient allowlist;
- amount `<= 0.01 USDC.e`;
- outbound-only key;
- short expiry;
- no root wallet key in the runtime.

Before this payment, `node scripts\tempo-access-key-readiness.js --env-file .secrets\signer-live.env` must pass with the real owner-authorized Access Key. If it fails because the remaining limit is wider than `0.05 USDC.e`, create a smaller first-live key or reduce the limit before continuing.

After the first live call, verify:

- signer ledger record;
- Turnkey activity/audit log;
- Tempo wallet balance delta;
- MPP service receipt.

Signer ledger lookup, read-only and admin-gated:

```text
GET /v1/agents/:agentId/ledger/:idempotencyKey
```

Use it after the first live payment to confirm the signer recorded `status=approved`, `operation=mpp_fetch`, and the expected `amount_base_units`.

## Guarded Outbound MPP Fetch

The agent-facing outbound route is:

```text
POST /v1/agents/:agentId/mpp/fetch
```

Use this when the public agent needs to buy a downstream MPP service without holding `AGENT_ACCESS_KEY_PRIVATE_KEY`.

Required request shape:

```json
{
  "confirm": "fetch-one-mpp-endpoint",
  "idempotency_key": "stable-key",
  "command": "fetch_browserbase_page",
  "service": "mpp.browserbase.com",
  "endpoint": "https://mpp.browserbase.com/fetch",
  "recipient": "0x9d27dc344b981264208583a6fc88b8c137d9e4b3",
  "currency": "0x20c000000000000000000000b9537d11c60e8b50",
  "chain_id": 4217,
  "amount_base_units": "1000"
}
```

The signer validates the request policy first, then validates the MPP challenge from the downstream service before creating the payment credential.
