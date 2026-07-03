param(
  [switch]$AllowLegacyOutboundOnly
)

$ErrorActionPreference = "Stop"

if (-not $AllowLegacyOutboundOnly) {
  throw "This outbound-only helper is deprecated. Use scripts\add-vercel-production-env.ps1 after scripts\production-readiness-check.js passes."
}

throw "Legacy outbound-only upload is intentionally disabled for the autonomous production agent path."
