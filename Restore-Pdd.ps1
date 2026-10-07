param(
  [string]$InstallRoot = $PSScriptRoot,
  [int]$DatabasePort = 5433,
  [int]$StoragePort = 9000,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$manifestPath = Join-Path $sourceRoot 'snapshot\manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'snapshot\manifest.json is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne 1) { throw 'Unsupported snapshot version.' }
$sourceFiles = Get-Content -LiteralPath (Join-Path $sourceRoot 'snapshot\source-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($file in $sourceFiles) {
  $filePath = [IO.Path]::GetFullPath((Join-Path $sourceRoot $file.path))
  if (-not $filePath.StartsWith($sourceRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid source file path.' }
  if ((Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('Source checksum mismatch: '+$file.path) }
}
if (-not $VerifyOnly -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'data\postgres-local'))) {
  throw 'The target already contains a PostgreSQL database. Select a new empty installation directory.'
}
$workRoot = Join-Path $InstallRoot '.restore-work'
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
foreach ($archive in $manifest.archives) {
  Write-Host ('Verifying ' + $archive.name)
  $destination = Join-Path $workRoot $archive.name
  $output = [IO.File]::Create($destination)
  try {
    foreach ($part in $archive.parts) {
      $partPath = [IO.Path]::GetFullPath((Join-Path (Join-Path $sourceRoot 'snapshot') $part.file))
      if (-not $partPath.StartsWith((Join-Path $sourceRoot 'snapshot') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid snapshot part path.' }
      $actual = (Get-FileHash -LiteralPath $partPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $part.sha256) { throw ('Snapshot checksum mismatch: ' + $part.file) }
      $input = [IO.File]::OpenRead($partPath)
      try { $input.CopyTo($output) } finally { $input.Dispose() }
    }
  } finally { $output.Dispose() }
  if ((Get-Item -LiteralPath $destination).Length -ne [int64]$archive.size) { throw ('Archive length mismatch: ' + $archive.name) }
  if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archive.sha256) { throw ('Archive checksum mismatch: ' + $archive.name) }
}
if ($VerifyOnly) { Write-Host 'All snapshot archive checksums passed.'; return }
if (-not $InstallRoot.Equals($sourceRoot,[StringComparison]::OrdinalIgnoreCase)) {
  & robocopy.exe $sourceRoot $InstallRoot /E /XD .git snapshot .restore-work /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) { throw 'Copying application files failed.' }
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'snapshot') | Out-Null
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $InstallRoot 'snapshot\manifest.json')
  foreach ($name in @('roles.sql','ownership-and-grants.sql','database-settings.json','database-counts.json')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot ('snapshot\'+$name)) -Destination (Join-Path $InstallRoot 'snapshot')
  }
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'snapshot\postgres-config') -Destination (Join-Path $InstallRoot 'snapshot') -Recurse
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'snapshot\windows-tasks') -Destination (Join-Path $InstallRoot 'snapshot') -Recurse
}
foreach ($archiveName in @('dependencies.tar.gz','workflow-data.tar.gz')) {
  & tar.exe -xzf (Join-Path $workRoot $archiveName) -C $InstallRoot
  if ($LASTEXITCODE -ne 0) { throw ('Extracting failed: ' + $archiveName) }
}
& tar.exe -xzf (Join-Path $workRoot 'objects.tar.gz') -C $workRoot
if ($LASTEXITCODE -ne 0) { throw 'Extracting object storage failed.' }
$node = Join-Path $InstallRoot 'runtime\node\node.exe'
if (-not $InstallRoot.Equals('D:\pdd-native',[StringComparison]::OrdinalIgnoreCase)) {
  & $node (Join-Path $InstallRoot 'snapshot-tools\relocate.mjs') $InstallRoot
  if ($LASTEXITCODE -ne 0) { throw 'Relocating configuration paths failed.' }
}
$gatewayKey = Join-Path $InstallRoot 'cloud-gateway\id_ed25519'
if (Test-Path -LiteralPath $gatewayKey) {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $gatewayKey /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' ('*'+$currentSid+':(F)') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restoring SSH private-key file permissions failed.' }
}
. (Join-Path $InstallRoot 'load-local-env.ps1')
& $node (Join-Path $InstallRoot 'snapshot-tools\restore.mjs') $InstallRoot $DatabasePort $StoragePort
if ($LASTEXITCODE -ne 0) { throw 'Database/object restore failed. See .restore-work logs.' }
Write-Host 'Restore and database row-count verification completed. No business workers have been started.'
Write-Host 'Run Install-PddTasks.ps1 as administrator, then start-local.ps1. Log in to each shop again.'
