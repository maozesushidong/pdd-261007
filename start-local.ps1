param([switch]$NoBrowser, [switch]$SkipWorker, [switch]$ManagedStartup)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$app = Join-Path $root 'app'
$node = Join-Path $root 'runtime\node\node.exe'
$log = Join-Path $root 'logs-local'
$stopMarker = Join-Path $root 'data\local-services-stop-requested.json'
New-Item -ItemType Directory -Force -Path $log | Out-Null
# A manual start cancels a prior explicit stop for this boot session. The
# watchdogs use the same marker to distinguish maintenance from a crash.
Remove-Item -LiteralPath $stopMarker -Force -ErrorAction SilentlyContinue
. (Join-Path $root 'local-service-state.ps1')

if (-not $ManagedStartup) {
  Start-PddManagedTask 'PDD Local Services Start'
  $servicesReady = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 2
      $public = Invoke-WebRequest 'http://127.0.0.1:5145/' -UseBasicParsing -TimeoutSec 2
      if ($health.ok -and $health.backend -eq 'postgres' -and $public.StatusCode -eq 200 -and
          (Get-NetTCPConnection -LocalPort 5148 -State Listen -ErrorAction SilentlyContinue)) {
        $servicesReady = $true
        break
      }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $servicesReady) { throw 'Scheduled frontend startup did not become ready. See the local service logs.' }
  if (-not $SkipWorker) { & (Join-Path $root 'start-local-worker.ps1') -NoBrowser }
  if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5148/' }
  Write-Host 'PDD local services are running under Windows Task Scheduler.'
  return
}

