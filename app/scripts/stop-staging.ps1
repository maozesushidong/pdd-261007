param(
  [ValidateRange(30, 600)]
  [int]$DrainTimeoutSeconds = 180
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
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') STOP $Message"
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

function Stop-DesktopNotifier {
  try {
    $stopEvent = [System.Threading.EventWaitHandle]::OpenExisting('Local\PddVerificationDesktopNotifierStop')
    [void]$stopEvent.Set()
    $stopEvent.Dispose()
  } catch [System.Threading.WaitHandleCannotBeOpenedException] { }
}

try {
  Write-LifecycleLog 'requested'
  Stop-DesktopNotifier
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Docker is not installed; the desktop notifier has been stopped.' -ForegroundColor Yellow
    exit 0
  }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Docker Desktop is already stopped.' -ForegroundColor Green
    Write-LifecycleLog 'docker already stopped'
    exit 0
  }
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Missing .env.staging; the Compose project cannot be identified safely.'
  }

  Write-Host 'Draining active work orders and stopping workers...' -ForegroundColor Cyan
  if ((Invoke-Compose @('stop', '--timeout', [string]$DrainTimeoutSeconds, 'worker', 'worker-sync')) -ne 0) {
    throw 'Workers did not drain safely. The database and management console remain running to protect active work.'
  }

  Write-Host 'Workers drained. Stopping the management console and infrastructure...' -ForegroundColor Cyan
  if ((Invoke-Compose @('down', '--timeout', '60')) -ne 0) {
    throw 'Some services failed to stop. Check their state in Docker Desktop.'
  }

  Write-LifecycleLog 'all services stopped; volumes preserved'
  Write-Host 'The system stopped safely. Database, screenshots, and browser profiles were preserved.' -ForegroundColor Green
  Write-Host 'Docker Desktop remains running. Double-click START-PDD.cmd to resume.' -ForegroundColor Green
} catch {
  Write-LifecycleLog "failed: $($_.Exception.Message)"
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
