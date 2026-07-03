# Owner Live Creation Guide

Updated: 2026-06-07

This guide pins the owner-side path for creating the values needed by the public `Agent Launch Intel API` and the separate `tempo-outbound-signer`. It is intentionally non-secret. Do not paste private keys, seed phrases, Turnkey private API keys, bearer tokens, Upstash tokens, or root wallet material into this file.

## Pinned Recommended Path

1. Keep owner/root authority outside deployed runtimes.
2. Use Turnkey only inside the outbound signer runtime.
3. Create one dedicated Turnkey wallet/account per agent.
4. Create a strict Turnkey policy from the local read-only policy draft.
5. Create and root-authorize a Tempo Access Key with short expiry and tiny first-live limits.
6. Use separate public HTTPS URLs. Prefer separate durable ledgers for agent and signer; for this no-card production path, shared Upstash is allowed only when both env files explicitly set `ALLOW_SHARED_UPSTASH_BACKEND=true` and the Redis prefixes are different.
7. Run local handoff gates before any env upload or deploy.
8. Prove public inbound payment, manual outbound payment, and one authorized cron payment before listing.

## Values To Create

Use `npm run handoff:owner-action-pack` for the machine-readable checklist. It returns `recommended_path`, `creation_guides`, `owner_value_requirements`, destination env keys, safety notes, and the next manual boundary. Use `npm run handoff:owner-worksheet -- --markdown` for a compact read-only Markdown worksheet built from the same gates. Use `npm run handoff:owner-worksheet:strict` as a fail-closed local gate: it exits nonzero until `stage=ready_for_env_upload_approval` and `local_live_boundary_ok=true`.

### Turnkey Organization And API-Only Signer

Creates:

```text
turnkey_organization_id
turnkey_api_public_key
turnkey_api_private_key
turnkey_signer_api_user_id
```

Owner actions:

- Open or create the owner-controlled Turnkey organization.
- Create a signer/service API-only user for this project, separate from owner/root users.
- Create a P-256 API keypair for that signer user.
- Store the private API key only in a password manager, local `.secrets`, or the signer runtime secret store.

Safety:

- Never put `TURNKEY_API_PRIVATE_KEY` in the public agent runtime.
- The policy consensus must target the API-only signer user ID, not an owner/root user.
- Treat the private API key as one-time-visible secret material.

### Dedicated Turnkey Wallet/Account

Creates:

```text
agent_turnkey_wallet_address
```

Owner actions:

- Create one EVM/Ethereum address wallet/account dedicated to `agent-launch-intel`.
- Use `CURVE_SECP256K1` with `ADDRESS_FORMAT_ETHEREUM` for the Tempo EVM account.
- Record only the public EVM address in `.secrets/live-values.json`.
- Use a separate wallet/account for every future agent.

Safety:

- Do not reuse the owner treasury wallet.
- The address must match signer `TURNKEY_SIGN_WITH` and `AGENT_WALLETS_JSON.wallet_address`.

### Strict Turnkey Policy

Creates:

```text
turnkey_policy_id
```

Owner actions:

```powershell
npm run handoff:apply-live-values -- --input .secrets\live-values.json --allow-missing-policy-id
npm run handoff:apply-live-values -- --input .secrets\live-values.json --allow-missing-policy-id --write
node ..\tempo-outbound-signer\scripts\turnkey-policy-draft.js --env-file ..\tempo-outbound-signer\.secrets\signer-live.env --expected-amount-base-units 1000
```

Review the policy draft manually in Turnkey. Create the policy only if the consensus targets the API-only signer user and the condition scopes to the dedicated wallet, Tempo transaction type, expected chain, fee token, token-transfer selector, recipient, and first-live amount. Then paste only the resulting policy ID into `.secrets/live-values.json` and run:

```powershell
npm run handoff:validate-live-values
npm run handoff:apply-live-values -- --input .secrets\live-values.json
```

Safety:

- Do not create a broad arbitrary-signing policy.
- Do not upload env or deploy before final validation and local boundary gates pass.

### Tempo Access Key

Creates:

```text
agent_tempo_access_key_address
```

Owner actions:

- Create a separate Access Key address for the agent wallet.
- Authorize it from the Root Key through Tempo Account Keychain with `enforceLimits=true`.
- Use short first-live expiry and tiny USDC.e limits.
- Record the public Access Key address in `.secrets/live-values.json`.
- After the local handoff env is written, verify it read-only:

```powershell
node ..\tempo-outbound-signer\scripts\tempo-access-key-readiness.js --env-file ..\tempo-outbound-signer\.secrets\signer-live.env
```

Safety:

- Root Key remains owner-only and must not enter either deployed runtime.
- Access Key must differ from the Turnkey wallet/account address.
- For the first live path, remaining Access Key limit should be at least `1000` base units and no more than `50000` base units (`0.05 USDC.e`) until the first payment is proven.
- `TURNKEY_SIGN_WITH_MODE=wallet` remains the simplest first-live path. `TURNKEY_SIGN_WITH_MODE=access_key` is implemented in the sibling signer, but live access-key signing requires dedicated `TURNKEY_ACCESS_KEY_*` values, raw-signing policy review, on-chain readiness, signer audit, and owner approval.
- The same read-only Access Key readiness check is included in `scripts\full-stack-live-handoff-check.js` and `npm run preflight:local-live-boundary` by default. Do not use `--skip-access-key-onchain` for real env upload, deploy, payment, signer MPP fetch, cron enablement, or listing readiness.

