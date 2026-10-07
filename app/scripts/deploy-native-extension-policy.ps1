param(
  [Parameter(Mandatory)][string]$StageRoot,
  [Parameter(Mandatory)][string]$BackupRoot,
  [string]$InstallRoot = 'C:\pdd-native',
  [string]$ExpectedWorkflowHash = ''
)

$ErrorActionPreference = 'Stop'
$appRoot = Join-Path $InstallRoot 'app'
$extensionRoot = Join-Path $InstallRoot 'extensions\policy\shizai-rpa-v3'
$seedRoot = Join-Path $InstallRoot 'extensions\settings-seed-20260806-125202'
$oldExtensionId = 'igigfgondlhjmdjlkfiaeaofnlfbfbia'
$extensionId = 'gladmhmdnkendlnmkehbkpnnchhhdeng'
$unpackedExtensionId = 'mieipphjmgbgicngmkmmfcbbjokjgadc'
$updateUrl = 'http://127.0.0.1:8765/updates.xml'
$relativeFiles = @(
  'package.json',
  'workflow.mjs',
  'scripts\deploy-native-extension-policy.ps1',
  'scripts\native-extension-update-server.mjs',
  'scripts\native-extension-update-server-self-test.mjs',
  'scripts\worker-runtime-self-test.mjs',
  'scripts\run-native-windows-component.ps1',
  'scripts\install-native-windows-tasks.ps1',
  'scripts\restore-native-worker-windows.ps1',
  'scripts\start-native-windows.ps1',
  'scripts\stop-native-windows.ps1'
)

if ($ExpectedWorkflowHash) {
  $actualHash = (Get-FileHash (Join-Path $StageRoot 'workflow.mjs') -Algorithm SHA256).Hash
  if ($actualHash -ne $ExpectedWorkflowHash) { throw 'Staged workflow hash mismatch.' }
}
& (Join-Path $InstallRoot 'runtime\node\node.exe') --check (Join-Path $StageRoot 'workflow.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Staged workflow syntax is invalid.' }

foreach ($relative in $relativeFiles) {
  $stagedFile = Join-Path $StageRoot $relative
  if (-not (Test-Path -LiteralPath $stagedFile -PathType Leaf)) { throw "Missing staged file: $relative" }
  $currentFile = Join-Path $appRoot $relative
  $backupFile = Join-Path $BackupRoot $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $currentFile), (Split-Path $backupFile) | Out-Null
  if (Test-Path -LiteralPath $currentFile) { Copy-Item -LiteralPath $currentFile -Destination $backupFile -Force }
  Copy-Item -LiteralPath $stagedFile -Destination $currentFile -Force
}

$envFile = Join-Path $appRoot '.env.native'
Copy-Item -LiteralPath $envFile -Destination (Join-Path $BackupRoot 'env.native') -Force
$replacements = [ordered]@{
  WORKFLOW_REQUIRED_EXTENSION_IDS = $unpackedExtensionId
  WORKFLOW_BROWSER_EXTENSION_PATHS = (Join-Path $extensionRoot 'source')
  WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS = 'true'
  WORKFLOW_EXTENSION_STARTUP_TIMEOUT_MS = '60000'
  NATIVE_EXTENSION_POLICY_ROOT = $extensionRoot
  NATIVE_EXTENSION_HOST = '127.0.0.1'
  NATIVE_EXTENSION_PORT = '8765'
}
$lines = [Collections.Generic.List[string]]::new()
foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) { $lines.Add($line) }
foreach ($key in $replacements.Keys) {
  $replacement = "$key=$($replacements[$key])"
  $index = -1
  for ($position = 0; $position -lt $lines.Count; $position += 1) {
    if ($lines[$position].StartsWith("$key=", [StringComparison]::Ordinal)) {
      $index = $position
      break
    }
  }
  if ($index -ge 0) { $lines[$index] = $replacement } else { $lines.Add($replacement) }
}
[IO.File]::WriteAllLines($envFile, $lines, [Text.UTF8Encoding]::new($false))

