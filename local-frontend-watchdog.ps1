param([switch]$ProbeOnly, [string]$OwnerProbeUri = 'http://127.0.0.1:5148/')

$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\pdd-native'
$start = Join-Path $root 'start-local.ps1'
$logDir = Join-Path $root 'logs-local'
$logFile = Join-Path $logDir 'frontend-watchdog.log'
$stopMarker = Join-Path $root 'data\local-services-stop-requested.json'
. (Join-Path $root 'local-service-state.ps1')
$mutexName = 'Local\PddNativeFrontendWatchdog'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-WatchdogLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
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

function Test-OwnerFrontend([string]$Uri = 'http://127.0.0.1:5148/') {
  # The concealed entry intentionally responds with 404. PowerShell 7
  # disposes the error response body, so read it with SkipHttpErrorCheck there.
  if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey('SkipHttpErrorCheck')) {
    try {
      $reply = Invoke-WebRequest -Uri $Uri -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 5 -SkipHttpErrorCheck
      if ([int]$reply.StatusCode -ne 404) { return $false }
      $robots = [string]$reply.Headers['X-Robots-Tag']
      $csp = [string]$reply.Headers['Content-Security-Policy']
      $body = [string]$reply.Content
    } catch { return $false }
  } else {
    try {
      Invoke-WebRequest -Uri $Uri -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 5 | Out-Null
      return $false
    } catch {
      $reply = $_.Exception.Response
      if (-not $reply -or [int]$reply.StatusCode -ne 404) { return $false }
      $robots = [string]$reply.Headers['X-Robots-Tag']
      $csp = [string]$reply.Headers['Content-Security-Policy']
      try {
        $reader = New-Object System.IO.StreamReader($reply.GetResponseStream())
        try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      } catch { return $false }
    }
  }
  return $robots -eq 'noindex, nofollow, noarchive, nosnippet' `
    -and $csp -match "script-src 'nonce-[^']+'" `
    -and $body.Contains('404 Not Found') `
    -and $body.Contains('KeyH') `
    -and $body.Contains('/_entry/reveal')
}

function Test-Frontend {
  $publicStatus = Get-HttpStatus 'http://127.0.0.1:5145/'
  $publicOk = $publicStatus -ge 200 -and $publicStatus -lt 300
  return $publicOk -and (Test-OwnerFrontend)
}

function Test-Api {
  try {
    $health = Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 5
    return ($health.ok -eq $true -and $health.backend -eq 'postgres')
  } catch { return $false }
}

function Test-ExplicitStop {
  return Test-PddStopMarker -Paths @($stopMarker)
}

if ($ProbeOnly) {
  $result = [pscustomobject]@{
    PublicFrontend = (Get-HttpStatus 'http://127.0.0.1:5145/')
    OwnerGateHealthy = (Test-OwnerFrontend $OwnerProbeUri)
    ApiHealthy = (Test-Api)
  }
  $result | ConvertTo-Json -Compress
  $healthy = $result.PublicFrontend -ge 200 -and $result.PublicFrontend -lt 300 -and $result.OwnerGateHealthy -and $result.ApiHealthy
  if (-not $healthy) { exit 1 }
  exit 0
}

$mutex = [Threading.Mutex]::new($false, $mutexName)
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { exit 0 }

  Write-WatchdogLog 'Frontend watchdog started.'
  while ($true) {
    if (Test-ExplicitStop) {
      Start-Sleep -Seconds 30
      continue
    }
    $apiOk = Test-Api
    $frontendsOk = (Test-Port 5145) -and (Test-Port 5148) -and (Test-Frontend)
    if (-not $apiOk -or -not $frontendsOk) {
      $missing = @()
      if (-not $apiOk) { $missing += 'api' }
      if (-not (Test-Port 5145)) { $missing += '5145' }
      if (-not (Test-Port 5148)) { $missing += '5148' }
      if (-not (Test-Frontend)) { $missing += 'frontend-http' }
      Write-WatchdogLog ("Service check failed: " + ($missing -join ',') + '; starting local services.')
      try {
        Start-PddManagedTask 'PDD Local Services Start'
        Write-WatchdogLog 'Frontend startup dispatched to Windows Task Scheduler.'
      } catch {
        Write-WatchdogLog ("Start script error: " + $_.Exception.Message)
      }
      Start-Sleep -Seconds 10
    } else {
      Start-Sleep -Seconds 15
    }
  }
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
