param([ValidateRange(0, 120)][int]$DrainTimeoutSeconds = 45)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$app = Join-Path $root 'app'
$node = Join-Path $root 'runtime\node\node.exe'
. (Join-Path $root 'local-service-state.ps1')
# Write operator intent before draining; process crashes never create this file.
Set-PddStopMarker -Path (Join-Path $root 'data\local-worker-stop-requested.json') -Source 'local-worker-stop'
. (Join-Path $root 'load-local-env.ps1')

# Preserve operator pauses and stop accepting new work before shutting down.
Push-Location -LiteralPath $app
try {
  & $node (Join-Path $root 'local-worker-maintenance.mjs') pause | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not pause local work assignment.' }
} finally { Pop-Location }

$roots = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -eq $node -and $_.CommandLine -match 'apps[\\/]worker[\\/]src[\\/]main\.mjs' })
# Allow active claims to finish after the maintenance gate stops new claims.
if ($roots.Count -and $DrainTimeoutSeconds -gt 0) {
  $deadline = (Get-Date).AddSeconds($DrainTimeoutSeconds)
  $claimProbe = "const {Client}=require('pg'); (async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});await c.connect();try{const r=await c.query('SELECT count(*)::int AS count FROM shop_runtime_state WHERE current_work_order_id IS NOT NULL AND lease_expires_at > now()');console.log(r.rows[0].count)}finally{await c.end()}})().catch(()=>process.exit(1));"
  Push-Location -LiteralPath $app
  try {
    do {
      $activeCount = & $node -e $claimProbe
      if ($LASTEXITCODE -ne 0) { throw 'Could not check active work before stopping.' }
      if ([int]$activeCount -eq 0) { break }
      Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
  } finally { Pop-Location }
}
foreach ($workerRoot in $roots) {
  & taskkill.exe /PID $workerRoot.ProcessId /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not stop local Worker $($workerRoot.ProcessId)." }
}
$remaining = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -eq $node -and
    ($_.CommandLine -match 'apps[\\/]worker[\\/]src[\\/]' -or
     $_.CommandLine -match 'app[\\/]workflow\.mjs') })
if ($remaining.Count) { throw 'Some local Worker processes are still running.' }
$heartbeat = [pscustomobject]@{
  state = 'stopped'
  mode = 'postgres'
  updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText($env:WORKER_HEARTBEAT_FILE, ($heartbeat | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
Write-Host 'Local automation stopped. API and both frontends remain available.'
