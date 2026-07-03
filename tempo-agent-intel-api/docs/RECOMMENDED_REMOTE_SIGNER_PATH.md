# Recommended Remote Signer Path

Pinned on 2026-06-06. Updated on 2026-06-07.

This is the recommended path for turning Agent Launch Intel API into a live Tempo MPP service while keeping outbound spend controlled.

## Chosen Architecture

```text
Public agent API on Vercel
  -> no raw payment private key in the public runtime
  -> calls Tempo Outbound Signer over HTTPS with a bearer admin token
  -> signer enforces per-agent policy, idempotency, exact service allowlist, amount caps, and daily caps
  -> Turnkey wallet-mode signer executes the approved Tempo MPP action
```

The public agent should use:

```text
OUTBOUND_PAYMENT_PROVIDER=remote_signer
OUTBOUND_SIGNER_BASE_URL=<https signer URL>
OUTBOUND_SIGNER_ADMIN_TOKEN=<strong secret>
OUTBOUND_SIGNER_AGENT_ID=agent-launch-intel
OUTBOUND_SIGNER_COMMAND=fetch_browserbase_page
```

The public agent should not receive `AGENT_ACCESS_KEY_PRIVATE_KEY` in live remote-signer mode.

Both deployable projects pin `engines.node` to `22.x` so Vercel does not auto-upgrade the runtime to a future major version.

## Why This Path

- It avoids putting a raw Tempo spending key inside the public agent runtime.
- It lets every future agent have a separate wallet and policy.
- It keeps live spending behind explicit confirmations, idempotency, service allowlists, recipient checks, per-call caps, and daily caps.
- It makes the first live outbound test small and auditable.

## Pinned Recommended Path 2026-06-07

Use this path for the current agent and repeat it for every future agent wallet:

1. Keep the owner/root authority outside deployed runtimes.
2. Create or keep one Turnkey organization controlled by the owner.
3. Create an API-only Turnkey user for the signer service, not for the public agent.
4. Generate a dedicated P-256 Turnkey API key for that signer user, record that signer user ID as `TURNKEY_SIGNER_API_USER_ID`, and store the private part only in the signer runtime secret store.
5. Create one Turnkey wallet/account per agent.
6. Add a Turnkey policy for that signer user that only allows the intended wallet/account and intended transaction shape.
7. Create a Tempo Access Key for that same agent wallet with short expiry and tiny per-token spend limit.
8. Authorize the Tempo Access Key on-chain with the owner/root key.
9. Deploy public agent without wallet private keys; it only calls the signer over HTTPS with a bearer admin token.
10. Deploy the signer with Turnkey credentials, signer policy JSON, durable ledger, service allowlist, amount caps, and daily caps.
11. Prove one public inbound payment, then one manual outbound payment, then one owner-approved cron payment.
12. Run the read-only listing gate and submit to directories manually only after it passes.

Current implementation boundary:

- `TURNKEY_SIGN_WITH_MODE=wallet` remains the simplest first-live path.
- `TURNKEY_SIGN_WITH_MODE=access_key` is implemented in the sibling signer as a fail-closed Turnkey raw-signing wrapper for Tempo Account Keychain / Access Key signing.
- For wallet mode, the primary outbound spend guard is Turnkey policy plus signer policy: exact agent wallet, service, endpoint, recipient, amount cap, daily cap, idempotency, and ledger reconciliation.
- For access-key mode, the same signer policy and ledger are still mandatory because Turnkey raw-payload policy cannot inspect the decoded Tempo recipient or amount; Tempo on-chain Access Key limits become the additional active spend limiter.
- The Tempo Access Key must be created, root-authorized, and checked with `node scripts\tempo-access-key-readiness.js --env-file .secrets\signer-live.env` as part of the handoff. Live access-key mode also requires `TURNKEY_ACCESS_KEY_SIGN_WITH`, `TURNKEY_ACCESS_KEY_PUBLIC_KEY`, `TURNKEY_ACCESS_KEY_POLICY_ID`, `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`, signer security audit, and separate owner approval.

Current official-docs checkpoint:

- Turnkey account setup still creates an organization ID and an API keypair; the private key is only shown at creation time and must be kept secure.
- Turnkey policy quickstart still supports an API-only user and a policy condition such as an allowlisted EVM destination for signing.
- Turnkey wallet creation still returns a wallet ID and derived addresses/accounts.
- Turnkey's shared-responsibility model puts root quorum, policy scope, and credential handling on us, so deployed signer env values must stay tightly scoped.
- Tempo Account Keychain still treats Access Keys as secondary keys with expiry and per-TIP20 limits, while Root Keys can authorize/revoke/update and Access Keys cannot mutate keychain state.
- Tempo Transaction docs still say Access Key limits deplete as tokens are spent and native value or non-TIP20 flows are outside that token-limit model; for MPP HTTP payment workflows our signer policy remains the primary spend guard.

