# Agent Production Env Template

Use this shape for a local `.secrets\agent-production.env` handoff file before uploading sensitive env to Vercel.

Do not commit the filled file. The production readiness script prints only loaded key names, not values:

Optional bootstrap for both local handoff files:

```powershell
npm run handoff:bootstrap -- --dry-run
npm run handoff:bootstrap
npm run handoff:repair-static-defaults
npm run handoff:owner-action-pack
npm run handoff:next-step
```

The bootstrap command creates `.secrets\agent-production.env` and `..\tempo-outbound-signer\.secrets\signer-live.env` with generated local bearer secrets and explicit `__FILL_*__` placeholders. `handoff:repair-static-defaults` is idempotent and only backfills non-secret production safety defaults such as report/signer admin rate limits in older handoff files. Do not upload these files as-is; replace every placeholder and development wallet/access-key address first.

Use the manual checklist to see the remaining owner-controlled values without printing secrets:

```powershell
npm run handoff:manual-checklist
npm run handoff:owner-action-pack
npm run handoff:owner-worksheet -- --markdown
npm run handoff:owner-worksheet:strict
npm run handoff:simulate-owner-values
npm run handoff:next-step
npm run handoff:init-live-values
npm run handoff:validate-live-values -- --allow-missing-policy-id
npm run handoff:apply-live-values -- --print-template
npm run handoff:apply-live-values -- --input .secrets\live-values.json --allow-missing-policy-id
npm run handoff:apply-live-values -- --input .secrets\live-values.json --allow-missing-policy-id --write
node ..\tempo-outbound-signer\scripts\turnkey-policy-draft.js --env-file ..\tempo-outbound-signer\.secrets\signer-live.env
npm run handoff:validate-live-values
npm run handoff:apply-live-values -- --input .secrets\live-values.json
npm run handoff:apply-live-values -- --input .secrets\live-values.json --write
npm run preflight:local-live-boundary
```

Keep `.secrets\live-values.json` local and ignored. `npm run handoff:next-step` is the read-only local planner: it checks the live-values file and local handoff gates, then returns the current stage, next safe command, and `owner_value_requirements` with the source, destination env keys, and safety note for every owner-controlled value. `npm run handoff:init-live-values` creates a placeholder-only file once and refuses to overwrite an existing owner-values file. `npm run handoff:validate-live-values` is read-only and prints only redacted status, so use it after filling values and again after adding `turnkey_policy_id`. The apply command is dry-run by default; only `--write` updates `.secrets\agent-production.env` and `..\tempo-outbound-signer\.secrets\signer-live.env`.

For the owner-side creation sequence, use `docs\OWNER_LIVE_CREATION_GUIDE.md` plus `npm run handoff:owner-action-pack`. The action pack returns the pinned `recommended_path`, `creation_guides`, and `owner_value_requirements` so each owner-created value has a source, destination, safety check, and verification command. `npm run handoff:owner-worksheet -- --markdown` renders the same state into a compact read-only worksheet without writing files or printing secret values. `npm run handoff:owner-worksheet:strict` is the fail-closed form for automation; it exits nonzero until the local boundary reaches env upload approval. `npm run handoff:simulate-owner-values` writes only temporary fake values and verifies that the pre-policy -> policy-draft -> final-apply -> local-boundary path can reach env-upload approval before real owner values are used.

The URL values must be real deployed HTTPS domains. The local apply command and production readiness gate reject template/reserved hostnames such as `your-agent.vercel.app`, `your-signer.vercel.app`, `.example`, `.test`, `.invalid`, or labels named `example`, `test`, `invalid`, `your`, or containing `placeholder`.

The first apply can use `--allow-missing-policy-id` so the signer env has enough wallet/API-only-user data to generate the Turnkey policy draft. That mode keeps `TURNKEY_POLICY_ID` deferred and does not make the service deploy/payment ready. After the owner creates the Turnkey policy, add `turnkey_policy_id` to `.secrets\live-values.json` and rerun the final apply without `--allow-missing-policy-id`.

The live-values JSON must include `turnkey_signer_api_user_id` in addition to `turnkey_organization_id`, `turnkey_api_public_key`, `turnkey_api_private_key`, and eventually `turnkey_policy_id`. That user ID is not secret, but it is security-critical because the Turnkey policy draft uses it in the API-only signer consensus expression.

```powershell
node scripts\production-readiness-check.js --env-file .secrets\agent-production.env
node scripts\predeploy-pair-readiness.js --agent-env-file .secrets\agent-production.env --signer-env-file ..\tempo-outbound-signer\.secrets\signer-live.env
node scripts\full-stack-live-handoff-check.js --agent-env-file .secrets\agent-production.env --signer-env-file ..\tempo-outbound-signer\.secrets\signer-live.env
.\scripts\add-vercel-production-env.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -Target production -DryRun
..\tempo-outbound-signer\scripts\deploy-vercel-live.ps1 -EnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -DryRun
.\scripts\deploy-vercel-production.ps1 -EnvFile .secrets\agent-production.env -SignerEnvFile ..\tempo-outbound-signer\.secrets\signer-live.env -DryRun
.\scripts\add-vercel-cron-env.ps1 -EnvFile .secrets\agent-production.env -AgentUrl https://your-agent.vercel.app -SignerUrl https://your-signer.vercel.app -ArmingIdempotencyKey first-live-browserbase-001 -Target production -DryRun
npm run launch:public-live -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --expect-cron-disabled
npm run launch:next-step -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app
npm run listing:readiness -- --agent-url https://your-agent.vercel.app --signer-url https://your-signer.vercel.app --inbound-idempotency-key public-live-tempo-inbound-... --expected-cron-idempotency-key cron-browserbase-fetch-YYYY-MM-DD --expected-standard-price-usd 0.01
```