$sourceSeed = Join-Path $seedRoot $oldExtensionId
$destinationSeed = Join-Path $seedRoot $unpackedExtensionId
if (Test-Path -LiteralPath $sourceSeed) {
  New-Item -ItemType Directory -Force -Path $destinationSeed | Out-Null
  & robocopy.exe $sourceSeed $destinationSeed /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Extension settings seed copy failed: $LASTEXITCODE" }
}

$nativeManifest = 'C:\Users\Administrator\AppData\Local\IIRPA\RPAChromeExtension\manifest.json'
if (Test-Path -LiteralPath $nativeManifest) {
  Copy-Item -LiteralPath $nativeManifest -Destination (Join-Path $BackupRoot 'iirpa-native-manifest.json') -Force
  $manifest = Get-Content -LiteralPath $nativeManifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $origins = [Collections.Generic.List[string]]::new()
  foreach ($origin in @($manifest.allowed_origins)) { $origins.Add([string]$origin) }
  foreach ($id in @($oldExtensionId, $extensionId, $unpackedExtensionId)) {
    $origin = "chrome-extension://$id/"
    if (-not $origins.Contains($origin)) { $origins.Add($origin) }
  }
  $manifest.allowed_origins = @($origins)
  [IO.File]::WriteAllText(
    $nativeManifest,
    ($manifest | ConvertTo-Json -Depth 10),
    [Text.UTF8Encoding]::new($false)
  )
}

& reg.exe export 'HKLM\SOFTWARE\Policies\Google\Chrome' (Join-Path $BackupRoot 'chrome-policy.reg') /y | Out-Null
$policyRoot = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
$forceList = Join-Path $policyRoot 'ExtensionInstallForcelist'
$sources = Join-Path $policyRoot 'ExtensionInstallSources'
New-Item -Path $forceList, $sources -Force | Out-Null
New-ItemProperty -Path $forceList -Name '1' -Value "$extensionId;$updateUrl" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $sources -Name '1' -Value 'http://127.0.0.1:8765/*' -PropertyType String -Force | Out-Null
$extensionSettings = @{
  $extensionId = @{ installation_mode = 'force_installed'; update_url = $updateUrl }
} | ConvertTo-Json -Compress
New-ItemProperty -Path $policyRoot -Name 'ExtensionSettings' -Value $extensionSettings `
  -PropertyType String -Force | Out-Null

$runner = Join-Path $appRoot 'scripts\run-native-windows-component.ps1'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Component ExtensionServer" `
  -WorkingDirectory $appRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 20 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PDD Native ExtensionServer' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'PDD Native ExtensionServer'

$health = $null
$deadline = (Get-Date).AddSeconds(30)
do {
  try { $health = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 3 } catch { Start-Sleep -Seconds 1 }
} while (-not $health -and (Get-Date) -lt $deadline)
if (-not $health) { throw 'Native extension update server did not become healthy.' }

Start-ScheduledTask -TaskName 'PDD Native Worker'
Start-Sleep -Seconds 5
$tasks = @('PDD Native ExtensionServer', 'PDD Native Worker') | ForEach-Object {
  $task = Get-ScheduledTask -TaskName $_
  $info = Get-ScheduledTaskInfo -TaskName $_
  [pscustomobject]@{ Name = $_; State = [string]$task.State; LastResult = $info.LastTaskResult }
}
[pscustomobject]@{
  Backup = $BackupRoot
  Health = $health
  Tasks = $tasks
  ForceInstall = Get-ItemPropertyValue $forceList -Name '1'
  RequiredExtension = Get-Content -LiteralPath $envFile -Encoding UTF8 |
    Where-Object { $_ -like 'WORKFLOW_REQUIRED_EXTENSION_IDS=*' }
  NativeOrigins = if (Test-Path -LiteralPath $nativeManifest) {
    (Get-Content -LiteralPath $nativeManifest -Raw -Encoding UTF8 | ConvertFrom-Json).allowed_origins
  } else { @() }
} | ConvertTo-Json -Depth 6 -Compress
