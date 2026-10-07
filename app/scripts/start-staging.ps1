param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.staging'
$composeFile = Join-Path $root 'infra\docker\docker-compose.staging.yml'
$logDirectory = Join-Path $root '.codex'
$logPath = Join-Path $logDirectory 'lifecycle.log'
$composeArguments = @(
  'compose', '--env-file', $envFile, '-f', $composeFile,
  '--profile', 'worker', '--profile', 'visual', '--profile', 'notifications'
)
Set-Location -LiteralPath $root

function Write-LifecycleLog {
  param([string]$Message)
  if (-not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  }
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') START $Message"
}

function Invoke-Compose {
  param([string[]]$CommandArguments)
  $allArguments = $composeArguments + $CommandArguments
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & docker @allArguments 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  $output | ForEach-Object { Write-Host $_ }
  return $exitCode
}

function Wait-Docker {
  param([int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Wait-ManagementConsole {
  param([int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4173/' -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Start-DesktopNotifier {
  $notifierScript = Join-Path $PSScriptRoot 'watch-verification-alerts.ps1'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -Sta -File `"$notifierScript`""
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden
}

function Install-DesktopNotifierTask {
  $installerScript = Join-Path $PSScriptRoot 'install-desktop-notifier.ps1'
  try {
    & $installerScript | Out-Null
  } catch {
    Write-Host "Could not install the Windows login task; this notifier will still run: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-LifecycleLog "desktop notifier task install failed: $($_.Exception.Message)"
  }
}

try {
  Write-LifecycleLog 'requested'
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Missing .env.staging; database and runtime settings cannot be loaded.'
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop was not found. Install it before running START-PDD.cmd.'
  }

  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    $dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path -LiteralPath $dockerDesktop)) {
      throw 'Docker Desktop is not running and its executable was not found.'
    }
    Write-Host 'Starting Docker Desktop. Please wait...' -ForegroundColor Yellow
    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
    if (-not (Wait-Docker)) { throw 'Docker Desktop startup timed out. Open Docker Desktop to inspect the error.' }
  }

  Write-Host 'Validating configuration...' -ForegroundColor Cyan
  if ((Invoke-Compose @('config', '--quiet')) -ne 0) {
    throw 'Docker Compose validation failed. Check .env.staging and the secrets directory.'
  }

  Write-Host 'Starting the work-order system, dynamic workers, remote desktop, and DingTalk dispatcher...' -ForegroundColor Cyan
  if ((Invoke-Compose @('up', '-d', '--wait', '--wait-timeout', '300')) -ne 0) {
    Write-Host 'Recent container logs:' -ForegroundColor Yellow
    [void](Invoke-Compose @('logs', '--tail', '80'))
    throw 'The system did not become healthy within five minutes. Review the service name and error above.'
  }
  if (-not (Wait-ManagementConsole)) {
    throw 'Containers started, but the management console was unavailable after 60 seconds.'
  }

  Install-DesktopNotifierTask
  Start-DesktopNotifier
  Write-LifecycleLog 'all services healthy'
  Write-Host 'System, workers, remote desktop, DingTalk dispatcher, and desktop notifier are running.' -ForegroundColor Green
  Write-Host 'Management console: http://127.0.0.1:4173' -ForegroundColor Green
  Write-Host 'Double-click STOP-PDD.cmd to stop safely without deleting data.' -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4173' }
} catch {
  Write-LifecycleLog "failed: $($_.Exception.Message)"
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
