# Turnkey Next Steps

This project is ready for a mock signer flow plus local tests of the direct Turnkey wallet-mode adapter and the fail-closed Tempo Access Key raw-signing wrapper. Real Turnkey signing is blocked until account-specific credentials, wallet/access-key values, policy IDs, and owner approval exist.

Pinned recommended path: see `docs/RECOMMENDED_TURNKEY_TEMPO_PATH.md`.

## Required manual setup

1. Create a Turnkey organization for Tempo agents.
2. Create one wallet/account per agent.
3. Create a policy for each wallet:
   - allow only Tempo chain `4217`;
   - allow only Tempo USDC.e;
   - allow only known MPP recipients;
   - enforce per-call and daily limits;
   - deny arbitrary signing.
4. Record public wallet addresses in `AGENT_WALLETS_JSON`.
5. Configure secret runtime values outside source:
   - `TURNKEY_ORGANIZATION_ID`
   - `TURNKEY_API_PUBLIC_KEY`
   - `TURNKEY_API_PRIVATE_KEY`
   - `TURNKEY_POLICY_ID`
   - `TURNKEY_SIGN_WITH_MODE=wallet` for the simplest first-live path, or `TURNKEY_SIGN_WITH_MODE=access_key` plus the dedicated Access Key values below
6. Keep `TURNKEY_SPONSOR_WITH` empty until sponsored transfers are implemented.
7. Authorize a Tempo Access Key with a small limit and short expiry, then record its public address in `AGENT_WALLETS_JSON`.
8. For Access Key live mode only, configure `TURNKEY_ACCESS_KEY_SIGN_WITH`, `TURNKEY_ACCESS_KEY_PUBLIC_KEY`, `TURNKEY_ACCESS_KEY_POLICY_ID`, and set `TURNKEY_ACCESS_KEY_MODE_AUDITED=true` only after local audit and owner review pass.
9. Run `node scripts\live-readiness-check.js`; it must pass before the first real outbound micro-payment.

## Current implementation status

- `src/providers/turnkeyProvider.js` implements direct Turnkey wallet-mode Tempo transfers.
- `src/providers/turnkeyProvider.js` also implements `TURNKEY_SIGN_WITH_MODE=access_key` through a raw-signing wrapper that builds a Tempo Keychain account and signs the inner hash with Turnkey `signRawPayload`.
- `scripts/access-key-signing-capability.js` is read-only and proves the installed `viem/tempo` and Turnkey SDK surfaces without calling Turnkey, RPC, payment, or MPP routes.
- `TURNKEY_SPONSOR_WITH` is intentionally rejected until sponsored Tempo transfers are implemented.

## Why this is safer than Vercel raw keys

Vercel does not need `AGENT_ACCESS_KEY_PRIVATE_KEY`. A compromised agent runtime can only call the signer. The signer still applies service, recipient, amount, daily limit, token, chain, and idempotency checks before asking Turnkey to sign.

## Useful docs

- Turnkey overview: https://docs.turnkey.com/concepts/introduction
- Turnkey server client: https://docs.turnkey.com/sdks/advanced/turnkey-client
- Turnkey create wallet: https://docs.turnkey.com/api-reference/activities/create-wallet
- Turnkey Tempo support: https://docs.turnkey.com/networks/tempo
- Turnkey embedded wallets and delegated agent signing: https://docs.turnkey.com/solutions/embedded-wallets/embedded-consumer-wallet
- Vercel OIDC: https://vercel.com/docs/oidc