## Current Provider Research

Checked against official docs on 2026-06-06 and re-checked on 2026-06-07:

- Turnkey's current model fits the remote-signer boundary: wallets and signing run behind hardware-backed secure enclaves, actions are evaluated by the policy engine, and the integration owner remains responsible for root quorum, policy scope, and credential handling.
- Tempo's Account Keychain model fits the agent wallet design: a Root Key can authorize secondary Access Keys with expiry and per-token spending limits, while Access Keys cannot authorize new keys, revoke keys, or update their own limits.
- Tempo spending-limit enforcement is strongest for direct TIP-20 operations such as `transfer`, `transferWithMemo`, `approve`, and `startReward`. Because MPP is an HTTP/payment workflow, this project must keep the signer policy layer as the primary guardrail for exact service, endpoint, recipient, amount, idempotency, and daily caps.
- TIP-1011 is marked `Mainnet` in the Tempo repo docs and adds richer Access Key controls such as periodic budgets and call/recipient scoping. Treat those controls as a future hardening layer until our exact SDK transaction path supports them end to end.
- Current MPP docs still match the implemented service shape: the server returns HTTP `402`, the client retries with a payment credential, and the service returns the paid resource plus receipt metadata. Our inbound path and read-only reconciliation scripts are aligned with that flow.
- Current service-directory signals still support the "agent sells analysis and buys external MPP data" thesis: MPP directories list paid services for model APIs, search, scraping, maps, blockchain/RPC data, and other agent utilities. Our first outbound target remains a tiny allowlisted data/read-only endpoint, not an open-ended tool call.

## Market Recheck 2026-06-07

Current public signals make the remote-signer/spend-control path more compelling than the earlier purely speculative version:

- MPPScan snapshot: `152K` transactions, `$23.76K` volume, `24.8K` agents, and `553` servers.
- MPPScan featured servers with visible usage include StableEnrich, CoinGecko, Exa, Firecrawl, fal.ai, OpenWeather, Alpha Vantage, Suno, Brave Search, Apollo, StableStudio, StableTravel, Mapbox, DeepL, Parallel API Gateway, and Groq.
- `mpp.dev/services/llms.txt` currently exposes a machine-readable curated directory. The fetched web snapshot contains `95` service entries. This count differs from MPPScan's `553` servers because MPPScan is measuring observed servers/usage, while `mpp.dev` is a curated service-discovery list.
- MPP now advertises three billing patterns: one-time charges, usage-based sessions, and subscriptions. Subscriptions are especially relevant for agents that need recurring API access or a paid plan gate.
- MPP payment hooks now expose lifecycle events for challenge, successful payment, failed credential, and receipt observability. That directly supports our product wedge: payment analytics, reconciliation, spend controls, and debugging for other agents.

Implication for `Agent Launch Intel API`:

- The paid analysis API remains a reasonable first product because discovery, research, web scraping, data enrichment, and AI/model APIs are already active MPP categories.
- The bigger differentiated wedge is still the spend firewall / analytics layer: once agents start chaining paid calls, buyers will need exact service allowlists, budget caps, idempotency, receipts, and reconciliation.
- The first live outbound call should stay tiny and read-only. A production autonomous agent must prove it can buy one safe external data signal, record both agent and signer ledgers, then arm cron only after that manual proof.

Primary references:

- https://docs.turnkey.com/concepts/introduction
- https://docs.turnkey.com/getting-started/quickstart
- https://docs.turnkey.com/concepts/policies/quickstart
- https://docs.turnkey.com/api-reference/activities/create-wallet
- https://docs.turnkey.com/api-reference/activities/create-policy
- https://docs.turnkey.com/networks/tempo
- https://docs.turnkey.com/concepts/policies/examples/tempo
- https://docs.tempo.xyz/protocol/transactions/AccountKeychain
- https://docs.tempo.xyz/
- https://developers.cloudflare.com/agents/agentic-payments/mpp/
- https://mpp.dev/services
- https://mppscan.org/
- https://mpp.dev/services/llms.txt
- https://mpp.dev/blog/subscriptions
- https://mpp.dev/blog/payment-hooks
- https://docs.tempo.xyz/protocol/transactions/spec-tempo-transaction
- https://github.com/tempoxyz/tempo/blob/main/tips/tip-1011.md

## Current Verified State

