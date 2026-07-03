# Autonomous Execution Plan

Updated: 2026-06-07

Active pinned launch plan:

```text
docs/MULTIRAIL_MPP_X402_LAUNCH_PLAN.md
docs/RECOMMENDED_REMOTE_SIGNER_PATH.md
docs/DEPLOYMENT_LIVE_PAYMENT_RUNBOOK.md
```

## Objective

Continue building `Agent Launch Intel API` into a public paid Tempo MPP service that accepts inbound paid report requests and can later make tightly capped outbound Tempo MPP purchases through a separate remote signer.

## Current Implemented Surface

Public discovery and report routes:

```text
GET  /health
GET  /openapi.json
GET  /llms.txt
GET  /.well-known/agent-card.json
GET  /.well-known/x402
GET  /v1/runtime/tempo-readiness
POST /v1/analyze
POST /v1/launch-readiness
POST /v1/service-diligence
POST /v1/ecosystem-fit
GET  /v1/reports/:id
```

Admin/readiness routes and scripts cover inbound payment reconciliation, outbound preview, manual outbound payment, cron arming, authorized cron verification, and listing readiness. The launch path is remote signer first: the public agent must not hold wallet private keys.

## Current Boundary

Local mock/autonomous drills, production readiness gates, Vercel builds, and security audits are safe to run without owner intervention.

Real launch is blocked until owner-controlled live values exist:

```text
agent public HTTPS URL
signer public HTTPS URL
agent receiving Tempo wallet
agent Upstash REST URL/token
signer Upstash REST URL/token
Turnkey organization ID
Turnkey API-only signer user ID
Turnkey API public/private key
Turnkey policy ID
dedicated agent Turnkey wallet/account address
root-authorized Tempo Access Key address
```

`TURNKEY_SIGN_WITH_MODE=wallet` remains the simplest implemented first-live signer path. The sibling signer also implements fail-closed `TURNKEY_SIGN_WITH_MODE=access_key` raw signing for Tempo Account Keychain / Access Key signing. Tempo Access Key metadata is required and should be root-authorized in both modes; live access-key signing additionally requires dedicated `TURNKEY_ACCESS_KEY_*` values, on-chain readiness, raw-signing policy review, signer audit, and separate owner approval.

## Autonomy Rules

Codex may continue without asking when the action is local, reversible, and non-live:

- edit files inside `tempo-agent-intel-api` or `tempo-outbound-signer`;
- add or update tests, audits, docs, and dry-run checks;
- run local Node tests, smoke tests, readiness gates, security audits, and Vercel builds without deploy;
- initialize placeholder-only ignored handoff files such as `.secrets/live-values.json`;
- improve fail-closed guards, redaction, idempotency, rate limits, and read-only preflight tooling.

Codex must stop before:

- uploading env to Vercel or any hosted runtime;
- deploying production or preview runtimes;
- calling Turnkey APIs, creating policies, signing, or submitting transactions;
- authorizing a Tempo Access Key with a Root Key;
- sending inbound or outbound live payments;
- sending a signer MPP fetch or authorized cron bearer;
- enabling autonomous cron spending;
- submitting the service to MPPScan, x402 directories, or other public catalogs.

## Next Engineering Steps

1. Keep local handoff tooling dry-run-first and non-overwriting.
2. Use the read-only local next-step planner before every handoff transition.
3. Validate filled owner values read-only before any local env file write.
4. Keep production readiness stricter than normal URL parsing, especially for template/reserved hostnames.
5. Keep agent and signer ledgers separate and durable before public deploy.
6. Keep first live outbound caps tiny: `0.01` USDC.e per call and `0.05` USDC.e daily.
7. After owner values are filled, run local live-boundary gates before asking for env upload/deploy approval.
8. Keep signer Access Key readiness on-chain verification enabled for every real live-boundary run. Use skip/onchain-off flags only for fake-value simulations or static rehearsals.

## Current Safe Owner Handoff Commands

```powershell
npm run handoff:owner-action-pack
npm run handoff:owner-worksheet -- --markdown
npm run handoff:owner-worksheet:strict
npm run handoff:simulate-owner-values
npm run handoff:next-step
npm run handoff:init-live-values
npm run handoff:repair-static-defaults
npm run handoff:validate-live-values -- --allow-missing-policy-id
npm run handoff:apply-live-values -- --input .secrets\live-values.json --allow-missing-policy-id
npm run handoff:apply-live-values -- --input .secrets\live-values.json --allow-missing-policy-id --write
node ..\tempo-outbound-signer\scripts\turnkey-policy-draft.js --env-file ..\tempo-outbound-signer\.secrets\signer-live.env
node ..\tempo-outbound-signer\scripts\tempo-access-key-readiness.js --env-file ..\tempo-outbound-signer\.secrets\signer-live.env
npm run handoff:validate-live-values
npm run handoff:apply-live-values -- --input .secrets\live-values.json
npm run handoff:apply-live-values -- --input .secrets\live-values.json --write
npm run preflight:local-live-boundary
npm run preflight:local-vercel-dry-run
```

These commands do not upload env, deploy, call Turnkey, sign, pay, fetch external MPP services, send cron bearer auth, or execute authorized cron. `handoff:repair-static-defaults` only backfills non-secret production safety defaults in existing ignored handoff env files; it does not change owner URLs, wallets, Tempo Access Key values, Turnkey values, bearer tokens, or Redis tokens. `preflight:local-vercel-dry-run` checks that the agent and signer env files contain the exact required key set for the guarded Vercel helper dry-runs before requesting upload/deploy approval.
The `handoff:next-step` and `handoff:owner-action-pack` outputs include `owner_value_requirements`; use that redacted map to fill `.secrets\live-values.json` because it shows the source, destination env keys, and safety note for each value. `handoff:owner-action-pack` also includes the pinned `recommended_path` and `creation_guides`; the human-readable version is `docs\OWNER_LIVE_CREATION_GUIDE.md`. `handoff:owner-worksheet -- --markdown` renders the current state into a compact worksheet while remaining read-only. `handoff:owner-worksheet:strict` is the fail-closed form and exits nonzero until env upload approval is the next valid manual boundary. `handoff:simulate-owner-values` uses temporary fake owner values to prove the same local handoff pipeline can reach `ready_for_env_upload_approval` before real owner values are pasted.
