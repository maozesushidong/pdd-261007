$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
$dataRoot = Join-Path $installRoot 'data\workflow'
$queueRoot = Join-Path $dataRoot 'supervisor\browser-launch-queue'
$resultRoot = Join-Path $dataRoot 'supervisor\browser-launch-results'
$chromeResolver = Join-Path $PSScriptRoot 'resolve-native-windows-chrome.ps1'
$shopBrowserLauncher = Join-Path $PSScriptRoot 'run-native-windows-shop-browser.mjs'
$node = Join-Path $installRoot 'runtime\node\node.exe'

. (Join-Path $PSScriptRoot 'load-native-windows-env.ps1') -ProjectRoot $projectRoot
New-Item -ItemType Directory -Force -Path $queueRoot, $resultRoot | Out-Null

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'native-node-not-found' }
if (-not (Test-Path -LiteralPath $shopBrowserLauncher -PathType Leaf)) { throw 'shop-browser-launcher-not-found' }

function Write-LaunchResult {
  param(
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][string]$ShopId,
    [Parameter(Mandatory)][string]$Status,
    [string]$ErrorCode,
    [int]$ProcessId = 0,
    [string]$BrowserVersion
  )
  $resultFile = Join-Path $resultRoot "$RequestId.json"
  $temporary = "$resultFile.$PID.tmp"
  [ordered]@{
    requestId = $RequestId
    shopId = $ShopId
    status = $Status
    error = $ErrorCode
    processId = $ProcessId
    browserVersion = $BrowserVersion
    completedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $resultFile -Force
}

while ($true) {
  $requests = @(Get-ChildItem -LiteralPath $queueRoot -Filter '*.json' -File -ErrorAction SilentlyContinue)
  foreach ($requestFile in $requests) {
    $processingFile = Join-Path $queueRoot ".$($requestFile.BaseName).processing"
    try {
      Move-Item -LiteralPath $requestFile.FullName -Destination $processingFile -ErrorAction Stop
    } catch {
      continue
    }

    $requestId = $requestFile.BaseName
    $shopId = ''
    try {
      $request = Get-Content -LiteralPath $processingFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $shopId = [string]$request.shopId
      if ([string]$request.requestId -ne $requestId -or
          $requestId -notmatch '^[0-9a-f-]{36}$' -or
          $shopId -notmatch '^[a-z0-9][a-z0-9-]{2,62}$') {
        throw 'invalid-browser-launch-request'
      }
      $serverChrome = & $chromeResolver -PassThru
      $profileRoot = Join-Path $dataRoot "shops\$shopId\browser-profile"
      New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
      $runningBrowser = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -like "*--user-data-dir=$profileRoot*" } |
        Select-Object -First 1)
      if ($runningBrowser.Count) {
        # The Dynamic Supervisor owns resident profiles. Killing the existing
        # tree here races its persistent context and produces a visible
        # close/relaunch loop. Reuse the live profile; the API can still send
        # an explicit focus/login command to its Worker.
        Write-LaunchResult `
          -RequestId $requestId `
          -ShopId $shopId `
          -Status 'already-running' `
          -ProcessId ([int]$runningBrowser[0].ProcessId) `
          -BrowserVersion 'existing-profile'
        continue
      }
      Start-Process -FilePath $node -ArgumentList @($shopBrowserLauncher, $shopId, $requestId) | Out-Null
    } catch {
      $errorCode = if ($_.Exception.Message -in @(
        'invalid-browser-launch-request', 'chrome-not-installed'
      )) { $_.Exception.Message } else { 'windows-local-browser-launch-failed' }
      Write-LaunchResult -RequestId $requestId -ShopId $shopId -Status 'failed' -ErrorCode $errorCode
    } finally {
      Remove-Item -LiteralPath $processingFile -Force -ErrorAction SilentlyContinue
    }
  }

  Get-ChildItem -LiteralPath $resultRoot -Filter '*.json' -File -ErrorAction SilentlyContinue |
    Where-Object LastWriteTime -lt (Get-Date).AddDays(-2) |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
