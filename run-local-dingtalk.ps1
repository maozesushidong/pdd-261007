$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$lock = [Threading.Mutex]::new($false, 'Local\PddNativeDingTalkDispatcher')
$owns = $false
try {
  try { $owns = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owns = $true }
  if (-not $owns) { return }
  while ($true) {
    try {
      . (Join-Path $root 'load-local-env.ps1')
      $database = [Uri]$env:DATABASE_URL
      if ($database.Host -ne '127.0.0.1' -or $database.Port -ne 5433) { throw 'Local PostgreSQL is required' }
      & (Join-Path $root 'runtime\postgres\bin\pg_isready.exe') -h 127.0.0.1 -p 5433 -t 2 -q
      if ($LASTEXITCODE -ne 0) { Start-Sleep -Seconds 15; continue }
      Push-Location -LiteralPath (Join-Path $root 'app')
      try {
        & (Join-Path $root 'runtime\node\node.exe') 'scripts\dingtalk-dispatcher.mjs'
      } finally { Pop-Location }
    } catch { Write-Warning $_.Exception.Message }
    Start-Sleep -Seconds 15
  }
} finally {
  if ($owns) { $lock.ReleaseMutex() }
  $lock.Dispose()
}
