param(
  [string]$EnvFile = ".secrets\agent-production.env",
  [string]$AgentUrl = "",
  [string]$SignerUrl = "",
  [string]$ArmingIdempotencyKey = "",
  [string]$Target = "production",
  [switch]$DryRun,
  [switch]$ConfirmCronEnablement,
  [switch]$AllowHttp
)

$ErrorActionPreference = "Stop"

$requiredEnvKeys = @(
  "PUBLIC_BASE_URL",
  "OUTBOUND_SIGNER_BASE_URL",
  "CRON_SECRET",
  "OUTBOUND_CRON_IDEMPOTENCY_PREFIX"
)

$uploadKeys = @(
  "ENABLE_OUTBOUND_CRON",
  "CRON_SECRET",
  "OUTBOUND_CRON_IDEMPOTENCY_PREFIX",
  "OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT",
  "OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY"
)

function Read-EnvFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Env file not found: $Path"
  }

  $values = @{}
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      continue
    }

    $index = $line.IndexOf("=")
    if ($index -lt 1) {
      continue
    }

    $key = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }

  return $values
}

function Require-Key {
  param(
    [hashtable]$Values,
    [string]$Key
  )

  if (-not $Values.ContainsKey($Key)) {
    throw "Missing $Key in $EnvFile"
  }
  return $Values[$Key]
}

function Test-PublicUrl {
  param([string]$Value)

  if ($AllowHttp) {
    return $Value -match '^https?://'
  }
  return $Value -match '^https://'
}

function Test-StrongSecret {
  param([string]$Value)
  return $Value -and $Value.Length -ge 32 -and -not ($Value -match '^__FILL_[A-Z0-9_]+__$')
}

if (-not $DryRun -and -not $ConfirmCronEnablement) {
  throw "Refusing to upload cron env without -ConfirmCronEnablement. Run with -DryRun first."
}

$envValues = Read-EnvFile $EnvFile
foreach ($key in $requiredEnvKeys) {
  [void](Require-Key $envValues $key)
}

if (-not $AgentUrl) {
  $AgentUrl = $envValues["PUBLIC_BASE_URL"]
}
if (-not $SignerUrl) {
  $SignerUrl = $envValues["OUTBOUND_SIGNER_BASE_URL"]
}
if (-not $ArmingIdempotencyKey) {
  $ArmingIdempotencyKey = $env:OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY
}

if (-not (Test-PublicUrl $AgentUrl)) {
  throw "AgentUrl must be a public HTTPS URL. Use -AllowHttp only for local diagnostics."
}
if (-not (Test-PublicUrl $SignerUrl)) {
  throw "SignerUrl must be a public HTTPS URL. Use -AllowHttp only for local diagnostics."
}
if (-not (Test-StrongSecret $envValues["CRON_SECRET"])) {
  throw "CRON_SECRET in $EnvFile must be a strong non-placeholder secret with at least 32 characters."
}
if (-not ($envValues["OUTBOUND_CRON_IDEMPOTENCY_PREFIX"] -match '^[a-zA-Z0-9._:-]{1,96}$')) {
  throw "OUTBOUND_CRON_IDEMPOTENCY_PREFIX must contain only letters, numbers, dots, underscores, colons, or hyphens."
}
if (-not ($ArmingIdempotencyKey -match '^[a-zA-Z0-9._:-]{1,160}$')) {
  throw "ArmingIdempotencyKey must be the verified first manual outbound payment idempotency key."
}
if (-not $env:OUTBOUND_ADMIN_TOKEN) {
  throw "OUTBOUND_ADMIN_TOKEN must be present in the local shell for read-only cron arming readiness."
}
if (-not ($env:SIGNER_ADMIN_TOKEN -or $env:OUTBOUND_SIGNER_ADMIN_TOKEN)) {
  throw "SIGNER_ADMIN_TOKEN or OUTBOUND_SIGNER_ADMIN_TOKEN must be present in the local shell for read-only cron arming readiness."
}

$readinessArgs = @(
  "scripts\public-cron-arming-readiness.js",
  "--agent-url", $AgentUrl,
  "--signer-url", $SignerUrl,
  "--idempotency-key", $ArmingIdempotencyKey,
  "--expect-cron-disabled"
)
if ($AllowHttp) {
  $readinessArgs += "--allow-http"
}

node @readinessArgs
if ($LASTEXITCODE -ne 0) {
  throw "Cron arming readiness failed. Cron env upload aborted."
}

$uploadValues = @{
  ENABLE_OUTBOUND_CRON = "true"
  CRON_SECRET = $envValues["CRON_SECRET"]
  OUTBOUND_CRON_IDEMPOTENCY_PREFIX = $envValues["OUTBOUND_CRON_IDEMPOTENCY_PREFIX"]
  OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT = "true"
  OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY = $ArmingIdempotencyKey
}

if ($DryRun) {
  Write-Host "Dry run only. Cron arming readiness passed; would upload the following keys to Vercel $Target as sensitive:"
  foreach ($key in $uploadKeys) {
    Write-Host "- $key"
  }
  Write-Host "No cron bearer token, env upload, deploy, signing, payment, signer MPP fetch, downstream MPP route, or authorized cron was executed."
  exit 0
}

foreach ($key in $uploadKeys) {
  $uploadValues[$key] | npx.cmd vercel env add $key $Target --sensitive --force --yes --no-color
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload $key"
  }
  Write-Host "Uploaded $key to Vercel $Target as sensitive."
}

Write-Host "Cron env uploaded. Redeploy the public agent, then run public cron readiness with --expect-auth-gated before any authorized cron verification."
