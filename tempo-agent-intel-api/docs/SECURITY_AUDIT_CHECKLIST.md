# Security Audit Checklist

Updated: 2026-06-07

Run this before any public deploy, inbound live payment, outbound live payment, or public listing.

## Local Automated Checks

```text
npm test
node scripts\smoke-test.js
node scripts\security-audit-local.js
node scripts\production-readiness-check.js --env-file .secrets\agent-production.env
node scripts\predeploy-pair-readiness.js --agent-env-file .secrets\agent-production.env --signer-env-file ..\tempo-outbound-signer\.secrets\signer-live.env
node scripts\full-stack-live-handoff-check.js --agent-env-file .secrets\agent-production.env --signer-env-file ..\tempo-outbound-signer\.secrets\signer-live.env
node scripts\tempo-mpp-readiness.js
node scripts\tempo-mpp-challenge-smoke.js
node scripts\tempo-mpp-live-inbound-payment.js --amount-usd 0.05
node scripts\public-inbound-reconcile.js https://tempo-agent-intel-api.vercel.app --idempotency-key public-live-tempo-inbound-...
node scripts\fund-test-payer-wallet.js --amount 0.01
node scripts\authorize-test-payer-access-key-tempo.js
node scripts\tempo-mpp-outbound-micro-call.js
npx.cmd vercel build --yes
node scripts\public-smoke-test.js https://tempo-agent-intel-api.vercel.app
node scripts\public-outbound-readiness-smoke.js https://tempo-agent-intel-api.vercel.app --expect-payment-mode tempo --require-outbound-ready --require-durable-storage --require-durable-signer-ledger
..\tempo-outbound-signer: node scripts\tempo-access-key-readiness.js --env-file .secrets\signer-live.env
..\tempo-outbound-signer: node scripts\public-production-preflight.js https://your-signer.vercel.app --expect-provider turnkey --expect-agent-id agent-launch-intel
node scripts\public-production-preflight.js --agent-url https://tempo-agent-intel-api.vercel.app --signer-url https://your-signer.vercel.app --expect-payment-mode tempo --expect-signer-provider turnkey
node scripts\public-autonomous-readiness-suite.js --agent-url https://tempo-agent-intel-api.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-disabled
node scripts\public-autonomous-go-live-readiness.js --agent-url https://tempo-agent-intel-api.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-disabled
node scripts\public-outbound-cron-readiness-smoke.js https://tempo-agent-intel-api.vercel.app --expect-disabled
node scripts\public-cron-arming-readiness.js --agent-url https://tempo-agent-intel-api.vercel.app --signer-url https://your-signer.vercel.app --idempotency-key first-live-browserbase-001 --expect-cron-disabled
node scripts\public-autonomous-completion-verifier.js --agent-url https://tempo-agent-intel-api.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-... --manual-outbound-idempotency-key first-live-browserbase-001 --expect-cron-ready-to-enable
```

The local security script must not read `.secrets`, `.data`, `.git`, or `node_modules`. It reports only file paths and pattern names, never secret values.

## Payment Security

- Unpaid report calls return `402` only in mock mode.
- Tempo live rail returns blocked `501` unless `TEMPO_MPP_LIVE_ENABLED=true` and runtime readiness passes.
- Tempo MPP challenge smoke must return `402` without submitting payment.
- Live inbound payment script must dry-run by default and require `--confirm-live-payment` for a real transaction.
- Test payer funding and authorization scripts must dry-run by default and require explicit confirm flags for real transactions.
- Outbound MPP script must dry-run by default and require `--confirm-outbound` for a real downstream payment.
- Base x402 live rail returns blocked `501` until x402 middleware and recipient wallet are configured.
- Paid retries use the same `Idempotency-Key`.
- Live paid report routes require `Idempotency-Key` by default.
- Public paid report routes use an app-level fixed-window rate limit; production readiness must fail if `REPORT_RATE_LIMIT_ENABLED` is not true or if bounds are too wide. Keep platform WAF/rate limits as the outer layer before listing.
- Reusing an idempotency key with a different body returns `409`.
- Payment ledger records challenge, blocked-live, and verified-payment events.
- Stored reports include payment status and receipt metadata.
- `scripts/public-inbound-reconcile.js` must remain read-only and must compare a `payment_verified` event with the stored report metadata.
- Production agent storage uses `AGENT_STORAGE_BACKEND=upstash_redis` so reports, idempotency reservations, and payment ledger events are durable.
- OpenAPI `x-payment-info` matches the runtime payment mode.

## Wallet And Secret Safety

- Runtime env must never contain the owner/root private key.
- Public agent runtime env may contain `MPP_SECRET_KEY` and remote signer connection secrets.
- `AGENT_ACCESS_KEY_PRIVATE_KEY` is allowed only for explicitly approved legacy/local `OUTBOUND_PAYMENT_PROVIDER=local_access_key` tests, not the recommended public runtime.
- `.secrets`, `.data`, `.vercel`, `.env`, and `node_modules` stay gitignored.
- Fresh authorized Tempo Access Key is required before live Tempo outbound work.
- Existing Access Key from 2026-05-28 is expired and not authorized on-chain.
- Inbound revenue wallet, outbound spend wallet, and owner treasury wallet remain separate.
- `scripts/full-stack-live-handoff-check.js` must include the signer Access Key readiness gate by default. `--skip-access-key-onchain` is allowed only for local fake-value simulations or static rehearsals, never for real env upload, deploy, payment, signer MPP fetch, cron enablement, or listing readiness.

## Outbound Spend Safety

