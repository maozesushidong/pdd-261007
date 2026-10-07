$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
$runner = Join-Path $PSScriptRoot 'run-native-windows-component.ps1'
$extensionPolicyMetadata = Join-Path $installRoot 'extensions\policy\shizai-rpa-v3\metadata.json'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$servicePrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$interactivePrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$serviceSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$interactiveSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

$serviceComponents = @('MinIO', 'Api', 'Web', 'Notifier', 'Sync')
if (Test-Path -LiteralPath $extensionPolicyMetadata -PathType Leaf) {
  $serviceComponents = @('MinIO', 'ExtensionServer', 'Api', 'Web', 'Notifier', 'Sync')
} elseif (Get-ScheduledTask -TaskName 'PDD Native ExtensionServer' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'PDD Native ExtensionServer' -Confirm:$false
}

foreach ($component in $serviceComponents) {
  $taskName = "PDD Native $component"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Component $component"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $projectRoot
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $startupTrigger `
    -Principal $servicePrincipal -Settings $serviceSettings -Force | Out-Null
}

$workerAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Component Worker" `
  -WorkingDirectory $projectRoot
Register-ScheduledTask -TaskName 'PDD Native Worker' -Action $workerAction -Trigger $logonTrigger `
  -Principal $interactivePrincipal -Settings $interactiveSettings -Force | Out-Null

$windowKeeper = Join-Path $PSScriptRoot 'restore-native-worker-windows.ps1'
$windowKeeperAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$windowKeeper`" -RestoreInitialMinimized" `
  -WorkingDirectory $projectRoot
Register-ScheduledTask -TaskName 'PDD Native Window Keeper' -Action $windowKeeperAction -Trigger $logonTrigger `
  -Principal $interactivePrincipal -Settings $interactiveSettings -Force | Out-Null

& (Join-Path $PSScriptRoot 'install-native-windows-browser-launcher.ps1') | Out-Null

& (Join-Path $PSScriptRoot 'install-desktop-notifier.ps1') | Out-Null
& (Join-Path $PSScriptRoot 'install-native-windows-shortcuts.ps1') | Out-Null
Write-Output 'Native Windows scheduled tasks installed.'
