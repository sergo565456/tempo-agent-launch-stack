# Security Audit - 2026-06-06

Scope: `tempo-outbound-signer`, the local policy-gated signer boundary for controlled outbound Tempo MPP payments.

## Result

Status: passed local security gate after hardening, the direct Turnkey wallet-mode adapter, the fail-closed Access Key raw-signing wrapper, and the guarded outbound MPP fetch route.

No live private keys, Turnkey private keys, root keys, or Tempo Access Key private keys were found in tracked project files during the audit. The only secret-like strings found were local/demo bearer tokens in README/tests and the audit script's own pattern checks. Real agent wallet and Tempo Access Key addresses were also removed from committed defaults and replaced with development placeholders.

## Verification

Commands run:

```powershell
npm test
node scripts\security-audit-local.js
node scripts\smoke-test.js
node scripts\vercel-handler-smoke.js
node scripts\live-readiness-check.js
npm audit --audit-level=moderate
```

Observed results:

- Node test suite: 22 passed, 0 failed.
- Local security audit script: passed all checks.
- Smoke test: passed health, readiness, unauthorized rejection, approval, and idempotent replay.
- Vercel handler smoke test: passed health, unauthorized rejection, and authorized request routing.
- Live readiness check: failed as expected because live Turnkey secrets, HTTPS deployment URL, and real wallet/access-key values are not configured in local defaults.
- Dependency audit: 0 vulnerabilities.
- Secret scan: no real private key material found outside ignored directories.

## Fixed Findings

### 1. Idempotency replay confusion

Risk: a reused idempotency key could replay a previous decision without proving the new request body was identical. Denied requests also did not preserve their original response status on replay.

Fix:

- Added stable request hashing.
- Stored `request_hash`, `status_code`, and response payload in the ledger record.
- Added a pending reservation before provider execution so duplicate idempotency keys cannot trigger concurrent duplicate payment attempts.
- Added an optional `upstash_redis` ledger backend for production autonomous mode. It uses Redis REST scripting for atomic reservation before the external MPP action.
- Reuse of the same idempotency key with a different body now returns `409 idempotency_conflict`.
- Denied idempotent replays keep the original denied status.

Coverage:

- `test/app.test.js` covers conflict rejection and denied replay.
- `scripts/security-audit-local.js` checks for the guardrails.

### 2. Allowed host was broader than intended

Risk: policy allowed any HTTPS path on an approved hostname. For example, approval of `mpp.browserbase.com` could also allow unrelated paths on the same host.

Fix:

- Added `allowed_endpoints` to agent wallet policy.
- Policy now requires an exact endpoint URL allowlist match.
- `.env.example` documents the exact endpoint allowlist shape.

Coverage:

- `test/policy.test.js` rejects path mismatch on an allowed host.
- `scripts/security-audit-local.js` checks for exact endpoint allowlist enforcement.

### 3. Agent policy inventory was public

Risk: `GET /v1/agents` exposed wallet addresses and policy metadata without admin authorization.

Fix:

- `GET /v1/agents` now requires the same bearer admin token as signing routes.
- Public agent response still excludes secret key material.

Coverage:

- `test/app.test.js` verifies unauthorized `GET /v1/agents` returns `401`.
- `scripts/security-audit-local.js` checks that inventory uses the admin auth helper.

### 4. Operational wallet metadata in defaults

Risk: committed defaults contained real agent wallet and Tempo Access Key addresses. These are not private keys, but they can reveal operational infrastructure and should not be used as public defaults.

Fix:

- Replaced default agent wallet and access key addresses with development placeholders.
- Real wallet/access-key addresses must be supplied through environment configuration for a live run.

### 5. Remote runtime needed a deployment gate

Risk: a hosted signer can be deployed with mock provider, localhost base URL, weak admin token, placeholder wallets, or non-durable live ledger assumptions.

Fix:

- Added Vercel handler scaffold with `.vercelignore` and route rewrites.
- Added `live-readiness-check.js`, which fails live readiness unless Turnkey, HTTPS, strong admin auth, real wallet metadata, and strict limits are configured.
- Added a Vercel handler smoke test.
- Added `LIVE_DEPLOYMENT_RUNBOOK.md` for the first controlled outbound live test.
- Added `.vercel/` to both ignore files after Vercel build generated a local `.vercel/.env.preview.local`; the generated env file was removed without reading its contents.

### 6. Turnkey adapter needed explicit live boundaries

