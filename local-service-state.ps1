# Explicit operator intent is independent of process/heartbeat exit status.
function Test-PddStopMarker {
  param([string[]]$Paths, [string]$BootTime)
  if (-not $BootTime) {
    $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
    $BootTime = ([DateTime]$boot).ToUniversalTime().ToString('o')
  }
  foreach ($markerPath in $Paths) {
    if (-not (Test-Path -LiteralPath $markerPath)) { continue }
    try {
      $marker = Get-Content -Raw -LiteralPath $markerPath -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($marker.bootTime -eq $BootTime) { return $true }
    } catch { return $true }
  }
  return $false
}

function Set-PddStopMarker {
  param([string]$Path, [string]$Source)
  $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
  $content = [pscustomobject]@{
    source = $Source
    requestedAt = [DateTimeOffset]::UtcNow.ToString('o')
    bootTime = ([DateTime]$boot).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Compress
  $pendingPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($pendingPath, $content, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $pendingPath -Destination $Path -Force -ErrorAction Stop
}

function Start-PddManagedTask {
  param([string]$TaskName)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.State -eq 'Disabled') { Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
}
