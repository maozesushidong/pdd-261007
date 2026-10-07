param(
  [Parameter(Mandatory)]
  [ValidateSet('panapopo-healthcare', 'panapopo-medical-device', 'songteng-yazc-overseas')]
  [string]$ShopId,

  [Parameter(Mandatory)]
  [ValidatePattern('^[0-9A-Za-z-]{10,}$')]
  [string]$OrderNumber,

  [Parameter(Mandatory)]
  [ValidatePattern('^[0-9A-Za-z-]{8,}$')]
  [string]$AftersaleNumber,

  [Parameter(Mandatory)]
  [ValidatePattern('^https://mms\.pinduoduo\.com/')]
  [string]$DetailUrl
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
$env:WORKER_ID = "return-refund-validation-$ShopId"
$env:WORKER_LIVE_APPROVED = 'true'
$env:WORKFLOW_BROWSER_MODE = 'headed'
$env:WORKER_RESIDENT_BROWSER = 'true'
$env:RETURN_REFUND_SCAN_ONCE = 'true'
$env:RETURN_REFUND_KEEP_BROWSER_OPEN = 'false'
$env:RETURN_REFUND_SCAN_ENABLED = 'true'
$env:RETURN_REFUND_AUTO_APPROVE_ENABLED = 'false'
$env:RETURN_REFUND_SCAN_MAX_DURATION_MS = '600000'
$env:RETURN_REFUND_VISIBLE_STEP_DELAY_MS = '1500'
$env:RETURN_REFUND_VALIDATE_ORDER_NUMBER = $OrderNumber
$env:RETURN_REFUND_VALIDATE_AFTERSALE_NUMBER = $AftersaleNumber
$env:RETURN_REFUND_VALIDATE_DETAIL_URL = $DetailUrl

Write-Output "Starting visible PDD return-refund read-only validation: $ShopId / $AftersaleNumber"
& $nodeExecutable $runner
if ($LASTEXITCODE -ne 0) {
  throw "Return-refund read-only validation failed with exit code $LASTEXITCODE"
}
Write-Output "Return-refund read-only validation completed: $ShopId / $AftersaleNumber"