- `OUTBOUND_LIVE_PAYMENTS=false` by default.
- `OUTBOUND_PAYMENT_PROVIDER=remote_signer` by default.
- Allowed services are explicit.
- Unknown services are denied by default.
- Per-call and daily caps are configured before any live outbound call.
- Final reports include the dry-run spend plan or receipt ledger summary.
- After a network/client error, verify balance, access-key limit, and token transfer logs before any retry.
- Do not enable Vercel outbound live spending unless the remote signer URL/token and signer-side Turnkey policy have been reviewed.
- Do not store the secondary Access Key private key in Vercel env unless the user explicitly chooses legacy `local_access_key` mode after risk review.
- Before the first public outbound payment, run the combined public production preflight and confirm it reports durable agent storage, durable signer ledger, signer provider `turnkey`, safe signer admin route rate limiting, and no reflected admin tokens.
- Before the first public outbound payment, run the signer Access Key readiness check and confirm the configured Access Key is real, distinct from the wallet, active on-chain, limited, short-lived, and capped to no more than `0.05 USDC.e` remaining for first-live testing.
- Before the combined public production preflight, run the signer-only public production preflight from `tempo-outbound-signer` and confirm signer ledger lookup is admin-gated and signer admin route rate limiting is enabled with safe bounds.
- `scripts/public-autonomous-readiness-suite.js` must remain read-only: it may call public preflight, no-auth cron safety, admin cron readiness, outbound preview, and payment-events lookup, but not report POST, signing, signer MPP fetch, or downstream MPP routes.
- `scripts/public-autonomous-go-live-readiness.js` must remain read-only and must compose signer production preflight plus autonomous readiness before any first live outbound payment or cron enablement.
- `scripts/public-autonomous-completion-verifier.js` must remain read-only and must compose inbound reconciliation, manual outbound reconciliation, no-auth cron safety, admin cron readiness, and optional authorized-cron ledger reconciliation after the first live inbound, manual outbound, and owner-approved cron tests. It must not call report POST, signer MPP fetch, downstream MPP routes, or the authorized cron route, and it must reject manual outbound events masquerading as cron proof.
- Before uploading production env, run the predeploy pair readiness gate and confirm the public agent env and signer env agree on URL, token, agent id, command, service scope, recipient, Tempo chain/currency/decimals, and limits.
- Before writing owner live values and before env upload, the apply handoff and predeploy pair gates must reject same agent/signer public URL, shared agent/signer Upstash ledger credentials, and identical Turnkey wallet / Tempo Access Key addresses.
- Before uploading production env, run `scripts/full-stack-live-handoff-check.js` and confirm it passes. It must compose agent production readiness, signer Turnkey handoff, signer Access Key readiness, and pair consistency without env upload, deploy, public HTTP calls, report POST, signing, payment, MPP fetch, downstream routes, cron bearer, or authorized cron.
- Real production env upload must use `scripts/add-vercel-production-env.ps1 -ConfirmProductionUpload` after a successful `-DryRun`; without that flag the helper must refuse to call `vercel env add`.
- `scripts/add-vercel-production-env.ps1` must rerun both `production-readiness-check.js` and `full-stack-live-handoff-check.js` before any `vercel env add` call.
- Real production deploy must use `scripts/deploy-vercel-production.ps1 -ConfirmProductionDeploy` after a successful `-DryRun`; without that flag the helper must refuse to call `vercel build` or `vercel deploy`.
- `scripts/deploy-vercel-production.ps1` must rerun both `production-readiness-check.js` and `full-stack-live-handoff-check.js` before any Vercel production deploy, and must not upload env or call payment/cron routes.
- Outbound cron must remain fail-closed until after the first manual outbound live payment: `ENABLE_OUTBOUND_CRON=false` by default, `CRON_SECRET` strong when enabled, route requires bearer auth, idempotency key is daily, `OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT=true`, and `OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY` points to the verified manual outbound idempotency key.
- Authorized cron must return `503 outbound_cron_not_armed` before calling the signer if the matching `outbound_admin_payment_succeeded` ledger event is missing.
- Before setting `OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY`, run `scripts/public-cron-arming-readiness.js` and confirm it accepts only `outbound_admin_payment_succeeded` with `trigger=admin_manual`.
- `GET /v1/admin/outbound/cron/readiness` must remain read-only, bearer protected by `OUTBOUND_ADMIN_TOKEN`, and must use the same manual-event arming predicate as the runtime cron guard.
- The cron readiness endpoint must not send `CRON_SECRET`, call the signer, submit payment, sign, or fetch the downstream MPP endpoint.
- `scripts/public-outbound-cron-readiness-smoke.js` must remain read-only, must call only `GET /v1/admin/outbound/cron/readiness`, and must reject admin token leaks.
- Authorized outbound cron success and failure paths must record durable agent-side payment ledger events without storing cron/signature bearer tokens.
- `scripts/public-outbound-cron-live-run.js` must require `--confirm-live-cron-run`, must validate admin cron readiness before sending `CRON_SECRET`, and must verify the agent payment ledger after execution.
- `GET /v1/admin/payment-events` must remain read-only, bearer protected, and capped by a query `limit`.
- `scripts/public-outbound-reconcile.js` must remain read-only and must compare agent payment ledger events with signer ledger records before cron is enabled.
- `scripts/public-outbound-cron-safety-smoke.js` must remain no-auth and read-only; use it to prove the deployed cron route is disabled or bearer-gated without triggering a payment.

## Manual Review Before Live

- Review payment adapters for bypass paths.
- Review replay/idempotency behavior against real receipts.
- Review OpenAPI, `llms.txt`, agent-card, and x402 discovery for mismatches.
- Review prompt/source inputs for SSRF and prompt-injection routes into outbound paid calls.
- Confirm deployed environment has no root key and no expired Access Key.
- Confirm public listing profile is not submitted as live MPP until public Tempo MPP payment is verified.
