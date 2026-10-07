param(
  [Parameter(Mandatory)]
  [ValidateSet('panapopo-healthcare', 'panapopo-medical-device', 'songteng-yazc-overseas')]
  [string]$ShopId,

  [ValidateRange(1, 10)]
  [int]$MaxItems = 3
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
$env:WORKER_ID = "return-refund-scan-$ShopId"
$env:WORKER_LIVE_APPROVED = 'true'
$env:RETURN_REFUND_SCAN_ONCE = 'true'
$env:RETURN_REFUND_KEEP_BROWSER_OPEN = 'true'
$env:RETURN_REFUND_SCAN_ENABLED = 'true'
$env:RETURN_REFUND_AUTO_APPROVE_ENABLED = 'false'
$env:RETURN_REFUND_SCAN_MAX_ITEMS = [string]$MaxItems
$env:RETURN_REFUND_SCAN_MAX_DURATION_MS = '120000'
$env:RETURN_REFUND_VISIBLE_STEP_DELAY_MS = '1500'

Write-Output "Starting visible PDD return-refund read-only scan: $ShopId (max $MaxItems)"
& $nodeExecutable $runner
if ($LASTEXITCODE -ne 0) {
  throw "Return-refund read-only scan failed with exit code $LASTEXITCODE"
}
Write-Output "Return-refund read-only scan completed: $ShopId"