Local checks completed on 2026-06-06:

```text
tempo-agent-intel-api: npm test
tempo-agent-intel-api: npm run smoke
tempo-agent-intel-api: npm run smoke:remote-signer-readiness
tempo-agent-intel-api: node scripts\public-outbound-preview-smoke.js http://127.0.0.1:3000 --allow-http --idempotency-key first-live-browserbase-001 --require-ready
tempo-agent-intel-api: npm run smoke:remote-signer-live-payment
tempo-agent-intel-api: npm run smoke:remote-signer
tempo-agent-intel-api: npm run audit:local
tempo-agent-intel-api: npm audit --omit=dev
tempo-agent-intel-api: node scripts\tempo-mpp-readiness.js --skip-onchain
tempo-agent-intel-api: npx.cmd vercel build --yes

tempo-outbound-signer: npm test
tempo-outbound-signer: npm run smoke
tempo-outbound-signer: npm run smoke:vercel
tempo-outbound-signer: node scripts\public-smoke-test.js http://127.0.0.1:3100 --allow-http --expect-provider mock --require-ready
tempo-outbound-signer: npm run audit:local
tempo-outbound-signer: node scripts\live-readiness-check.js
tempo-outbound-signer: npm audit --audit-level=moderate
tempo-outbound-signer: npx.cmd vercel build --yes
```

Current signer test count is 66 passing tests, including Access Key readiness, Access Key raw-signing capability, env-file loading for `.secrets\signer-live.env`, the admin-gated signer ledger lookup, pending idempotency reservation before provider execution, Upstash Redis durable ledger behavior, production readiness gating, template/reserved hostname rejection, safe signer admin route rate-limit checks in public preflight, fail-closed signer Vercel env upload/deploy confirmations with Access Key readiness, the read-only Turnkey live handoff gate, wallet-mode policy draft, access-key raw-payload policy review draft, and guarded MPP fetch checks. Current agent project test count is 149 passing tests, including durable Upstash report/payment storage, live paid route Idempotency-Key enforcement, app-level paid report route rate limiting, strict public durable preflight flags, safe remote signer admin rate-limit checks from both direct signer readiness and agent-facing outbound readiness, access-key-mode live values, access-key-aware Vercel env upload gating, live values and predeploy cross-field collision plus template/reserved hostname checks, fail-closed production env upload and deploy confirmations, local production readiness gating, full-stack local live handoff with signer Access Key readiness, the redacted live manual checklist, the dry-run-first live value applier, non-secret static-default repair for old handoff files, the local Vercel dry-run env-key preflight, the local live-boundary gate, the read-only outbound readiness route, exact outbound payment preview route, public production preflight failure cases, public inbound reconciliation, cron safety, outbound reconciliation, the combined autonomous readiness suite, the public autonomous go-live readiness orchestrator, the guarded public live launch orchestrator, the read-only public live next-step planner, the read-only public listing readiness gate, the runtime cron arming guard, public cron arming readiness, the admin-only cron readiness endpoint, the public cron readiness smoke, the explicit-confirm public cron live-run verifier, and the read-only public autonomous completion verifier with optional authorized-cron ledger proof.

Latest local re-check on 2026-06-07 after making Access Key readiness part of the full-stack handoff:

```text
tempo-agent-intel-api: node --test test\fullStackLiveHandoff.test.js test\localLiveBoundaryGate.test.js test\localLiveNextStep.test.js test\ownerLiveActionPack.test.js test\ownerLiveWorksheet.test.js test\simulatedOwnerLiveReadiness.test.js -> 20 passing tests
tempo-agent-intel-api: node scripts\security-audit-local.js -> ok
tempo-agent-intel-api: npm test -> 148 passing tests
tempo-agent-intel-api: node scripts\local-vercel-dry-run-suite.js --skip-drill -> expected owner-values blocker; required env keys ok for agent and signer; no live actions
tempo-agent-intel-api: node scripts\local-live-boundary-gate.js --skip-drill -> expected owner-values blockers; Access Key on-chain verification required by default
tempo-agent-intel-api: node scripts\simulate-owner-live-readiness.js --skip-drill -> ok; fake-value simulation only, Access Key on-chain verification disabled intentionally
```

Latest re-check after signer ledger verification was added:

