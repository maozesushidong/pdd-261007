$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Join-Path $root 'runtime\node\node.exe'
$app = Join-Path $root 'app'
$script = Join-Path $app 'scripts\backfill-verified-analyses.mjs'
$logDir = Join-Path $root 'logs-local'
$logFile = Join-Path $logDir 'analysis-sync.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Push-Location $app
try {
  $output = & $node $script --apply 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) failed exit=$exitCode $($output -join ' ')" -Encoding UTF8
    throw "Verified analysis materialization failed with exit code $exitCode"
  }
  $result = $output | Select-Object -Last 1 | ConvertFrom-Json
  if ([int]$result.candidates -gt 0) {
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) candidates=$($result.candidates) oms=$($result.inserted.oms) logistics=$($result.inserted.logistics) backup=$($result.backupPath)" -Encoding UTF8
  }
} finally {
  Pop-Location
}
