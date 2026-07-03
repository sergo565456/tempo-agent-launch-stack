# Root Wallet And Access Key Setup

## Current Model

Root wallet belongs to the owner. The agent must never receive the root private key.

The agent receives only a secondary Access Key after the Root Key authorizes it on Tempo.

Tempo docs define this hierarchy:

- Root Key can authorize, revoke, and update Access Keys.
- Access Keys are secondary keys.
- Access Keys can have expiry timestamps and per-TIP20 token spending limits.
- Access Keys cannot call mutable key-management functions.

## Local Files

Generated secrets live under:

```text
.secrets/
```

This folder is gitignored.

Files:

```text
.secrets/root-wallet.owner-only.json
.secrets/agent-access-key.env
.secrets/access-key-authorization-plan.json
```

Meaning:

- `root-wallet.owner-only.json` contains the owner Root wallet private key. Do not load this into the app.
- `agent-access-key.env` contains the secondary key that the agent may use after authorization.
- `access-key-authorization-plan.json` contains the root-signed authorization parameters and command template.

The root wallet file has a stricter Windows ACL and is intended for the owner account only. The agent runtime should use `agent-access-key.env`, not the root wallet file.

## Default Policy

The generated Access Key uses a conservative default policy:

```text
signature type: Secp256k1
expiry: 24 hours
enforce limits: true
token: Tempo USDC.e
limit: 1.00 USDC.e
```

The token address used by default is:

```text
0x20c000000000000000000000b9537d11c60e8b50
```

## Important Boundary

The key pair is generated locally now, but it is not enforceably authorized on Tempo until the Root wallet signs and submits `authorizeKey(...)` to the Account Keychain precompile:

```text
0xAAAAAAAA00000000000000000000000000000000
```

Do not send that on-chain transaction without explicit approval.

## Generate Again

```text
node scripts\create-root-access-wallet.js
```

Custom example:

```text
node scripts\create-root-access-wallet.js --limit 5.00 --expiry-hours 168
```

## Security Notes

- Do not paste the root private key into chat.
- Do not add root private key values to `.env`.
- Do not commit `.secrets/`.
- Move the root wallet into your own password manager or hardware-backed storage after creation.
- The current documented spending limits apply to TIP-20 token transfers and related approval flows, not every possible native transfer or contract interaction.