function Start-LocalServices {
# Load the same environment/secret mappings used by the server, then apply only local endpoint overrides.
. (Join-Path $root 'load-local-env.ps1')

function Test-LocalPort([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}
function Get-HttpStatus([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 5
    return [int]$response.StatusCode
  } catch {
    $response = $_.Exception.Response
    if ($response -and $response.StatusCode) {
      try { return [int]$response.StatusCode.value__ } catch { return [int]$response.StatusCode }
    }
    return 0
  }
}
function Test-LocalWeb {
  # 5145 serves the ordinary viewer. The concealed owner entry intentionally
  # returns a fake 404 at its root, so that response is healthy on 5148.
  $publicStatus = Get-HttpStatus 'http://127.0.0.1:5145/'
  $ownerStatus = Get-HttpStatus 'http://127.0.0.1:5148/'
  $publicOk = $publicStatus -ge 200 -and $publicStatus -lt 300
  $ownerOk = ($ownerStatus -ge 200 -and $ownerStatus -lt 300) -or $ownerStatus -eq 404
  return $publicOk -and $ownerOk
}
function Wait-LocalPort([int]$Port, [int]$Attempts = 45) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    if (Test-LocalPort $Port) { return }
    Start-Sleep -Seconds 1
  }
  throw "Local service did not become ready on port $Port."
}
function Stop-NodeByPattern([string]$Pattern) {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $node -and $_.CommandLine -match $Pattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Start-Node([string]$WorkingDirectory, [string]$Arguments, [string]$Name) {
  Start-Process $node -WorkingDirectory $WorkingDirectory -ArgumentList $Arguments -RedirectStandardOutput (Join-Path $log "$Name.out.log") -RedirectStandardError (Join-Path $log "$Name.err.log") -WindowStyle Hidden | Out-Null
}

# PostgreSQL is the same application backend as the server; only its local port differs.
if (-not (Test-LocalPort 5433)) {
  Write-Host '[1/5] Starting local PostgreSQL...'
  # A native pipeline can stay open after pg_ctl exits because postgres inherits
  # its handles. Start it detached so closing the launcher cannot stop the DB.
  $pgCtl = Start-Process (Join-Path $root 'runtime\postgres\bin\pg_ctl.exe') `
    -ArgumentList '-D', ('"' + (Join-Path $root 'data\postgres-local') + '"'), `
      '-l', ('"' + (Join-Path $log 'postgres.out.log') + '"'), '-w', '-t', '45', 'start' `
    -WindowStyle Hidden -RedirectStandardOutput (Join-Path $log 'postgres-start.out.log') `
    -RedirectStandardError (Join-Path $log 'postgres-start.err.log') -PassThru
}
Wait-LocalPort 5433
$databaseReady = $false
for ($attempt = 0; $attempt -lt 45; $attempt++) {
  & (Join-Path $root 'runtime\postgres\bin\pg_isready.exe') -h 127.0.0.1 -p 5433 -t 1 -q
  if ($LASTEXITCODE -eq 0) { $databaseReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $databaseReady) { throw 'Local PostgreSQL did not become ready. See logs-local\postgres.out.log.' }

# Start S3 before API. MinIO credentials must match the application's S3_* secret files.
Write-Host '[2/5] Checking local file storage...'
if (-not (Test-LocalPort 9000)) {
  if ($env:S3_ACCESS_KEY_FILE -and (Test-Path $env:S3_ACCESS_KEY_FILE)) {
    $env:MINIO_ROOT_USER = (Get-Content -Raw $env:S3_ACCESS_KEY_FILE).Trim()
  }
  if ($env:S3_SECRET_KEY_FILE -and (Test-Path $env:S3_SECRET_KEY_FILE)) {
    $env:MINIO_ROOT_PASSWORD = (Get-Content -Raw $env:S3_SECRET_KEY_FILE).Trim()
  }
  Start-Process (Join-Path $root 'runtime\minio\minio.exe') -WorkingDirectory $root -ArgumentList 'server', (Join-Path $root 'data\minio'), '--address', '127.0.0.1:9000', '--console-address', '127.0.0.1:9001' -RedirectStandardOutput (Join-Path $log 'minio.out.log') -RedirectStandardError (Join-Path $log 'minio.err.log') -WindowStyle Hidden | Out-Null
}
Wait-LocalPort 9000

# Restart the API only when its runtime reports a different backend/platform.
Write-Host '[3/5] Checking local API...'
$restartApi = $true
try {
  $runtime = Invoke-RestMethod 'http://127.0.0.1:3000/api/v1/runtime' -TimeoutSec 3
  $runtimeData = $runtime.data
  $restartApi = ($runtimeData.dataBackend -ne 'postgres' -or $runtimeData.platform -ne 'Windows Native' -or $runtimeData.dynamicWorkerSupervisor -ne $true)
} catch {}
if ($restartApi) {
  Stop-NodeByPattern 'apps[\\/]api[\\/]src[\\/]main\.mjs'
  Start-Sleep -Milliseconds 500
}
if (-not (Test-LocalPort 3000)) {
  Start-Node $app 'apps\api\src\main.mjs' 'api'
}
Wait-LocalPort 3000
$apiHealth = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 10
if (-not $apiHealth.ok -or $apiHealth.backend -ne 'postgres') {
  throw 'Local API is not healthy with the PostgreSQL backend.'
}

# The web server owns the concealed owner 5148 and ordinary 5145 listeners.
Write-Host '[4/5] Checking both local frontends...'
& (Join-Path $root 'ensure-local-https-certificate.ps1')
if (-not (Test-LocalPort 5148) -or -not (Test-LocalPort 5145) -or -not (Test-LocalWeb)) {
  Stop-NodeByPattern 'src[\\/]server\.mjs'
  Start-Sleep -Milliseconds 500
}
if (-not (Test-LocalPort 5148)) {
  Start-Node (Join-Path $app 'apps\web') 'src\server.mjs' 'web'
}
Wait-LocalPort 5148
Wait-LocalPort 5145

# The local dispatcher sends only the configured 18:30 daily summary.
& (Join-Path $root 'start-local-dingtalk.ps1')

# Use the same Worker entry point as the owner's start/stop controls.
if (-not $SkipWorker) {
  Write-Host '[5/5] Starting shop Workers...'
  & (Join-Path $root 'start-local-worker.ps1') -NoBrowser
}

if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5148/' }
Write-Host 'PDD local services are ready.'
}

$startupMutex = [Threading.Mutex]::new($false, 'Local\PddNativeLocalServicesStartup')
$ownsStartupMutex = $false
try {
  try { $ownsStartupMutex = $startupMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsStartupMutex = $true }
  if (-not $ownsStartupMutex) {
    Write-Host 'Local services are already starting. Please wait for the first launcher.'
    return
  }
  Start-LocalServices
} finally {
  if ($ownsStartupMutex) { $startupMutex.ReleaseMutex() }
  $startupMutex.Dispose()
}
