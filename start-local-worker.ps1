param([switch]$StartWorker, [switch]$NoBrowser, [switch]$ManagedStartup)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$app = Join-Path $root 'app'
$node = Join-Path $root 'runtime\node\node.exe'
$log = Join-Path $root 'logs-local'
$stopMarker = Join-Path $root 'data\local-services-stop-requested.json'
. (Join-Path $root 'local-service-state.ps1')
# A direct worker start also cancels a prior explicit full-stop marker.
Remove-Item -LiteralPath $stopMarker -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $root 'data\local-worker-stop-requested.json') -Force -ErrorAction SilentlyContinue

# Only Task Scheduler may own the long-running service process tree. A caller
# from a terminal, the UI, or Codex dispatches and waits for readiness only.
if (-not $ManagedStartup) {
  Start-PddManagedTask 'PDD Local Worker Start'
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      $running = Get-Content -Raw -LiteralPath (Join-Path $root 'data\workflow\supervisor\worker-heartbeat.json') | ConvertFrom-Json
      $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]$running.updatedAt).TotalSeconds
      $roots = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.ExecutablePath -eq $node -and $_.CommandLine -match 'apps[\\/]worker[\\/]src[\\/]main\.mjs' })
      if ($roots.Count -eq 1 -and $running.state -eq 'running' -and $age -ge 0 -and $age -lt 30) {
        Write-Host 'Local automation is running under Windows Task Scheduler.'
        return
      }
    } catch {}
    Start-Sleep -Seconds 1
  }
  throw 'Scheduled Worker startup did not become ready. See the local Worker logs.'
}
function Start-LocalWorker {
. (Join-Path $root 'load-local-env.ps1')

$health = $null
try { $health = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 5 } catch {}
if (-not $health.ok -or $health.backend -ne 'postgres' -or
    -not (Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue)) {
  & (Join-Path $root 'start-local.ps1') -NoBrowser -SkipWorker
  $health = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 10
}
if (-not $health.ok -or $health.backend -ne 'postgres') {
  throw 'Start the local API and PostgreSQL before starting automation.'
}
if (-not (Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue)) {
  throw 'Start local MinIO before starting automation.'
}
$roots = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -eq $node -and $_.CommandLine -match 'apps[\\/]worker[\\/]src[\\/]main\.mjs' })
if ($roots.Count -gt 1) { throw 'Multiple local Worker roots found.' }

# Restore only pauses created by the local stop entry point. Login/identity
# holds and other maintenance sessions must survive an ordinary startup.
Push-Location -LiteralPath $app
try {
  & $node (Join-Path $root 'local-worker-maintenance.mjs') resume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restore local work assignment.' }
} finally { Pop-Location }

$workerProcess = $null
if (-not $roots.Count) {
  New-Item -ItemType Directory -Path $log -Force | Out-Null
  $workerProcess = Start-Process $node -WorkingDirectory $app -ArgumentList 'apps\worker\src\main.mjs' -RedirectStandardOutput (Join-Path $log 'worker.out.log') -RedirectStandardError (Join-Path $log 'worker.err.log') -WindowStyle Hidden -PassThru
}
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  if ($workerProcess -and $workerProcess.HasExited) {
    throw 'Local Worker exited during startup. See logs-local\worker.err.log.'
  }
  try {
    $heartbeat = Get-Content -Raw -LiteralPath $env:WORKER_HEARTBEAT_FILE | ConvertFrom-Json
    $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]$heartbeat.updatedAt).TotalSeconds
    $freshForProcess = -not $workerProcess -or
      [DateTimeOffset]$heartbeat.updatedAt -ge [DateTimeOffset]$workerProcess.StartTime
    if ($freshForProcess -and $heartbeat.state -eq 'running' -and $heartbeat.mode -eq 'postgres' -and $age -ge 0 -and $age -lt 30) {
      $ready = $true
      break
    }
  } catch {}
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'Local Worker did not produce a fresh running heartbeat.' }
Write-Host 'Local automation started.'
}

$workerMutex = [Threading.Mutex]::new($false, 'Local\PddNativeLocalWorkerStartup')
$ownsWorkerMutex = $false
try {
  try { $ownsWorkerMutex = $workerMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsWorkerMutex = $true }
  if (-not $ownsWorkerMutex) {
    Write-Host 'The local Worker is already starting. Please wait for the first launcher.'
    return
  }
  Start-LocalWorker
} finally {
  if ($ownsWorkerMutex) { $workerMutex.ReleaseMutex() }
  $workerMutex.Dispose()
}
