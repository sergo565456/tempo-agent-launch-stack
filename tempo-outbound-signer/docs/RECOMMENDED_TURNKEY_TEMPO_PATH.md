# Recommended Turnkey + Tempo Access Key Path

Status: pinned research plan and implementation path for moving `tempo-outbound-signer` from mock mode to the first controlled live outbound Tempo MPP payment.

## Recommendation

Use three independent control layers:

1. Turnkey holds signing material in its wallet infrastructure.
2. `tempo-outbound-signer` enforces local app policy before asking Turnkey to sign.
3. Tempo Account Keychain adds a short-lived Access Key with tiny on-chain limits when `TURNKEY_SIGN_WITH_MODE=access_key` is explicitly selected and all raw-signing gates pass.

This is safer than putting a raw `AGENT_ACCESS_KEY_PRIVATE_KEY` into Vercel because a hosted runtime compromise should still hit Turnkey policy and the signer's allowlists. In access-key mode, the same compromise should also hit Tempo on-chain expiry/spend limits.

## Pinned Steps

### 1. Create Turnkey Organization And API Key

Manual owner action:

- create or open a Turnkey organization;
- copy the organization ID;
- create a server API keypair;
- store the API public/private key only in the deployment secret manager.

Signer env names:

- `TURNKEY_ORGANIZATION_ID`
- `TURNKEY_API_PUBLIC_KEY`
- `TURNKEY_API_PRIVATE_KEY`

Research result:

- Turnkey account setup docs confirm the organization ID is copied from the dashboard.
- Turnkey API key private material is shown once and must be kept secure.

### 2. Create One Turnkey Wallet/Account Per Agent

Manual owner action:

- create wallet `tempo-agent-launch-intel`;
- derive an EVM/secp256k1 account with Ethereum address format;
- record the public address as the agent wallet account.

Signer env:

- use the resulting public address as `wallet_address` inside `AGENT_WALLETS_JSON`.

Research result:

- Turnkey Company Wallets docs show wallet creation with `CURVE_SECP256K1`, BIP32 path, and `ADDRESS_FORMAT_ETHEREUM`.
- Turnkey's Tempo network page says Tempo address derivation uses Ethereum address type.

### 3. Create Turnkey Tempo Signing Policy

Manual owner action:

- create policy scoped to the agent wallet/account;
- allow only Tempo transaction signing;
- require the expected chain, fee token, call destination, function selector, and recipient;
- deny broad arbitrary signing.

Recommended policy intent:

- allow `ACTIVITY_TYPE_SIGN_TRANSACTION` / `TRANSACTION_TYPE_TEMPO` only for the chosen wallet/account;
- restrict `tempo.tx.calls` to the expected token/payment contract;
- restrict function selector to known TIP-20 transfer-style calls where possible;
- check calldata recipient by slicing encoded ABI address;
- optionally require a human approver for first production policy changes.

Research result:

- Turnkey supports Tempo transaction parsing through the `tempo.tx` policy namespace.
- Turnkey Tempo policy examples support wallet/private-key scoping, call destination checks, function selector checks, list quantifiers, and raw calldata slicing.

### 4. Create Tempo Access Key

Manual owner action:

- create a separate secp256k1 Access Key address for this agent;
- authorize it from the Root Key through Tempo Account Keychain;
- set `enforceLimits=true`;
- set expiry to 24-72 hours for first live tests;
- set total limit to `0.05 USDC.e` or less for first live tests;
- use allowed-call restrictions if the final SDK path supports the newer scoped access-key config.

Signer env:

- use the authorized Access Key address as `tempo_access_key_address` inside `AGENT_WALLETS_JSON`.

Research result:

- Tempo Account Keychain is deployed at `0xAAAAAAAA00000000000000000000000000000000`.
- Root Keys can authorize, revoke, and update Access Keys.
- Access Keys can have expiry and per-TIP20 spending limits.
- Access Keys cannot manage other keys.
- Limits are enforced by Tempo for documented TIP-20 transfer/approval flows; they are not a replacement for app policy.

### 5. Wire The Signer Provider

Implementation action:

- use the implemented direct Turnkey wallet adapter with `TURNKEY_SIGN_WITH_MODE=wallet`;
- run `node scripts\turnkey-live-handoff-check.js --env-file .secrets\signer-live.env` before live readiness; this read-only gate catches `TURNKEY_SIGN_WITH` / wallet mismatch and enforces first-live caps before any signing attempt;
- run `node scripts\turnkey-policy-draft.js --env-file .secrets\signer-live.env --expected-amount-base-units 1000 --signer-api-user-id <TURNKEY_SIGNER_API_USER_ID>` to produce the owner-review Turnkey policy body before creating the policy manually;
- keep `live-readiness-check.js` as the gate before any live request;
- after public production deploy, run `node scripts\public-production-preflight.js https://your-signer.vercel.app --expect-provider turnkey --expect-agent-id agent-launch-intel`;
- sign one outbound MPP payment only after readiness passes.

Current integration risk:

- Turnkey docs clearly confirm Tempo transaction signing and policy parsing.
- Tempo docs and tempo-go docs clearly confirm Access Key / Keychain signature behavior.
- Turnkey's official `examples/with-tempo` example uses `@turnkey/sdk-server`, `@turnkey/viem`, `viem/tempo`, and a `SIGN_WITH` value to sign Tempo testnet transfer and multicall transactions.
- The official example confirms the direct Turnkey Tempo signing path, but it does not show Tempo Account Keychain / Access Key signing.
- Current project implementation supports direct wallet mode and a fail-closed `TURNKEY_SIGN_WITH_MODE=access_key` raw-signing wrapper.
- `node scripts\access-key-signing-capability.js` proves, locally and read-only, that the installed `viem/tempo` SDK can build an Access Key account where the transaction sender is the parent wallet and the signer is the secondary Access Key, and that the installed Turnkey SDK exposes `signRawPayload`.
- Access Key mode asks Turnkey to sign the raw keychain inner digest with the Access Key and assembles the Keychain V2 signature in the adapter. That preserves Tempo on-chain Access Key limits, but Turnkey's policy for the raw signing path may be less expressive than `tempo.tx` transaction policies. Our app policy and Tempo on-chain limits therefore remain mandatory controls.

## First Live Test Limits

Use these until the first payment has been verified:

- `per_call_limit_base_units`: `10000` (`0.01 USDC.e`)
- `daily_limit_base_units`: `50000` (`0.05 USDC.e`)
- `LIVE_READINESS_MODE`: `test`
- `SIGNER_LEDGER_DURABLE`: `false`
- `SIGNER_LEDGER_BACKEND`: `file`

Production autonomous mode must not use an ephemeral ledger. Use:

- `LIVE_READINESS_MODE`: `production`
- `SIGNER_LEDGER_DURABLE`: `true`
- `SIGNER_LEDGER_BACKEND`: `upstash_redis`
- `SIGNER_LEDGER_REDIS_PREFIX`: a production-specific prefix
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: hosted secret values
- `SIGNER_ADMIN_RATE_LIMIT_ENABLED`: `true`
- `SIGNER_ADMIN_RATE_LIMIT_MAX`: `60`
- `SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS`: `60000`
- `SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS`: `true`

The production public signer preflight requires this durable Upstash ledger and safe app-level admin route rate limiting, and checks that `/v1/agents` plus `/v1/agents/:agentId/ledger/:idempotencyKey` are admin-gated without calling payment, signing, MPP fetch, or provider execution routes. The local production readiness gate also requires app-level admin route rate limiting before env upload.

## Required Values To Collect

Do not commit these values:

- Turnkey organization ID;
- Turnkey API public key;
- Turnkey API private key;
- Turnkey wallet ID;
- Turnkey wallet account address;
- Turnkey policy ID;
- Tempo Access Key address;
- Tempo Access Key public key hex;
- Turnkey `signWith` value for the Access Key signer material;
- Tempo Access Key expiry;
- Tempo Access Key remaining limit;
- first authorization transaction hash.

## Sources Checked

- Turnkey account setup: `https://docs.turnkey.com/getting-started/quickstart`
- Turnkey create wallet: `https://docs.turnkey.com/api-reference/activities/create-wallet`
- Turnkey Tempo support: `https://docs.turnkey.com/networks/tempo`
- Turnkey Tempo policy examples: `https://docs.turnkey.com/concepts/policies/examples/tempo`
- Turnkey raw payload signing: `https://docs.turnkey.com/api-reference/activities/sign-raw-payloads`
- Turnkey official Tempo example: `https://github.com/tkhq/sdk/tree/main/examples/with-tempo`
- Tempo Account Keychain: `https://docs.tempo.xyz/protocol/transactions/AccountKeychain`
- Tempo transaction spec: `https://docs.tempo.xyz/protocol/transactions/spec-tempo-transaction`
- Tempo keychain Go package: `https://pkg.go.dev/github.com/tempoxyz/tempo-go/pkg/keychain`

## Next Research/Implementation Gate

Before the first real outbound payment:

1. Configure real Turnkey org, wallet/account, API key, and policy values outside source control.
2. Use `TURNKEY_SIGN_WITH_MODE=wallet` for the simplest first-live path, or `TURNKEY_SIGN_WITH_MODE=access_key` only after the dedicated raw-signing values and owner-reviewed policy exist.
3. Generate and review the local Turnkey policy draft before creating the policy manually in Turnkey.
4. Keep it behind `live-readiness-check.js` and tiny first-test limits.
5. Run `node scripts\access-key-signing-capability.js` to confirm the installed SDK capability before touching live access-key mode.
6. For Access Key mode, configure `TURNKEY_ACCESS_KEY_SIGN_WITH`, `TURNKEY_ACCESS_KEY_PUBLIC_KEY`, `TURNKEY_ACCESS_KEY_POLICY_ID`, and `TURNKEY_ACCESS_KEY_MODE_AUDITED=true`.
7. Keep live Access Key payments disabled until `security-audit-local.js`, fake-provider tests, on-chain Access Key readiness, Turnkey raw-signing policy review, and one owner-approved live smoke all pass.
8. Repeat `node scripts\security-audit-local.js`, `node scripts\access-key-signing-capability.js`, `node scripts\turnkey-live-handoff-check.js --env-file .secrets\signer-live.env`, `node scripts\turnkey-policy-draft.js --env-file .secrets\signer-live.env --expected-amount-base-units 1000 --signer-api-user-id <TURNKEY_SIGNER_API_USER_ID>`, `node scripts\live-readiness-check.js --env-file .secrets\signer-live.env`, and `.\scripts\add-vercel-live-env.ps1 -EnvFile .secrets\signer-live.env -Target production -DryRun`.
