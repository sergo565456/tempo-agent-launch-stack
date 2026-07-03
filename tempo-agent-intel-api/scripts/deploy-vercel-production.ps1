param(
  [string]$EnvFile = ".secrets\agent-production.env",
  [string]$SignerEnvFile = "..\tempo-outbound-signer\.secrets\signer-live.env",
  [switch]$DryRun,
  [switch]$ConfirmProductionDeploy
)

$ErrorActionPreference = "Stop"

function Assert-NoBuildOutputSecretLeaks {
  param([string]$OutputDir = ".vercel\output")

  if (-not (Test-Path -LiteralPath $OutputDir)) {
    throw "Vercel build output not found for secret sweep: $OutputDir"
  }

  $patterns = @(
    "-----BEGIN",
    "0x[a-fA-F0-9]{64}",
    "sk_live_",
    "sk_test_",
    "xox[baprs]-",
    "ghp_[A-Za-z0-9]{36}",
    "npm_[A-Za-z0-9]"
  )
  $root = (Resolve-Path -LiteralPath ".").Path
  $files = Get-ChildItem -LiteralPath $OutputDir -Recurse -File -Force | Where-Object { $_.FullName -notmatch "\\node_modules\\" }

  foreach ($file in $files) {
    $match = Select-String -LiteralPath $file.FullName -Pattern $patterns -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) {
      $relative = $file.FullName
      if ($relative.StartsWith($root)) {
        $relative = $relative.Substring($root.Length).TrimStart("\")
      }
      throw "Potential secret-looking literal found in Vercel build output: $relative. Deploy aborted."
    }
  }

  Write-Host "Build output secret sweep passed."
}

if (-not $DryRun -and -not $ConfirmProductionDeploy) {
  throw "Refusing to deploy production without -ConfirmProductionDeploy. Run with -DryRun first."
}

node scripts\production-readiness-check.js --env-file $EnvFile
if ($LASTEXITCODE -ne 0) {
  throw "Production readiness failed. Deploy aborted."
}

node scripts\full-stack-live-handoff-check.js --agent-env-file $EnvFile --signer-env-file $SignerEnvFile
if ($LASTEXITCODE -ne 0) {
  throw "Full-stack live handoff failed. Deploy aborted."
}

if ($DryRun) {
  Write-Host "Dry run only. Readiness passed; would build and deploy the public agent to Vercel production:"
  Write-Host "npx.cmd vercel build --prod --yes"
  Write-Host "Assert-NoBuildOutputSecretLeaks .vercel\output"
  Write-Host "npx.cmd vercel deploy --prebuilt --prod"
  exit 0
}

npx.cmd vercel build --prod --yes
if ($LASTEXITCODE -ne 0) {
  throw "Vercel production build failed. Deploy aborted."
}

Assert-NoBuildOutputSecretLeaks

npx.cmd vercel deploy --prebuilt --prod
if ($LASTEXITCODE -ne 0) {
  throw "Vercel production deploy failed."
}

Write-Host "Vercel production deploy completed. Run public production and autonomous readiness checks before any live outbound spend."