### Public URLs, Receiving Wallet, And Durable Ledgers

Creates:

```text
agent_public_base_url
signer_public_base_url
agent_receive_tempo_address
agent_upstash_redis_rest_url
agent_upstash_redis_rest_token
signer_upstash_redis_rest_url
signer_upstash_redis_rest_token
```

Owner actions:

- Choose final public HTTPS production URLs for agent and signer.
- Choose the inbound revenue wallet for paid report revenue.
- Prefer separate durable Redis/Upstash REST credentials for agent storage and signer ledger.
- If using one Upstash DB for production, set `ALLOW_SHARED_UPSTASH_BACKEND=true` in both agent and signer env files, keep `AGENT_STORAGE_REDIS_PREFIX=agent-launch-intel-api-prod` and `SIGNER_LEDGER_REDIS_PREFIX=tempo-outbound-signer-prod` different, then require the predeploy pair readiness gate to pass.
- Store Redis tokens only in `.secrets` or hosted secret managers.

Safety:

- Agent and signer URLs must be different services.
- Separate Upstash REST URLs and tokens are safest. With one shared DB/token, prefixes only prevent key collision; the shared token can still access both namespaces. Treat `ALLOW_SHARED_UPSTASH_BACKEND=true` as an explicit production risk acceptance.
- Listing submission remains manual and only after the listing readiness gate passes.

## Local Gates

Run these before any upload, deploy, payment, signer fetch, or cron bearer use:

```powershell
npm run handoff:next-step
npm run handoff:owner-action-pack
npm run handoff:owner-worksheet -- --markdown
npm run handoff:owner-worksheet:strict
npm run handoff:simulate-owner-values
npm run handoff:repair-static-defaults
npm run handoff:validate-live-values -- --allow-missing-policy-id
npm run preflight:local-live-boundary
npm run preflight:local-vercel-dry-run
node ..\tempo-outbound-signer\scripts\tempo-access-key-readiness.js --env-file ..\tempo-outbound-signer\.secrets\signer-live.env
```

`handoff:simulate-owner-values` creates production-like fake owner values in a temporary directory, runs the pre-policy apply, policy draft, final apply, local boundary, and strict worksheet, then deletes the temp files. It proves the local pipeline can reach `ready_for_env_upload_approval`; it does not replace real owner-created Turnkey, Tempo, Upstash, wallet, URL, or receiving-wallet values.

`handoff:repair-static-defaults` can be run on older local handoff files. It only backfills non-secret safety defaults such as paid-report and signer-admin rate-limit keys; it does not change owner URLs, wallets, Turnkey values, bearer tokens, Redis tokens, or the Tempo Access Key address.

`preflight:local-vercel-dry-run` is the last read-only local check before asking for Vercel dry-run approval. It verifies the required env-key set for both guarded Vercel helper scripts and confirms the local next-step stage is `ready_for_env_upload_approval`.

The real local boundary uses on-chain Access Key verification by default. The simulation intentionally uses fake values and disables the on-chain Access Key RPC check so it can prove pipeline shape without creating a real wallet/key.

Expected current state while values are missing:

```text
ok=false for local live boundary
read_only=true
live_actions=false
stage=awaiting_owner_values
access_key_verify_onchain=true
access_key_ok=false
```

## Current External Research Check

Checked on 2026-06-07:

- Turnkey Tempo policy docs expose Tempo transaction policy parsing through the `tempo.tx` namespace and support transaction/call-level restrictions.
- Turnkey Create Policy docs use `ACTIVITY_TYPE_CREATE_POLICY_V3` and return `createPolicyResult.policyId`.
- Tempo Account Keychain docs define Root Key authorization of secondary Access Keys with expiry and per-TIP20 limits at precompile `0xAAAAAAAA00000000000000000000000000000000`.
- MPP service discovery is active and exposes paid agent/service discovery through public service pages and `llms.txt`.

References:

```text
https://docs.turnkey.com/concepts/policies/examples/tempo
https://docs.turnkey.com/networks/tempo
https://docs.turnkey.com/concepts/policies/quickstart
https://docs.turnkey.com/api-reference/activities/create-policy
https://docs.tempo.xyz/protocol/transactions/AccountKeychain
https://mpp.dev/services
```

## Hard Stops

- No root key, owner private key, mnemonic, or seed phrase in any runtime.
- No `TURNKEY_API_PRIVATE_KEY` in the public agent runtime.
- No `AGENT_ACCESS_KEY_PRIVATE_KEY` in the public agent runtime for remote-signer mode.
- No Vercel env upload/deploy, live payment, signer MPP fetch, authorized cron, or listing submission without explicit owner approval.
