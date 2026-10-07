$ErrorActionPreference = 'Stop'
$managedRoot = $PSScriptRoot
$taskPowerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$operatorAccount = 'DESKTOP-70PF21F\Administrator'
$servicePrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$workerPrincipal = New-ScheduledTaskPrincipal -UserId $operatorAccount -LogonType Interactive -RunLevel Highest
$startSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$guardSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
foreach ($component in @('Services','Worker')) {
  $taskName = if ($component -eq 'Services') { 'PDD Local Services Start' } else { 'PDD Local Worker Start' }
  $principal = if ($component -eq 'Services') { $servicePrincipal } else { $workerPrincipal }
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $managedRoot 'run-local-managed-start.ps1') + '" -Component ' + $component
  $action = New-ScheduledTaskAction -Execute $taskPowerShell -Argument $arguments -WorkingDirectory $managedRoot
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $startSettings -Description 'Owns the local PDD process tree independently of Codex and terminal lifetime.' -Force | Out-Null
}
foreach ($kind in @('Frontend','Worker')) {
  $principal = if ($kind -eq 'Frontend') { $servicePrincipal } else { $workerPrincipal }
  $initialTrigger = if ($kind -eq 'Frontend') { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn -User $operatorAccount }
  $scriptName = if ($kind -eq 'Frontend') { 'local-frontend-watchdog.ps1' } else { 'local-worker-watchdog.ps1' }
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $managedRoot $scriptName) + '"'
  $action = New-ScheduledTaskAction -Execute $taskPowerShell -Argument $arguments -WorkingDirectory $managedRoot
  Register-ScheduledTask -TaskName ('PDD Local ' + $kind + ' Watchdog') -Action $action -Principal $principal -Settings $guardSettings -Trigger @($initialTrigger,$repeat) -Description 'Recovers unexpected exits independently; explicit local stop markers preserve operator pauses.' -Force | Out-Null
}
Write-Host 'Independent PDD startup and watchdog tasks installed.'
