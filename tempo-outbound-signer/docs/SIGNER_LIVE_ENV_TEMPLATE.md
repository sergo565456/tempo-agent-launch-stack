# Signer Live Env Template

Use this shape for a local `.secrets\signer-live.env` file after the Turnkey wallet and policy are created.

Do not commit the filled file. The live readiness script prints only loaded key names, not values:

Optional bootstrap from the sibling agent project:

```powershell
cd ..\tempo-agent-intel-api
npm run handoff:bootstrap -- --dry-run
npm run handoff:bootstrap
```

This creates the signer and agent handoff files with generated local bearer secrets and explicit placeholders. Do not upload the generated files as-is; replace every `__FILL_*__` value and the development wallet/access-key addresses first.

```powershell
node scripts\turnkey-live-handoff-check.js --env-file .secrets\signer-live.env
node scripts\turnkey-policy-draft.js --env-file .secrets\signer-live.env --expected-amount-base-units 1000 --signer-api-user-id <TURNKEY_SIGNER_API_USER_ID>
node scripts\tempo-access-key-readiness.js --env-file .secrets\signer-live.env
node scripts\live-readiness-check.js --env-file .secrets\signer-live.env
```

The handoff check is stricter than generic readiness for the first live test: it confirms the signer is still read-only during validation, catches wallet-mode `TURNKEY_SIGN_WITH` mismatch or access-key-mode `TURNKEY_ACCESS_KEY_SIGN_WITH` mismatch before a real signing attempt, and enforces the pinned tiny first-live caps.

The policy draft is also read-only. It uses the current signer policy shape to produce an owner-review Turnkey `ACTIVITY_TYPE_CREATE_POLICY_V3` body and a Tempo Access Key authorization review. It does not call Turnkey or create a policy. `TURNKEY_SIGN_WITH_MODE=wallet` remains the simplest first-live path. `TURNKEY_SIGN_WITH_MODE=access_key` is implemented locally, but live use requires `TURNKEY_ACCESS_KEY_SIGN_WITH`, `TURNKEY_ACCESS_KEY_PUBLIC_KEY`, `TURNKEY_ACCESS_KEY_POLICY_ID`, `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`, on-chain Access Key readiness, raw-signing policy review, and separate owner approval.

The Access Key readiness check is read-only. It verifies on-chain Account Keychain metadata for the configured wallet/access-key pair, rejects placeholders, identical wallet/access-key addresses, revoked or expired keys, unlimited spend policy, too-small remaining limits, and first-live limits wider than `0.05 USDC.e`.

`PUBLIC_BASE_URL` and production `UPSTASH_REDIS_REST_URL` must be real deployed HTTPS URLs. Live readiness and Turnkey handoff checks reject template/reserved hostnames such as `your-signer.vercel.app`, `.example`, `.test`, `.invalid`, or labels named `example`, `test`, `invalid`, `your`, or containing `placeholder`.

Template:

```text
SIGNER_PROVIDER=turnkey
SIGNER_ADMIN_TOKEN=
SIGNER_ADMIN_RATE_LIMIT_ENABLED=true
SIGNER_ADMIN_RATE_LIMIT_MAX=60
SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS=60000
SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS=true
PUBLIC_BASE_URL=
LIVE_READINESS_MODE=test
SIGNER_LEDGER_DURABLE=false
SIGNER_LEDGER_BACKEND=file
SIGNER_LEDGER_REDIS_PREFIX=tempo-outbound-signer
ALLOW_SHARED_UPSTASH_BACKEND=false
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

TEMPO_CHAIN_ID=4217
TEMPO_RPC_URL=https://rpc.tempo.xyz
TEMPO_USDC_ADDRESS=0x20c000000000000000000000b9537d11c60e8b50
TEMPO_TOKEN_DECIMALS=6

AGENT_WALLETS_JSON=[]

TURNKEY_API_BASE_URL=https://api.turnkey.com
TURNKEY_ORGANIZATION_ID=
TURNKEY_API_PUBLIC_KEY=
TURNKEY_API_PRIVATE_KEY=
TURNKEY_POLICY_ID=
TURNKEY_SIGNER_API_USER_ID=
TURNKEY_SIGN_WITH_MODE=wallet
TURNKEY_SIGN_WITH=
TURNKEY_SPONSOR_WITH=
```

For production autonomous mode, change the ledger section to:

```text
LIVE_READINESS_MODE=production
SIGNER_LEDGER_DURABLE=true
SIGNER_LEDGER_BACKEND=upstash_redis
SIGNER_LEDGER_REDIS_PREFIX=tempo-outbound-signer-prod
ALLOW_SHARED_UPSTASH_BACKEND=true
UPSTASH_REDIS_REST_URL=<from Upstash or Vercel Marketplace>
UPSTASH_REDIS_REST_TOKEN=<secret token>
```

The Upstash token must be configured only in the hosted secret manager or local `.secrets` handoff file, never in source-controlled docs.

For the first live outbound test, `AGENT_WALLETS_JSON` must keep:

```text
per_call_limit_base_units=10000
daily_limit_base_units=50000
allowed_services=mpp.browserbase.com
allowed_endpoints=https://mpp.browserbase.com/fetch
allowed_recipients=0x9d27dc344b981264208583a6fc88b8c137d9e4b3
allowed_commands=fetch_browserbase_page
```

After readiness passes, preview the Vercel upload. The helper runs `turnkey-live-handoff-check.js`, `live-readiness-check.js`, and `tempo-access-key-readiness.js` before it can upload anything:

```powershell
.\scripts\add-vercel-live-env.ps1 -EnvFile .secrets\signer-live.env -Target production -DryRun
```

Upload to Vercel only after manual approval:

```powershell
.\scripts\add-vercel-live-env.ps1 -EnvFile .secrets\signer-live.env -Target production -ConfirmSignerUpload
```

Dry-run the guarded production deploy:

```powershell
.\scripts\deploy-vercel-live.ps1 -EnvFile .secrets\signer-live.env -DryRun
```

Deploy only after manual approval:

```powershell
.\scripts\deploy-vercel-live.ps1 -EnvFile .secrets\signer-live.env -ConfirmSignerDeploy
```

The deploy helper reruns signer readiness gates, including `tempo-access-key-readiness.js`, and sweeps `.vercel\output` for secret-looking literals after build and before deploy.
