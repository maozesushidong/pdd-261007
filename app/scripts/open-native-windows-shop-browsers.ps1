param([switch]$ConsoleOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
. (Join-Path $PSScriptRoot 'load-native-windows-env.ps1') -ProjectRoot $projectRoot
$serverChrome = & (Join-Path $PSScriptRoot 'resolve-native-windows-chrome.ps1') -PassThru
$node = Join-Path $installRoot 'runtime\node\node.exe'
$shopBrowserLauncher = Join-Path $PSScriptRoot 'run-native-windows-shop-browser.mjs'

Start-Process -FilePath $serverChrome.Path -ArgumentList @('--new-window', 'http://127.0.0.1:4173/')
if ($ConsoleOnly) { exit 0 }

$shopsRoot = Join-Path $installRoot 'data\workflow\shops'
$shopIds = @(Get-ChildItem -LiteralPath $shopsRoot -Directory -ErrorAction Stop |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'browser-profile') } |
  Select-Object -ExpandProperty Name)
$loginUrl = 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmms.pinduoduo.com%2F'
foreach ($shopId in $shopIds) {
  $profile = Join-Path $installRoot "data\workflow\shops\$shopId\browser-profile"
  if (-not (Test-Path -LiteralPath $profile)) { throw "Missing browser profile: $shopId" }
  Start-Process -FilePath $node -ArgumentList @($shopBrowserLauncher, $shopId, '-') | Out-Null
  Start-Sleep -Milliseconds 750
}

Write-Output "Opened the local console and $($shopIds.Count) PDD shop login window(s) with server Chrome $($serverChrome.Version)."
