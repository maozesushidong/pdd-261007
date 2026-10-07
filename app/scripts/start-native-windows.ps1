param([switch]$StartWorker, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
$runtimeRoot = Join-Path $installRoot 'runtime'
$dataRoot = Join-Path $installRoot 'data'
$node = Join-Path $runtimeRoot 'node\node.exe'
$consoleProfileRoot = Join-Path $installRoot 'data\console-browser-profile'
$consoleUrl = 'http://127.0.0.1:4173/'
$serverChrome = $null
$workerStartRequestedAt = $null
$extensionPolicyMetadata = Join-Path $installRoot 'extensions\policy\shizai-rpa-v3\metadata.json'
$drainScript = Join-Path $projectRoot 'scripts\worker-maintenance-drain.mjs'
$workerHeartbeatFile = Join-Path $dataRoot 'workflow\supervisor\worker-heartbeat.json'

function Start-NativeScheduledTask {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [switch]$Optional
  )

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    if ($Optional) {
      Write-Warning "Optional scheduled task '$TaskName' is not installed; skipping it."
      return
    }
    throw "Required scheduled task '$TaskName' is not installed. Run the native Windows installer first."
  }

  if ($task.State -eq 'Disabled') {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Output "Enabled scheduled task: $TaskName"
  }
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Started scheduled task: $TaskName"
}

function Assert-WorkerBrowserProxyReady {
  . (Join-Path $PSScriptRoot 'load-native-windows-env.ps1') -ProjectRoot $projectRoot
  Push-Location $projectRoot
  try {
    & $node 'scripts\browser-proxy-preflight.mjs'
    if ($LASTEXITCODE -ne 0) {
      throw 'Browser proxy preflight failed; Worker was not started.'
    }
  } finally {
    Pop-Location
  }
}

function Set-MaintenanceDrain {
  param([ValidateSet('enable', 'disable')][string]$Mode)
  if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or
      -not (Test-Path -LiteralPath $drainScript -PathType Leaf)) {
    throw 'Native Node or maintenance drain script is missing.'
  }
  Push-Location -LiteralPath $projectRoot
  try {
    & $node $drainScript "--$Mode" | ForEach-Object { Write-Output "[drain] $_" }
    if ($LASTEXITCODE -ne 0) { throw "Maintenance drain $Mode failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

function Test-NativePostgresReady {
  $listenSockets = @(Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue)
  foreach ($socket in $listenSockets) {
    $process = Get-Process -Id $socket.OwningProcess -ErrorAction SilentlyContinue
    if ($process -and $process.Path -and
        $process.Path.Equals((Join-Path $runtimeRoot 'postgres\bin\postgres.exe'), [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

$postgresService = Get-Service -Name 'pdd-postgresql-16' -ErrorAction Stop
if ($postgresService.Status -ne 'Running') {
  if (Test-NativePostgresReady) {
    Write-Output 'PostgreSQL service is stopped but the native PostgreSQL process is already listening on 5432; reusing it.'
  } else {
    Start-Service -Name $postgresService.Name
  }
}
Set-MaintenanceDrain -Mode disable

$serviceTasks = @('PDD Native MinIO', 'PDD Native Api', 'PDD Native Web', 'PDD Native Notifier', 'PDD Native Sync')
if (Test-Path -LiteralPath $extensionPolicyMetadata -PathType Leaf) {
  $serviceTasks = @('PDD Native MinIO', 'PDD Native ExtensionServer', 'PDD Native Api', 'PDD Native Web', 'PDD Native Notifier', 'PDD Native Sync')
}
foreach ($taskName in $serviceTasks) {
  Start-NativeScheduledTask -TaskName $taskName
}
Write-Output 'Core services requested; waiting for the web console.'
Start-NativeScheduledTask -TaskName 'PDD Owner Public Gateway' -Optional
Start-NativeScheduledTask -TaskName 'PDD Verification Desktop Notifier' -Optional
Start-NativeScheduledTask -TaskName 'PDD Native Browser Launcher' -Optional
Start-NativeScheduledTask -TaskName 'PDD Native Window Keeper' -Optional
if ($StartWorker) {
  Assert-WorkerBrowserProxyReady
  $serverChrome = & (Join-Path $PSScriptRoot 'resolve-native-windows-chrome.ps1') -PassThru
  Write-Output "Server Chrome ready: $($serverChrome.Version) ($($serverChrome.Path))"
  $workerStartRequestedAt = [DateTimeOffset]::Now
  Start-NativeScheduledTask -TaskName 'PDD Native Worker'
}

$deadline = (Get-Date).AddSeconds(90)
$webPoll = 0
do {
  try {
    $response = Invoke-WebRequest -Uri $consoleUrl -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) { break }
  } catch { }
  $webPoll += 1
  if (($webPoll % 5) -eq 0) { Write-Output 'Web console is still starting...' }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
if (-not $response -or $response.StatusCode -ne 200) { throw 'Native web console did not become ready.' }

if (-not $NoBrowser) {
  if (-not $serverChrome) {
    $serverChrome = & (Join-Path $PSScriptRoot 'resolve-native-windows-chrome.ps1') -PassThru
  }
  New-Item -ItemType Directory -Path $consoleProfileRoot -Force | Out-Null
  Start-Process -FilePath $serverChrome.Path -ArgumentList @(
    "--user-data-dir=$consoleProfileRoot",
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    $consoleUrl
  )
}

if ($StartWorker) {
  # Startup success means the Worker has a fresh running heartbeat. Individual
  # shop browsers are restored asynchronously and must not hold the launcher
  # open while every profile is logging in or waiting for a human CAPTCHA.
  $workerDeadline = (Get-Date).AddSeconds(60)
  $workerReady = $false
  $workerPoll = 0
  do {
    try {
      $heartbeat = Get-Content -LiteralPath $workerHeartbeatFile -Raw | ConvertFrom-Json
      $heartbeatUpdatedAt = [DateTimeOffset]::Parse($heartbeat.updatedAt)
      $heartbeatAge = [DateTimeOffset]::Now - $heartbeatUpdatedAt
      $workerReady = $heartbeat.state -eq 'running' `
        -and $heartbeatUpdatedAt -ge $workerStartRequestedAt `
        -and $heartbeatAge.TotalSeconds -lt 30
      if ($workerReady) { break }
    } catch { $workerReady = $false }
    $workerPoll += 1
    if (($workerPoll % 5) -eq 0) { Write-Output 'Worker is starting; shop browsers will recover in the background...' }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $workerDeadline)
  if (-not $workerReady) { throw 'Worker did not publish a fresh running heartbeat.' }

  $enabledShops = @()
  $onlineShops = @()
  try {
    $shops = (Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/v1/shops' -TimeoutSec 5).data
    $enabledShops = @($shops | Where-Object { $_.enabled })
    $onlineShops = @($enabledShops | Where-Object { $_.workerOnline })
  } catch { }
  Write-Output "Worker is online; $($onlineShops.Count) of $($enabledShops.Count) enabled shop browser(s) are online and the rest will recover asynchronously."
}

Write-Output "PDD native services are running at $consoleUrl"
