param(
  [string]$EnvFile = ".secrets\agent-production.env",
  [string]$SignerEnvFile = "..\tempo-outbound-signer\.secrets\signer-live.env",
  [string]$Target = "production",
  [switch]$DryRun,
  [switch]$ConfirmProductionUpload
)

$ErrorActionPreference = "Stop"

$requiredKeys = @(
  "PAYMENT_MODE",
  "ENABLED_PAYMENT_RAILS",
  "PUBLIC_BASE_URL",
  "EXPOSE_RUNTIME_READINESS_DETAILS",
  "REQUIRE_IDEMPOTENCY_KEY_FOR_PAID",
  "REQUIRE_REPORT_ACCESS_PROOF",
  "CRON_SECRET",
  "PRICE_QUICK_USD",
  "PRICE_STANDARD_USD",
  "PRICE_DEEP_USD",
  "MAX_REPORT_PRICE_USD",
  "REPORT_RATE_LIMIT_ENABLED",
  "REPORT_RATE_LIMIT_MAX",
  "REPORT_RATE_LIMIT_WINDOW_MS",
  "REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS",
  "AGENT_STORAGE_BACKEND",
  "AGENT_STORAGE_REDIS_PREFIX",
  "ALLOW_SHARED_UPSTASH_BACKEND",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "RECEIVE_TEMPO_ADDRESS",
  "TEMPO_RPC_URL",
  "TEMPO_CHAIN_ID",
  "TEMPO_USDC_ADDRESS",
  "TEMPO_TOKEN_DECIMALS",
  "TEMPO_MPP_LIVE_ENABLED",
  "TEMPO_MPP_DEPS_ROOT",
  "TEMPO_MPP_SECRET_KEY",
  "TEMPO_MPP_REALM",
  "TEMPO_MPP_WAIT_FOR_CONFIRMATION",
  "TEMPO_MPP_VERIFY_ONCHAIN_ON_REQUEST",
  "TEMPO_MPP_SUPPORTED_MODES",
  "OUTBOUND_LIVE_PAYMENTS",
  "OUTBOUND_PAYMENT_PROVIDER",
  "MAX_OUTBOUND_PER_CALL_USD",
  "MAX_OUTBOUND_DAILY_USD",
  "OUTBOUND_ALLOWED_SERVICES",
  "OUTBOUND_ALLOW_DYNAMIC_MPP_RECIPIENT",
  "OUTBOUND_DENY_UNKNOWN_SERVICES",
  "OUTBOUND_ADMIN_TOKEN",
  "OUTBOUND_TARGET_SERVICE",
  "OUTBOUND_TARGET_ENDPOINT",
  "OUTBOUND_TARGET_AMOUNT_BASE_UNITS",
  "OUTBOUND_TARGET_RECIPIENT",
  "OUTBOUND_SIGNER_BASE_URL",
  "OUTBOUND_SIGNER_ADMIN_TOKEN",
  "OUTBOUND_SIGNER_AGENT_ID",
  "OUTBOUND_SIGNER_COMMAND",
  "ENABLE_OUTBOUND_CRON",
  "OUTBOUND_CRON_IDEMPOTENCY_PREFIX",
  "OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT",
  "OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY"
)

$forbiddenKeys = @(
  "ROOT_PRIVATE_KEY",
  "OWNER_PRIVATE_KEY",
  "TREASURY_PRIVATE_KEY",
  "MNEMONIC",
  "SEED_PHRASE",
  "AGENT_ACCESS_KEY_PRIVATE_KEY"
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

$envValues = Read-EnvFile $EnvFile

if (-not $DryRun -and -not $ConfirmProductionUpload) {
  throw "Refusing to upload production env without -ConfirmProductionUpload. Run with -DryRun first."
}

foreach ($key in $forbiddenKeys) {
  if ($envValues.ContainsKey($key) -and $envValues[$key]) {
    throw "$key must not be present in the public agent Vercel runtime."
  }
}

foreach ($key in $requiredKeys) {
  if (-not $envValues.ContainsKey($key)) {
    throw "Missing $key in $EnvFile"
  }
}

node scripts\production-readiness-check.js --env-file $EnvFile
if ($LASTEXITCODE -ne 0) {
  throw "Production readiness failed. Env upload aborted."
}

node scripts\full-stack-live-handoff-check.js --agent-env-file $EnvFile --signer-env-file $SignerEnvFile
if ($LASTEXITCODE -ne 0) {
  throw "Full-stack live handoff failed. Env upload aborted."
}

if ($DryRun) {
  Write-Host "Dry run only. Readiness passed; would upload the following keys to Vercel $Target as sensitive:"
  foreach ($key in $requiredKeys) {
    Write-Host "- $key"
  }
  exit 0
}

foreach ($key in $requiredKeys) {
  $envValues[$key] | npx.cmd vercel env add $key $Target --sensitive --force --yes --no-color
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload $key"
  }
  Write-Host "Uploaded $key to Vercel $Target as sensitive."
}
