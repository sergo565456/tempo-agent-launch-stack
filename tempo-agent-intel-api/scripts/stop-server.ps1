$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot ".data\server.pid"

if (-not (Test-Path -LiteralPath $pidPath)) {
  Write-Output "No .data/server.pid file found."
  exit 0
}

$serverPid = (Get-Content -LiteralPath $pidPath | Select-Object -First 1).Trim()

if (-not $serverPid) {
  Write-Output "Server PID file is empty."
  exit 0
}

$process = Get-Process -Id ([int]$serverPid) -ErrorAction SilentlyContinue
if (-not $process) {
  Write-Output "No running process found for PID $serverPid."
  exit 0
}

Stop-Process -Id ([int]$serverPid) -Force
Write-Output "Stopped Agent Launch Intel API server PID $serverPid."