```text
tempo-outbound-signer: npm test
tempo-outbound-signer: npm run smoke
tempo-outbound-signer: npm run smoke:vercel
tempo-outbound-signer: npm run audit:local
tempo-outbound-signer: npm audit --audit-level=moderate
tempo-outbound-signer: npx.cmd vercel build --yes

tempo-agent-intel-api: npm test
tempo-agent-intel-api: npm run smoke:remote-signer-readiness
tempo-agent-intel-api: npm run smoke:remote-signer-live-payment
tempo-agent-intel-api: npm run smoke:remote-signer
tempo-agent-intel-api: npm run audit:local
tempo-agent-intel-api: node scripts\production-readiness-check.js
tempo-agent-intel-api: npm audit --omit=dev
tempo-agent-intel-api: npx.cmd vercel build --yes
```

Latest agent-only re-check after adding the combined public production preflight:

```text
tempo-agent-intel-api: npm test
tempo-agent-intel-api: npm run audit:local
tempo-agent-intel-api: npm run smoke:remote-signer-readiness
tempo-agent-intel-api: npm run smoke:remote-signer-live-payment
tempo-agent-intel-api: npm run readiness:production
tempo-agent-intel-api: npm run readiness:predeploy-pair
tempo-agent-intel-api: npm audit --omit=dev
tempo-agent-intel-api: npx.cmd vercel build --yes
```

Latest re-check after adding the guarded public live launch orchestrator and next-step planner:

```text
tempo-agent-intel-api: npm test -> 148 passing tests
tempo-agent-intel-api: npm run audit:local -> ok
tempo-agent-intel-api: npm audit --omit=dev -> 0 vulnerabilities
tempo-agent-intel-api: npx.cmd vercel build --yes -> ok
tempo-agent-intel-api: helper-equivalent secret sweep for source and first-party .vercel/output -> no matches

tempo-outbound-signer: npm test -> 58 passing tests
tempo-outbound-signer: npm run audit:local -> ok
tempo-outbound-signer: npm audit --omit=dev -> 0 vulnerabilities
tempo-outbound-signer: npx.cmd vercel build --yes -> ok
tempo-outbound-signer: helper-equivalent secret sweep for source and first-party .vercel/output -> no matches
```

`readiness:production` and `readiness:predeploy-pair` are expected to fail on the local default environment until the real production env files are supplied.

The local `smoke:remote-signer-live-payment` verifies the full preview -> guarded POST -> signer ledger path against the mock signer only. It does not use Turnkey credentials or make a real MPP network payment.

The public agent now has a Vercel Cron-compatible autonomous outbound route at `/api/cron/outbound/browserbase-fetch`. It is scheduled daily in `vercel.json`, but it is fail-closed until `ENABLE_OUTBOUND_CRON=true`, a strong `CRON_SECRET`, and `OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY=<first verified manual outbound idempotency key>` are configured. The route requires `Authorization: Bearer ${CRON_SECRET}` and uses a daily idempotency key so the same day cannot create duplicate signer ledger records if retried. Authorized cron attempts also write agent-side durable payment ledger events for success and failure without storing cron or signer bearer tokens.

Before cron can spend, the agent checks its durable payment ledger for a matching `outbound_admin_payment_succeeded` event with `trigger=admin_manual`, same signer agent id, command, service, endpoint, provider, amount, and the configured arming idempotency key. If the event is missing, the route returns `503 outbound_cron_not_armed` before it calls the signer.

The public agent also exposes `GET /v1/admin/payment-events?limit=50` behind `OUTBOUND_ADMIN_TOKEN` for read-only reconciliation of inbound payment events, manual outbound events, and cron outbound events.

The public read-only reconciliation command is:

```text
node scripts\public-outbound-reconcile.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --idempotency-key first-live-browserbase-001
```

It verifies that the agent payment ledger and signer ledger agree for the same idempotency key. It does not send a payment, sign, or call a downstream MPP endpoint.

The public cron safety smoke is:

```text
node scripts\public-outbound-cron-safety-smoke.js https://your-agent.vercel.app --expect-disabled
node scripts\public-outbound-cron-safety-smoke.js https://your-agent.vercel.app --expect-auth-gated
```

It intentionally sends no bearer token. Use `--expect-disabled` before cron is enabled and `--expect-auth-gated` after enabling cron.

The signer now supports `SIGNER_LEDGER_BACKEND=upstash_redis` for production autonomous mode. Production readiness requires `SIGNER_LEDGER_DURABLE=true`, `SIGNER_LEDGER_BACKEND=upstash_redis`, and hosted Redis REST env. The file ledger remains allowed only for local diagnostics and first tiny live test mode.

The public agent now supports `AGENT_STORAGE_BACKEND=upstash_redis` for production autonomous mode. Reports, report idempotency reservations, and payment ledger events can use hosted Redis REST instead of runtime `/tmp`; file storage remains for local diagnostics.

