$root = 'D:\pdd-native'
$stopMarker = Join-Path $root 'data\local-services-stop-requested.json'
$bootTime = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).LastBootUpTime
if (-not $bootTime) { $bootTime = Get-Date }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stopMarker) | Out-Null
[IO.File]::WriteAllText(
  $stopMarker,
  ([pscustomobject]@{ requestedAt = [DateTimeOffset]::Now.ToString('o'); bootTime = ([DateTime]$bootTime).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress),
  [Text.UTF8Encoding]::new($false)
)
$workerHeartbeatFile = Join-Path $root 'data\workflow\supervisor\worker-heartbeat.json'
[IO.File]::WriteAllText(
  $workerHeartbeatFile,
  ([pscustomobject]@{ state = 'stopped'; mode = 'postgres'; updatedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress),
  [Text.UTF8Encoding]::new($false)
)
$notifierPattern = '(?i)\s-File\s+"?' + [regex]::Escape((Join-Path $root 'run-local-dingtalk.ps1')) + '"?\s*$'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -match $notifierPattern } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('node.exe', 'minio.exe', 'chrome.exe') -and $_.CommandLine -match [regex]::Escape($root) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
& 'D:\pdd-native\runtime\postgres\bin\pg_ctl.exe' -D 'D:\pdd-native\data\postgres-local' stop -m fast 2>$null
Write-Host 'PDD local services stopped.'
