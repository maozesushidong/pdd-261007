param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{2,62}$')]
  [string]$ShopId,

  [ValidateRange(1, 10000)]
  [int]$MaxItems = 10000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
$nodeExecutable = Join-Path $installRoot 'runtime\node\node.exe'
$runner = Join-Path $projectRoot 'apps\worker\src\postgres-playwright-runner.mjs'

if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  throw "Missing native Node.js runtime: $nodeExecutable"
}

. (Join-Path $PSScriptRoot 'load-native-windows-env.ps1') -ProjectRoot $projectRoot

$env:WORKER_SHOP_ID = $ShopId
$env:WORKER_ID = "return-refund-worker-$ShopId"
$env:WORKER_LIVE_APPROVED = 'true'
$env:WORKFLOW_BROWSER_MODE = 'headed'
$env:WORKER_RESIDENT_BROWSER = 'true'
$env:WORKER_POLL_INTERVAL_MS = '10000'
$env:RETURN_REFUND_ONLY = 'true'
$env:RETURN_REFUND_SCAN_ONCE = 'false'
$env:RETURN_REFUND_SCAN_ENABLED = 'true'
$env:RETURN_REFUND_AUTO_APPROVE_ENABLED = 'true'
$env:RETURN_REFUND_SCAN_INTERVAL_MS = '1800000'
$env:RETURN_REFUND_SCAN_MAX_ITEMS = [string]$MaxItems
$env:RETURN_REFUND_SCAN_MAX_DURATION_MS = '7200000'
$env:RETURN_REFUND_VISIBLE_STEP_DELAY_MS = '1500'

Write-Output "Starting visible PDD return-refund worker: $ShopId (full scan, real execution enabled)"
& $nodeExecutable $runner
if ($LASTEXITCODE -ne 0) {
  throw "Return-refund worker failed with exit code $LASTEXITCODE"
}