The launch command is read-only by default. It needs local `OUTBOUND_ADMIN_TOKEN` and `SIGNER_ADMIN_TOKEN`, and it only executes live outbound payment or authorized cron when the matching confirm flag is added.
The next-step planner is also read-only and returns the current stage plus the next safe command without executing payment, deploy, signer fetch, or authorized cron.
The listing readiness gate is read-only and must pass before manual directory/listing submission. It also blocks readiness if public discovery advertises a stale or unintended price instead of the expected cheap launch price. Default expected price: `0.01` USD; override only with `--expected-standard-price-usd` or `EXPECTED_LISTING_STANDARD_PRICE_USD` when the real listing price changes.
The deploy helpers are fail-closed. The `-DryRun` commands above prove readiness only; real deploy still requires `-ConfirmSignerDeploy` or `-ConfirmProductionDeploy` after owner approval. Before publishing a real production build, each helper runs a local secret-looking literal sweep on `.vercel\output`.
The cron env helper is for the later autonomous-spend transition only. It runs public cron arming readiness first, uploads only cron env keys, and refuses real upload unless `-ConfirmCronEnablement` is present.

Current signer boundary: `TURNKEY_SIGN_WITH_MODE=wallet` remains the simplest first-live path. The sibling signer also implements fail-closed `TURNKEY_SIGN_WITH_MODE=access_key` raw signing. In wallet mode, Turnkey policy plus signer policy are the active outbound spend guards. In access-key mode, signer policy and ledger remain mandatory, and the root-authorized Tempo Access Key becomes the additional on-chain spend limiter after Access Key readiness, raw-signing policy review, signer audit, and owner approval.

The full-stack handoff and local live-boundary gates verify the configured Tempo Access Key read-only and on-chain by default. Do not use `--skip-access-key-onchain` for real env upload, deploy, payment, signer MPP fetch, cron enablement, or listing readiness; it is only for fake-value simulations and static rehearsals.

Signer env handoff must include `TURNKEY_SIGNER_API_USER_ID=<api-only signer user id>` so the policy draft can scope approval to the dedicated signer service user.

Template:

```text
PAYMENT_MODE=tempo
ENABLED_PAYMENT_RAILS=tempo
PUBLIC_BASE_URL=
EXPOSE_RUNTIME_READINESS_DETAILS=false
REQUIRE_IDEMPOTENCY_KEY_FOR_PAID=true
REPORT_RATE_LIMIT_ENABLED=true
REPORT_RATE_LIMIT_MAX=30
REPORT_RATE_LIMIT_WINDOW_MS=60000
REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS=true

AGENT_STORAGE_BACKEND=upstash_redis
AGENT_STORAGE_REDIS_PREFIX=agent-launch-intel-api-prod
ALLOW_SHARED_UPSTASH_BACKEND=true
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

PRICE_QUICK_USD=0.01
PRICE_STANDARD_USD=0.05
PRICE_DEEP_USD=0.25
MAX_REPORT_PRICE_USD=0.25

RECEIVE_TEMPO_ADDRESS=
TEMPO_RPC_URL=https://rpc.tempo.xyz
TEMPO_CHAIN_ID=4217
TEMPO_USDC_ADDRESS=0x20c000000000000000000000b9537d11c60e8b50
TEMPO_TOKEN_DECIMALS=6
TEMPO_MPP_LIVE_ENABLED=true
TEMPO_MPP_DEPS_ROOT=.
TEMPO_MPP_SECRET_KEY=
TEMPO_MPP_REALM=
TEMPO_MPP_WAIT_FOR_CONFIRMATION=true
TEMPO_MPP_VERIFY_ONCHAIN_ON_REQUEST=true
TEMPO_MPP_SUPPORTED_MODES=push

OUTBOUND_LIVE_PAYMENTS=true
OUTBOUND_PAYMENT_PROVIDER=remote_signer
MAX_OUTBOUND_PER_CALL_USD=0.01
MAX_OUTBOUND_DAILY_USD=0.05
OUTBOUND_ALLOWED_SERVICES=mpp.browserbase.com
OUTBOUND_DENY_UNKNOWN_SERVICES=true
OUTBOUND_ADMIN_TOKEN=
OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS=10000
OUTBOUND_BROWSERBASE_FETCH_RECIPIENT=0x9d27dc344b981264208583a6fc88b8c137d9e4b3
OUTBOUND_SIGNER_BASE_URL=
OUTBOUND_SIGNER_ADMIN_TOKEN=
OUTBOUND_SIGNER_AGENT_ID=agent-launch-intel
OUTBOUND_SIGNER_COMMAND=fetch_browserbase_page

ENABLE_OUTBOUND_CRON=false
CRON_SECRET=
OUTBOUND_CRON_IDEMPOTENCY_PREFIX=cron-browserbase-fetch
OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT=true
OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY=
```

Never set these in the public agent runtime:

```text
ROOT_PRIVATE_KEY
OWNER_PRIVATE_KEY
TREASURY_PRIVATE_KEY
MNEMONIC
SEED_PHRASE
AGENT_ACCESS_KEY_PRIVATE_KEY
```
