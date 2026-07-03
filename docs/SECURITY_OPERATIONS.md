# Security Operations

Use this checklist before listing, after deploys, and whenever credentials or payment policy change.

## Local Source Checks

```powershell
cd tempo-agent-intel-api
npm test
npm run audit:local
npm audit --omit=dev

cd ..\tempo-outbound-signer
npm test
npm run audit:local
npm audit --omit=dev
```

## Publish Hygiene

Before pushing public source:

- Confirm `.secrets/`, `.data/`, `.vercel/`, `.agents/`, `.tmp/`, `node_modules/`, generated output, logs, and real `.env` files are not tracked.
- Confirm only `.env.example` files are public.
- Run a high-confidence scan for private keys, bearer tokens, Turnkey keys, Upstash tokens, Vercel tokens, GitHub tokens, and seed phrases.
- Do not publish internal live readiness artifacts, wallet inventories, balance dumps, or historical operational runbooks.

## Live Runtime Checks

From a private operator environment:

```powershell
cd tempo-agent-intel-api
npm run monitor:public
npm run preflight:public-production
npm run listing:readiness
```

Signer:

```powershell
cd tempo-outbound-signer
npm run preflight:public-production
npm run readiness:access-key
```

## Rotation Rules

- Rotate Tempo Access Keys before expiry.
- Keep Access Key limits small and purpose-specific.
- Rotate Vercel, Upstash, Turnkey, and admin tokens immediately after suspected exposure.
- Keep root wallet material out of Vercel and out of this repository.
- Prefer separate payer/canary wallets and separate signer policy scopes per agent.

## Current Known Tradeoff

The MVP production shortcut may use a shared Upstash backend with separate prefixes. Prefixes reduce accidental key collision, but a leaked shared Upstash token can still access both namespaces. Treat Upstash token exposure as high impact.