For the no-card production path, one shared Upstash DB can be used for both projects only as an explicit risk-accepted mode. The predeploy pair gate must see `ALLOW_SHARED_UPSTASH_BACKEND=true` in both env files and different namespaces: `AGENT_STORAGE_REDIS_PREFIX=agent-launch-intel-api-prod` and `SIGNER_LEDGER_REDIS_PREFIX=tempo-outbound-signer-prod`. This prevents key collisions but is not true credential isolation because the shared REST token can access both namespaces.

The public agent also has a local production readiness gate:

```text
node scripts\production-readiness-check.js --env-file .secrets\agent-production.env
```

It must pass before Vercel env upload/deploy. It checks live Tempo inbound mode, durable agent storage, remote signer outbound mode, HTTPS URLs, strong admin tokens, strict first-live outbound caps, Idempotency-Key enforcement, and absence of private key material in the public agent runtime.

The agent also has a predeploy pair gate:

```text
node scripts\predeploy-pair-readiness.js --agent-env-file .secrets\agent-production.env --signer-env-file ..\tempo-outbound-signer\.secrets\signer-live.env
```

It verifies the two env files agree on signer URL/token, Tempo chain/currency/decimals, agent id, command, allowed service/endpoint/recipient, requested Browserbase amount, and signer limits. It is read-only and does not call public URLs or payment routes.

The agent also has a full-stack local handoff gate:

```text
node scripts\full-stack-live-handoff-check.js --agent-env-file .secrets\agent-production.env --signer-env-file ..\tempo-outbound-signer\.secrets\signer-live.env
```

It composes agent production readiness, signer Turnkey handoff, signer Access Key readiness, and pair consistency. It must pass before env upload/deploy and remains read-only: no public HTTP calls, env upload, signing, payment, MPP fetch, downstream route, cron bearer, or authorized cron. `--skip-access-key-onchain` is only for local fake-value simulations or static rehearsal, not for real launch gating.

If the handoff files do not exist yet, bootstrap safe local stubs first:

```text
npm run handoff:bootstrap -- --dry-run
npm run handoff:bootstrap
```

This writes only local ignored `.secrets` files, generates strong local bearer/cron/MPP secrets, and leaves every live owner-controlled value as an explicit placeholder or development wallet/access-key address. It does not call Turnkey, upload env, deploy, sign, pay, fetch MPP services, send a cron bearer, or run authorized cron. The generated files must still fail readiness until the manual Turnkey, Upstash, public URL, receiving wallet, and agent wallet/access-key values are filled.

To get a redacted list of the exact manual values still missing:

```text
npm run handoff:manual-checklist
npm run handoff:owner-action-pack
npm run handoff:simulate-owner-values
```

This remains read-only and prints only loaded key names, redacted public values, blockers, and manual actions. It must not print token, Turnkey private key, cron secret, MPP secret, or admin bearer values.

The simulation command writes only temporary fake owner values, runs the pre-policy apply, review-only Turnkey policy draft, final apply, local boundary, and strict worksheet, then deletes the temp files by default. Use it to prove the local pipeline can reach `ready_for_env_upload_approval`; real owner values and explicit approval are still required before env upload, deploy, live payment, signer MPP fetch, authorized cron, or listing submission.

The owner action pack adds the exact owner-side sequence: public URLs, durable storage, Turnkey API-only signer key plus `TURNKEY_SIGNER_API_USER_ID`, agent wallet/account, strict Turnkey policy, Tempo Access Key authorization, and receiving wallet. It also repeats the `wallet` vs owner-gated `access_key` signing boundary so the Access Key is not mistaken for an active outbound limiter before access-key mode is explicitly configured and approved.

The Turnkey policy has one intentional dependency loop: the policy ID does not exist until after owner review, but the policy draft needs the signer API-only user ID and the dedicated agent wallet/account address. Break that loop with the pre-policy apply mode. It updates the local ignored handoff env files with every owner value except `TURNKEY_POLICY_ID`, and keeps deploy/payment readiness blocked:

```text
npm run handoff:apply-live-values -- --print-template
npm run handoff:apply-live-values -- --input .secrets/live-values.json --allow-missing-policy-id
npm run handoff:apply-live-values -- --input .secrets/live-values.json --allow-missing-policy-id --write
```

Then generate the review-only Turnkey policy body before creating the real policy:

```text
cd ..\tempo-outbound-signer
node scripts\turnkey-policy-draft.js --env-file .secrets\signer-live.env --expected-amount-base-units 1000 --signer-api-user-id <TURNKEY_SIGNER_API_USER_ID>
node scripts\tempo-access-key-readiness.js --env-file .secrets\signer-live.env
```

