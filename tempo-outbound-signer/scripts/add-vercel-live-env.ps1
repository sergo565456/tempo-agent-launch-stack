param(
  [string]$EnvFile = ".secrets\signer-live.env",
  [string]$Target = "production",
  [switch]$DryRun,
  [switch]$ConfirmSignerUpload
)

$ErrorActionPreference = "Stop"

function Get-EnvValue {
  param(
    [string]$Path,
    [string]$Key
  )

  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -like "$Key=*" } | Select-Object -First 1
  if (-not $line) {
    throw "Missing $Key in $Path"
  }
  $value = $line.Substring($line.IndexOf("=") + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    return $value.Substring(1, $value.Length - 2)
  }
  return $value
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

if (-not $DryRun -and -not $ConfirmSignerUpload) {
  throw "Refusing to upload signer env without -ConfirmSignerUpload. Run with -DryRun first."
}

$baseRequiredKeys = @(
  "SIGNER_PROVIDER",
  "SIGNER_ADMIN_TOKEN",
  "SIGNER_ADMIN_RATE_LIMIT_ENABLED",
  "SIGNER_ADMIN_RATE_LIMIT_MAX",
  "SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS",
  "SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS",
  "PUBLIC_BASE_URL",
  "LIVE_READINESS_MODE",
  "SIGNER_LEDGER_DURABLE",
  "SIGNER_LEDGER_BACKEND",
  "SIGNER_LEDGER_REDIS_PREFIX",
  "ALLOW_SHARED_UPSTASH_BACKEND",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "TEMPO_CHAIN_ID",
  "TEMPO_RPC_URL",
  "TEMPO_USDC_ADDRESS",
  "TEMPO_TOKEN_DECIMALS",
  "AGENT_WALLETS_JSON",
  "TURNKEY_API_BASE_URL",
  "TURNKEY_ORGANIZATION_ID",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_POLICY_ID",
  "TURNKEY_SIGNER_API_USER_ID",
  "TURNKEY_SIGN_WITH_MODE"
)

$accessKeyRequiredKeys = @(
  "TURNKEY_ACCESS_KEY_SIGN_WITH",
  "TURNKEY_ACCESS_KEY_PUBLIC_KEY",
  "TURNKEY_ACCESS_KEY_POLICY_ID",
  "TURNKEY_ACCESS_KEY_MODE_AUDITED"
)

$signWithMode = Get-EnvValue $EnvFile "TURNKEY_SIGN_WITH_MODE"
if ($signWithMode -ne "wallet" -and $signWithMode -ne "access_key") {
  throw "TURNKEY_SIGN_WITH_MODE must be wallet or access_key."
}

$uploadKeys = @($baseRequiredKeys)
if ($signWithMode -eq "access_key") {
  $uploadKeys += $accessKeyRequiredKeys
}

foreach ($key in $uploadKeys) {
  $value = Get-EnvValue $EnvFile $key
}

node scripts\turnkey-live-handoff-check.js --env-file $EnvFile
if ($LASTEXITCODE -ne 0) {
  throw "Turnkey live handoff failed. Env upload aborted."
}

node scripts\live-readiness-check.js --env-file $EnvFile
if ($LASTEXITCODE -ne 0) {
  throw "Signer live readiness failed. Env upload aborted."
}

node scripts\tempo-access-key-readiness.js --env-file $EnvFile
if ($LASTEXITCODE -ne 0) {
  throw "Tempo Access Key readiness failed. Env upload aborted."
}

if ($DryRun) {
  Write-Host "Dry run only. Readiness passed; would upload the following keys to Vercel $Target as sensitive:"
  foreach ($key in $uploadKeys) {
    Write-Host "- $key"
  }
  exit 0
}

foreach ($key in $uploadKeys) {
  $value = Get-EnvValue $EnvFile $key
  $value | npx.cmd vercel env add $key $Target --sensitive --force --yes --no-color
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload $key"
  }
  Write-Host "Uploaded $key to Vercel $Target as sensitive."
}