Risk: a half-wired Turnkey provider could appear live-ready while either not using the expected payer wallet or implying Tempo Access Key enforcement that is not implemented yet.

Fix:

- Implemented the direct Turnkey wallet-mode Tempo transfer path.
- Implemented a fail-closed `TURNKEY_SIGN_WITH_MODE=access_key` raw-signing wrapper for Tempo Account Keychain / Access Key signing.
- Added a hard account-address match between Turnkey's returned account and the policy-approved payer wallet.
- Kept access-key live mode gated behind explicit raw-signing env values, `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`, on-chain Access Key readiness, and owner approval.
- Kept `TURNKEY_SPONSOR_WITH` blocked until sponsored Tempo transfers are implemented.

Coverage:

- `test/turnkeyProvider.test.js` covers missing credentials, audited access-key raw signing, unsupported sponsorship, direct transfer construction, and Turnkey account mismatch.
- `scripts/security-audit-local.js` checks the new Turnkey guardrails.

### 7. Outbound MPP fetch needed to stay behind signer policy

Risk: the public agent runtime could complete downstream MPP purchases only by holding a local Tempo Access Key private key.

Fix:

- Added `POST /v1/agents/:agentId/mpp/fetch`.
- The route requires bearer admin auth and `confirm=fetch-one-mpp-endpoint`.
- The signer now also rate-limits admin routes before policy evaluation or provider execution, and production readiness fails if `SIGNER_ADMIN_RATE_LIMIT_ENABLED` is not true or bounds are too wide.
- The same policy engine validates exact service, endpoint, recipient, token, chain, amount, per-call limit, and daily limit.
- The Turnkey provider validates the live MPP challenge before creating a credential through `mppx/client`.

Coverage:

- `test/app.test.js` covers route auth and confirmation.
- `test/turnkeyProvider.test.js` covers guarded MPP fetch success and challenge amount mismatch.
- `scripts/security-audit-local.js` checks the guarded fetch route and `mppx` boundary.

## Current Security Boundary

The current implementation is safe for local mock-mode development:

- Default signer provider is `mock`.
- Turnkey provider rejects signing until explicitly configured with organization, API key, policy ID, and either wallet-mode signing or audited access-key raw-signing values.
- `.gitignore` excludes `.env`, `.env.*`, `.secrets`, and `.data`.
- The signing route requires bearer admin authorization.
- Admin signing/fetch/inventory/ledger routes have an app-level fixed-window rate limit in addition to bearer auth.
- Policy requires explicit confirmation, service allowlist, exact endpoint allowlist, recipient allowlist, chain/token checks, per-call limit, and daily limit.

## Residual Risks Before Live Mode

These are not fixed yet because they belong to the next live deployment phase:

- Direct Turnkey wallet-mode signing, access-key raw signing, and guarded MPP fetch are implemented locally, but they have not been run with real Turnkey credentials in this environment.
- Tempo Access Key on-chain enforcement is active only when `TURNKEY_SIGN_WITH_MODE=access_key` is selected and real on-chain Access Key readiness has passed. Wallet mode still relies on Turnkey policy plus signer policy/ledger for outbound spend control.
- Bearer-token admin auth is acceptable for this local boundary, but production should use stronger service auth such as Vercel OIDC, mTLS, or short-lived signed requests.
- App-level admin route rate limiting reduces abuse blast radius, but platform WAF/rate limits should still be configured before public listing.
- File-backed ledger is fine for local tests and the first tiny live test only. Production readiness now requires `SIGNER_LEDGER_BACKEND=upstash_redis`, `SIGNER_LEDGER_DURABLE=true`, and hosted Redis REST secrets.
- The local machine should not hold root wallet keys. Root wallet actions should stay owner-only; agent runtime should receive only limited delegated signing ability.
- Vercel or any hosted runtime can be compromised through account/team access, leaked environment variables, dependency compromise, or platform-side incident. The signer must keep low limits and strict allowlists even after deployment.
- No real MPP outbound payment should be enabled until the signer uses a dedicated outbound-only key with a very small spending limit and short expiry.

## Next Gate

Before the next real payment test:

1. Configure a dedicated outbound-only wallet/key.
2. Keep the per-call limit at a tiny amount.
3. Use exact service endpoint and recipient allowlists.
4. Deploy signer separately from the public agent runtime.
5. Repeat this audit after the live Turnkey provider is wired.
