# Security Policy

Agent Launch Intel Stack handles machine-payment flows, so security reports are welcome.

## Reporting

Please report suspected vulnerabilities privately:

- Email: sergo565456@gmail.com
- Subject prefix: `[Agent Launch Intel Security]`

Do not open a public GitHub issue for vulnerabilities, leaked credentials, wallet material, payment bypasses, or signer-policy weaknesses.

## Scope

In scope:

- Payment verification bypasses.
- Report access-control bypasses.
- Idempotency or replay bugs.
- Outbound signer policy bypasses.
- Admin route exposure.
- Secret leakage through logs, reports, readiness checks, build output, or public docs.
- Unsafe defaults that could enable live payments without explicit configuration.

Out of scope:

- Denial-of-service without a concrete security impact.
- Social engineering.
- Attacks requiring access to the owner's private GitHub, Vercel, Upstash, Turnkey, or wallet accounts.
- Scanner-only dependency reports without an exploitable path in this project.

## Operational Security Notes

- Production secrets are not stored in this repository.
- Real `.env` files, `.secrets/`, `.data/`, `.vercel/`, `.agents/`, `.tmp/`, logs, generated output, and `node_modules/` are excluded.
- The public agent should not receive root wallet private keys.
- Outbound spending should go through the policy-gated signer with small per-call and daily caps.
- Tempo Access Keys should be short-lived, limited, and rotated before expiry.
- Any suspected exposure of Vercel, Upstash, Turnkey, Tempo, or wallet material should be treated as credential compromise and rotated outside this repository.