This draft uses the same signer policy values to propose `TRANSACTION_TYPE_TEMPO`, wallet/account scope, Tempo chain, fee token, one token-transfer call, exact recipient calldata, and exact first-live amount calldata. It does not call Turnkey or create the policy.

The generated consensus must reference only the dedicated API-only signer user ID, not a root/owner user. Treat a missing `TURNKEY_SIGNER_API_USER_ID` as a blocker before creating the Turnkey policy.

After creating the real Turnkey policy, add `turnkey_policy_id` to `.secrets/live-values.json` and run the final apply without `--allow-missing-policy-id`:

```text
npm run handoff:apply-live-values -- --input .secrets/live-values.json
npm run handoff:apply-live-values -- --input .secrets/live-values.json --write
```

The input JSON is local-only and must stay under `.secrets`. The apply command is dry-run by default, rejects placeholders and development wallet/access-key addresses, updates only the two local handoff env files when `--write` is explicit, and does not upload env, deploy, call Turnkey, create a policy, sign, pay, fetch MPP services, send a cron bearer, or run authorized cron.

The single local gate before requesting live env upload/deploy approval is:

```text
npm run preflight:local-live-boundary
```

It composes the redacted manual checklist, the full-stack local handoff gate with signer Access Key readiness, and the mock-only autonomous drill. It exits nonzero while owner-controlled live values are still missing, but it should still prove the local inbound -> manual outbound -> cron arming -> authorized cron shape in mock mode. It does not upload env, deploy, call Turnkey, sign, pay, fetch external MPP services, send a cron bearer to a public URL, or run authorized public cron.

After it passes and only after manual approval:

```powershell
.\scripts\add-vercel-production-env.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -Target production -DryRun
.\scripts\add-vercel-production-env.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -Target production -ConfirmProductionUpload
.\scripts\deploy-vercel-production.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -DryRun
.\scripts\deploy-vercel-production.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -ConfirmProductionDeploy
```

Vercel build now confirms both projects use package-pinned Node `22.x` even when the Vercel Project Settings default is a newer major version.

The local remote-signer e2e smoke verified:

```text
agent -> remote signer -> policy-approved mock mpp_fetch
amount_base_units=1000
no Turnkey credentials
no real payment
no outbound MPP network payment
```

The full local autonomous drill is:

```text
npm run drill:autonomous-local
```

It uses only local mock payment and mock signer services, then verifies the full shape of the autonomous system: unpaid inbound `402`, paid inbound report, manual outbound MPP purchase, cron arming from the manual outbound ledger event, and one authorized cron run. It does not use Turnkey credentials, make public HTTP requests, upload env, deploy, or call a real downstream MPP service.

## Live Boundary

Stop before live until these are supplied and approved:

1. Deploy the outbound signer to a public HTTPS runtime.
2. Create/configure a real Turnkey organization.
3. Create a separate wallet for `agent-launch-intel`.
4. Configure a strict Turnkey policy for that wallet.
5. Replace development placeholder wallet/access-key addresses in signer policy.
6. Set strong `SIGNER_ADMIN_TOKEN` and Turnkey env only in the signer runtime secret manager.
7. Set `OUTBOUND_SIGNER_*` env only in the public agent runtime.
8. Confirm both Vercel projects deploy on Node 22.
9. Run signer live readiness and confirm it is green.
10. Execute one tiny outbound MPP fetch/payment with a hard cap.
11. Register/list the public service after inbound and outbound live tests pass.

The current expected blocker is `tempo-outbound-signer/scripts/live-readiness-check.js`: it must fail until real Turnkey values, HTTPS public URL, strong admin token, and real wallet/access-key addresses are configured.

The signer-side live env handoff is prepared but not executed:

```text
tempo-outbound-signer/docs/SIGNER_LIVE_ENV_TEMPLATE.md
tempo-outbound-signer/scripts/add-vercel-live-env.ps1
tempo-outbound-signer/scripts/deploy-vercel-live.ps1
tempo-outbound-signer/scripts/public-smoke-test.js
```

After signer deploy, run the public read-only smoke before any payment request:

```text
node scripts\public-smoke-test.js https://your-signer.vercel.app --expect-provider turnkey --require-ready --require-durable-ledger
```

Then run the signer production preflight from `tempo-outbound-signer`:

```text
node scripts\public-production-preflight.js https://your-signer.vercel.app --expect-provider turnkey --expect-agent-id agent-launch-intel
```

This stricter signer-only check verifies durable ledger readiness, admin inventory gating, expected agent policy presence, ledger lookup gating, and admin-token non-leakage without calling payment/signing/MPP fetch routes.

