$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\pdd-native'
$node = Join-Path $root 'runtime\node\node.exe'
$start = Join-Path $root 'start-local-worker.ps1'
$logDir = Join-Path $root 'logs-local'
$logFile = Join-Path $logDir 'worker-watchdog.log'
$heartbeatFile = Join-Path $root 'data\workflow\supervisor\worker-heartbeat.json'
$stopMarker = Join-Path $root 'data\local-services-stop-requested.json'
$workerStopMarker = Join-Path $root 'data\local-worker-stop-requested.json'
. (Join-Path $root 'local-service-state.ps1')
$mutexName = 'Local\PddNativeWorkerWatchdog'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-WatchdogLog([string]$Message) {
  Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Get-WorkerRoot {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $node -and $_.CommandLine -match 'apps[\\/]worker[\\/]src[\\/]main\.mjs' })
}

function Get-Heartbeat {
  try { return (Get-Content -Raw -LiteralPath $heartbeatFile | ConvertFrom-Json) } catch { return $null }
}

function Test-ExplicitStop {
  return Test-PddStopMarker -Paths @($stopMarker, $workerStopMarker)
}

$mutex = [Threading.Mutex]::new($false, $mutexName)
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { exit 0 }

  Write-WatchdogLog 'Worker watchdog started.'
  while ($true) {
    if (Test-ExplicitStop) {
      Start-Sleep -Seconds 30
      continue
    }
    $heartbeat = Get-Heartbeat
    $roots = @(Get-WorkerRoot)
    # main.mjs also writes 'stopped' after unexpected child exit. Only the
    # explicit operator marker above is allowed to suppress crash recovery.
    if ($roots.Count -eq 0) {
      Write-WatchdogLog 'Worker root is absent; starting local worker.'
      try {
        Start-PddManagedTask 'PDD Local Worker Start'
        Write-WatchdogLog 'Worker startup dispatched to Windows Task Scheduler.'
      } catch {
        Write-WatchdogLog ("Worker start script error: " + $_.Exception.Message)
      }
      Start-Sleep -Seconds 15
    } else {
      Start-Sleep -Seconds 20
    }
  }
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
