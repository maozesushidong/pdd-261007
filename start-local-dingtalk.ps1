$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$commandPattern = '(?i)\s-File\s+"?' + [regex]::Escape((Join-Path $root 'run-local-dingtalk.ps1')) + '"?\s*$'
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -match $commandPattern
})
if (-not $running.Count) {
  $log = Join-Path $root 'logs-local'
  New-Item -ItemType Directory -Force -Path $log | Out-Null
  Start-Process 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $root 'run-local-dingtalk.ps1')+'"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $log 'dingtalk.out.log') -RedirectStandardError (Join-Path $log 'dingtalk.err.log') | Out-Null
}