After agent deploy and signer env setup, run the public full-stack read-only outbound preflight before any outbound payment:

```text
node scripts\public-outbound-readiness-smoke.js https://your-agent.vercel.app --expect-payment-mode tempo --require-outbound-ready --require-durable-storage --require-durable-signer-ledger
```

Then run the combined agent + signer production preflight:

```text
node scripts\public-production-preflight.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-payment-mode tempo --expect-signer-provider turnkey
```

It requires `OUTBOUND_ADMIN_TOKEN` and `SIGNER_ADMIN_TOKEN` in the local shell environment, checks both services over HTTPS, requires durable agent storage, durable signer ledger, safe signer admin route rate limiting from direct signer readiness, and safe signer admin route rate limiting surfaced through the agent-facing outbound readiness route by default. It rejects any response that reflects the admin tokens. It is read-only: no report, payment, signing, or outbound MPP fetch route is called.

Then run the combined autonomous readiness suite while cron is still disabled:

```text
node scripts\public-autonomous-readiness-suite.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-disabled
```

This composes the production preflight, no-auth cron safety check, exact outbound preview, and read-only payment-events inspection. It must remain read-only and must not call report POST, signer payment/fetch, signing, or downstream MPP routes.

For the final pre-live check, run the single go-live orchestrator:

```text
node scripts\public-autonomous-go-live-readiness.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-disabled
```

This wraps the signer-only production preflight plus the autonomous readiness suite, so it proves the signer ledger lookup is admin-gated and the agent's outbound preview still matches the approved service/recipient/amount.

The recommended single launch command is now the guarded public live launch orchestrator. Its default mode is read-only and composes go-live readiness plus the exact outbound preview:

```text
npm run launch:public-live -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-disabled
```

It requires local `OUTBOUND_ADMIN_TOKEN` and `SIGNER_ADMIN_TOKEN`, rejects token leaks from composed results and final summary, and does not pay unless a separate confirm flag is present. The inbound payment remains a separate owner-approved payment command because it requires the payer Access Key env and an exact amount.

For the most operator-friendly view, run the read-only next-step planner:

```text
npm run launch:next-step -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app
```

It composes the existing read-only gates and returns the current stage plus the next safe command. Stages are `awaiting_inbound_payment`, `awaiting_manual_outbound_payment`, `awaiting_cron_enablement`, `awaiting_authorized_cron_verification`, and `ready_for_listing_review`. It never sends payment confirmation, signer fetch, env upload, deploy, cron bearer, or authorized cron itself.

After the inbound payment is reconciled and the outbound preview is approved, the same orchestrator can execute the first tiny manual outbound payment:

```text
npm run launch:public-live -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --outbound-idempotency-key first-live-browserbase-001 --confirm-live-outbound-payment --verify-signer-ledger
```

This is not read-only. It uses the same guarded `public-outbound-live-payment.js` path, validates the preview before POST, and keeps the authorized cron path disabled.

After inbound evidence exists, the next-step planner can verify it and return the exact outbound payment command:

```text
npm run launch:next-step -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-...
```

Then preview the exact outbound request body with the idempotency key that will be used for the first payment:

```text
node scripts\public-outbound-preview-smoke.js https://your-agent.vercel.app --idempotency-key first-live-browserbase-001 --require-ready
```

Only after manual approval, execute the first outbound payment with the same idempotency key:

```text
node scripts\public-outbound-live-payment.js https://your-agent.vercel.app --idempotency-key first-live-browserbase-001 --expected-amount-base-units 1000 --confirm-live-payment --verify-signer-ledger
```

The live-payment script refuses to execute without `--confirm-live-payment`, validates the preview before POSTing to the agent admin route, and can verify the signer ledger record afterward.

Then run public outbound reconciliation for the same idempotency key before enabling cron.

Before setting the cron arming env, run:

```text
node scripts\public-cron-arming-readiness.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --idempotency-key first-live-browserbase-001 --expect-cron-disabled
```

It wraps reconciliation and no-auth cron safety. It accepts only a manual admin outbound success event as the arming source, so a previous cron event cannot accidentally arm future cron spend.

Also call the agent-side admin readiness endpoint:

```text
node scripts\public-outbound-cron-readiness-smoke.js https://your-agent.vercel.app --expect-ready-to-enable
```

This is a read-only runtime checkpoint. It uses the same arming predicate as the cron spend guard and reports whether the service is ready to enable cron, whether the authorized cron route can run, and which manual outbound ledger event is arming it. It does not send the cron bearer token, call the signer, sign, pay, or fetch the downstream MPP endpoint.

