# Security Publish Audit - 2026-07-03

Scope:

- `tempo-agent-intel-api`
- `tempo-outbound-signer`
- publish bundle root

This repository is a public-source bundle. Runtime secrets and local operating state are intentionally excluded.

## Excluded From GitHub

- `.secrets/`
- `.data/`
- `.vercel/`
- `.agents/`
- `.tmp/`
- `node_modules/`
- `output/`
- `test-results/`
- `.env`
- `.env.*` except `.env.example`
- logs

## Checks Performed

- Agent test suite: passed, 161 tests.
- Agent local security audit: passed.
- Agent production dependency audit: `npm audit --omit=dev`, 0 vulnerabilities.
- Signer test suite: passed, 80 tests.
- Signer local security audit: passed.
- Signer production dependency audit: `npm audit --omit=dev`, 0 vulnerabilities.
- Publish bundle forbidden-directory scan: no `.secrets`, `.data`, `.vercel`, `.agents`, `.tmp`, `node_modules`, `output`, `test-results`, or nested `.git` directories found.
- Publish bundle secret-like assignment scan: no real runtime secrets identified. Matches were source-code variables, secret generators, placeholders, or test-only fake values.
- Pre-public hardening pass: removed internal live readiness/status/audit artifacts with historical transaction and wallet metadata from the publish history.
- Pre-public hardening pass: replaced live receiver fallback addresses in standalone payment scripts with zero-address placeholders so real recipients must come from explicit env/CLI values.

## Residual Risks Not Solved By GitHub Hygiene

- The live production deployment uses external Vercel and Upstash configuration that is not stored in this repository.
- The no-card production shortcut uses a shared Upstash backend with separate key prefixes; a leaked Upstash token would still be high impact.
- Local canary payer wallets are intentionally local-only and not included here.
- Publishing code does not publish or rotate production secrets. Rotate any live credential separately if exposure is suspected.
