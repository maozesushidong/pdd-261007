param([ValidateSet('Services','Worker')][string]$Component)
$ErrorActionPreference = 'Stop'
$managedLog = Join-Path $PSScriptRoot ('logs-local\managed-start-' + $Component.ToLowerInvariant() + '.log')
try {
  Add-Content -LiteralPath $managedLog -Value "$(Get-Date -Format o) Scheduled startup began." -Encoding UTF8
  if ($Component -eq 'Services') {
    & (Join-Path $PSScriptRoot 'start-local.ps1') -NoBrowser -SkipWorker -ManagedStartup *>&1 | Out-File -LiteralPath $managedLog -Append -Encoding UTF8
  } else {
    & (Join-Path $PSScriptRoot 'start-local-worker.ps1') -NoBrowser -ManagedStartup *>&1 | Out-File -LiteralPath $managedLog -Append -Encoding UTF8
  }
  Add-Content -LiteralPath $managedLog -Value "$(Get-Date -Format o) Scheduled startup ready." -Encoding UTF8
} catch {
  Add-Content -LiteralPath $managedLog -Value "$(Get-Date -Format o) Startup failed: $($_.Exception.Message)" -Encoding UTF8
  exit 1
}