Then run the full read-only autonomous completion verifier:

```text
node scripts\public-autonomous-completion-verifier.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-... --manual-outbound-idempotency-key first-live-browserbase-001 --expect-cron-ready-to-enable
```

It composes inbound reconciliation, manual outbound reconciliation, no-auth cron safety, and admin cron readiness. It must remain read-only and must not call report POST, signer payment/fetch, signing, downstream MPP routes, or authorized cron.

The next-step planner can run the same evidence chain and return the cron-env enablement step:

```text
npm run launch:next-step -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-... --expect-manual-outbound-complete
```

After the first manual outbound payment, signer ledger verification, and balance/limit reconciliation pass, set `ENABLE_OUTBOUND_CRON=true`, `CRON_SECRET=<strong token>`, `OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT=true`, and `OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY=<first-live-idempotency-key>` in the public agent env to allow the daily autonomous call. Leave cron disabled before that point.

Use the guarded cron env helper for that transition. It first runs read-only cron arming readiness and refuses a real Vercel env upload without `-ConfirmCronEnablement`:

```powershell
.\scripts\add-vercel-cron-env.ps1 -EnvFile .secrets\agent-production.env -AgentUrl https://your-agent.vercel.app -SignerUrl https://your-signer.vercel.app -ArmingIdempotencyKey first-live-browserbase-001 -Target production -DryRun
.\scripts\add-vercel-cron-env.ps1 -EnvFile .secrets\agent-production.env -AgentUrl https://your-agent.vercel.app -SignerUrl https://your-signer.vercel.app -ArmingIdempotencyKey first-live-browserbase-001 -Target production -ConfirmCronEnablement
```

After uploading cron env, redeploy the public agent and run the auth-gated cron readiness checks before any authorized cron verification.

After cron is enabled, repeat the combined suite with the auth-gated expectation:

```text
node scripts\public-autonomous-readiness-suite.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-auth-gated
```

Then repeat the go-live orchestrator with the auth-gated expectation:

```text
node scripts\public-autonomous-go-live-readiness.js --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-auth-gated
```

At this stage `scripts/public-outbound-cron-readiness-smoke.js https://your-agent.vercel.app --expect-auth-gated` must also pass before trusting the daily schedule.

The guarded launch orchestrator can also verify this state without executing cron:

```text
npm run launch:public-live -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-auth-gated --check-cron-arming --verify-completion --inbound-idempotency-key public-live-tempo-inbound-...
```

The next-step planner version is:

```text
npm run launch:next-step -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-... --expect-manual-outbound-complete --expect-cron-auth-gated
```

For a manually approved one-time verification of the authorized cron path:

```text
node scripts\public-outbound-cron-live-run.js https://your-agent.vercel.app --expected-idempotency-key cron-browserbase-fetch-YYYY-MM-DD --confirm-live-cron-run --verify-signer-ledger
```

This is not a read-only command. It sends the `CRON_SECRET` bearer only after the admin cron readiness endpoint reports `ready_to_run_authorized=true`, validates the daily idempotency key, and requires `--confirm-live-cron-run`. It then verifies both the agent payment ledger and, with `--verify-signer-ledger`, the signer ledger for the same cron idempotency key.

The equivalent guarded orchestrator command is:

```text
npm run launch:public-live -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-auth-gated --expected-cron-idempotency-key cron-browserbase-fetch-YYYY-MM-DD --confirm-live-cron-run --verify-signer-ledger
```

This is also not read-only and must only be run after owner approval for one authorized cron payment.

After that authorized cron payment has executed, the planner can verify the cron ledger before listing review:

```text
npm run launch:next-step -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-... --expect-manual-outbound-complete --expect-cron-auth-gated --expect-authorized-cron-complete --expected-cron-idempotency-key cron-browserbase-fetch-YYYY-MM-DD
```

Then run the final read-only listing readiness gate:

```text
npm run listing:readiness -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-... --expected-cron-idempotency-key cron-browserbase-fetch-YYYY-MM-DD --expected-standard-price-usd 0.01
```

This gate requires `ready_for_listing_review`, inbound reconciliation, manual outbound reconciliation, authorized cron reconciliation, durable agent storage, `outbound_live_payments=true`, complete discovery surfaces, OpenAPI `x-payment-info` on all paid report endpoints, and the expected cheap launch listing price. The default expected listing price is `0.01` USD and can be overridden with `--expected-standard-price-usd` or `EXPECTED_LISTING_STANDARD_PRICE_USD` only for an intentional pricing change. It is read-only and does not submit to any directory. Directory/listing submission remains a manual owner action.
