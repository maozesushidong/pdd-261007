[CmdletBinding()]
param(
  [string]$SourceAppRoot = 'C:\pdd-native\app',
  [string]$NodeExecutable = 'C:\pdd-native\runtime\node\node.exe',
  [string]$OverlayRoot = '',
  [string]$CleanupRoot = '',
  [switch]$KeepTestRoot
)

$ErrorActionPreference = 'Stop'
if (-not $OverlayRoot) {
  $OverlayRoot = Join-Path (Split-Path -Parent $PSScriptRoot) `
    '162_new_ordinary_scenarios\overlay'
}
$SourceAppRoot = [IO.Path]::GetFullPath($SourceAppRoot)
$NodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)
$OverlayRoot = [IO.Path]::GetFullPath($OverlayRoot)
foreach ($required in @($SourceAppRoot, $OverlayRoot)) {
  if (-not (Test-Path -LiteralPath $required -PathType Container)) {
    throw "Regression source directory is missing: $required"
  }
}
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  throw "Node executable is missing: $NodeExecutable"
}

function Remove-RegressionTestRoot([string]$Root) {
  $resolved = [IO.Path]::GetFullPath($Root)
  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
  $expectedPrefix = "$resolvedTemp\pdd-overlay-regression-"
  if (-not $resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe regression cleanup path: $resolved"
  }
  $rootJunction = Join-Path $resolved 'node_modules'
  if (Test-Path -LiteralPath $rootJunction) {
    $nodeModules = Get-Item -LiteralPath $rootJunction -Force
    if ($nodeModules.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      [IO.Directory]::Delete($rootJunction)
    }
  }
  if (Test-Path -LiteralPath $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $resolved) {
    $emptyRoot = Join-Path $env:TEMP ("pdd-overlay-regression-empty-{0}" -f [guid]::NewGuid().ToString('N'))
    try {
      New-Item -ItemType Directory -Path $emptyRoot -Force | Out-Null
      & robocopy.exe $emptyRoot $resolved /MIR /XJ /R:1 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "Regression mirror cleanup failed: $LASTEXITCODE" }
      Remove-Item -LiteralPath $resolved -Recurse -Force
    } finally {
      if (Test-Path -LiteralPath $emptyRoot) {
        Remove-Item -LiteralPath $emptyRoot -Recurse -Force
      }
    }
  }
  if (Test-Path -LiteralPath $resolved) { throw "Regression cleanup did not remove: $resolved" }
}

if ($CleanupRoot) {
  Remove-RegressionTestRoot $CleanupRoot
  Write-Output "Regression test root removed: $CleanupRoot"
  return
}

$testRoot = Join-Path $env:TEMP ("pdd-overlay-regression-{0}" -f [guid]::NewGuid().ToString('N'))
$junction = Join-Path $testRoot 'node_modules'
$previousDataRoot = [Environment]::GetEnvironmentVariable('WORKFLOW_DATA_ROOT', 'Process')
$previousShopId = [Environment]::GetEnvironmentVariable('WORKFLOW_SHOP_ID', 'Process')
$locationPushed = $false
$tests = @(
  @('workflow-runtime.mjs', '--self-test'),
  @('workflow.mjs', '--self-test'),
  @('scripts\ordinary-work-orders-self-test.mjs'),
  @('scripts\pdd-ordinary-form-ui-self-test.mjs'),
  @('scripts\ordinary-work-order-instance-self-test.mjs'),
  @('scripts\worker-runtime-self-test.mjs'),
  @('scripts\workflow-event-state-self-test.mjs'),
  @('scripts\dingtalk-dispatcher.mjs', '--self-test'),
  @('scripts\pdd-order-remark-self-test.mjs'),
  @('scripts\verification-wait-self-test.mjs'),
  @('scripts\return-refund-self-test.mjs'),
  @('scripts\worker-event-identity-self-test.mjs'),
  @('scripts\sync-windows-worker-state.mjs', '--self-test'),
  @('scripts\ordinary-latency-gate.mjs', '--self-test')
)

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $excluded = @(
    (Join-Path $SourceAppRoot '.git'),
    (Join-Path $SourceAppRoot '.codex'),
    (Join-Path $SourceAppRoot 'node_modules'),
    (Join-Path $SourceAppRoot 'node_modules-interrupted-20260807')
  )
  & robocopy.exe $SourceAppRoot $testRoot /E /COPY:DAT /DCOPY:DAT /XJ `
    /R:1 /W:1 /MT:16 /NP /NFL /NDL /NJH /NJS /XD @excluded | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Base copy failed: $LASTEXITCODE" }
  & robocopy.exe $OverlayRoot $testRoot /E /COPY:DAT /DCOPY:DAT /XJ `
    /R:1 /W:1 /MT:8 /NP /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Overlay copy failed: $LASTEXITCODE" }

  New-Item -ItemType Junction -Path $junction `
    -Target (Join-Path $SourceAppRoot 'node_modules') | Out-Null
  $env:WORKFLOW_DATA_ROOT = Join-Path $testRoot '.regression-data'
  $env:WORKFLOW_SHOP_ID = 'overlay-regression'
  Push-Location $testRoot
  $locationPushed = $true
  foreach ($test in $tests) {
    $file = $test[0]
    $arguments = @()
    if ($test.Count -gt 1) { $arguments += $test[1..($test.Count - 1)] }
    Write-Output ("RUN {0} {1}" -f $file, ($arguments -join ' '))
    & $NodeExecutable (Join-Path $testRoot $file) @arguments
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $file ($LASTEXITCODE)" }
  }
  Write-Output "REGRESSION_OK tests=$($tests.Count)"
} finally {
  if ($locationPushed) { Pop-Location }
  [Environment]::SetEnvironmentVariable('WORKFLOW_DATA_ROOT', $previousDataRoot, 'Process')
  [Environment]::SetEnvironmentVariable('WORKFLOW_SHOP_ID', $previousShopId, 'Process')
  if ($KeepTestRoot) {
    Write-Output "Regression test root retained: $testRoot"
  } elseif (Test-Path -LiteralPath $testRoot) {
    Remove-RegressionTestRoot $testRoot
  }
}
