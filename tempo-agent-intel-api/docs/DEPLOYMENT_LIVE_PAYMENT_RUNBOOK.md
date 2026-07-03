# Deployment Live Payment Runbook

This public runbook is intentionally sanitized. It documents the guarded deployment flow without historical transaction hashes, wallet addresses, balances, access-key identifiers, local file names, or production secret values.

## Production Deploy Guard

Use the guarded helper for production deployments:

```powershell
.\scripts\deploy-vercel-production.ps1 -DryRun
```

After the dry run passes and the owner has separately confirmed the production boundary:

```powershell
.\scripts\deploy-vercel-production.ps1 -ConfirmProductionDeploy
```

The helper is fail-closed. It runs production readiness checks, full-stack handoff checks, Vercel build, build-output secret sweep, and then deploys the prebuilt output.

## Required Private Inputs

Keep these values outside Git:

- Vercel project secrets.
- Upstash REST URL/token values.
- Turnkey organization, API user, API key, policy, and signer values.
- Agent receiving wallet address.
- Tempo Access Key metadata and private signer material.
- Admin tokens and cron bearer secret.

Use `.env.example` only as a shape reference. Real values belong in Vercel sensitive env, local `.secrets/`, or another private secret manager.

## Public Safety Notes

- Run `npm test` before deploying after source changes.
- Run `npm run audit:local` before uploading env or building production.
- Run `npm audit --omit=dev` before public release.
- Never commit `.secrets/`, `.data/`, `.vercel/`, `.agents/`, `.tmp/`, `node_modules/`, build output, logs, or real `.env` files.
- Do not paste live transaction artifacts or wallet inventories into public docs.
