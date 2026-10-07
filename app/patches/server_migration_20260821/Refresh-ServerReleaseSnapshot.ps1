[CmdletBinding()]
param(
  [string]$ReleaseRoot = '',
  [string]$SourceInstallRoot = 'C:\pdd-native',
  [string]$ApplicationOverlayRoot = '',
  [string]$ExpectedMigrationRoot = '',
  [switch]$ConfirmSourceQuiesced,
  [switch]$RefreshApplicationOverlay,
  [switch]$ValidateOnly,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$migrationCatalogTools = Join-Path $PSScriptRoot 'MigrationCatalog.ps1'
if (-not (Test-Path -LiteralPath $migrationCatalogTools -PathType Leaf)) {
  throw "Migration catalog tools are missing: $migrationCatalogTools"
}
. $migrationCatalogTools
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
  $ReleaseRoot = $PSScriptRoot
}

function Get-FullPath {
  param([Parameter(Mandatory)][string]$Path)
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Get-ExtendedPath {
  param([Parameter(Mandatory)][string]$Path)
  if ($Path.StartsWith('\\?\')) { return $Path }
  $resolved = Get-FullPath $Path
  if ($resolved.StartsWith('\\')) {
    return '\\?\UNC\' + $resolved.Substring(2)
  }
  return '\\?\' + $resolved
}

function Remove-ExtendedPathPrefix {
  param([Parameter(Mandatory)][string]$Path)
  if ($Path.StartsWith('\\?\UNC\')) { return '\\' + $Path.Substring(8) }
  if ($Path.StartsWith('\\?\')) { return $Path.Substring(4) }
  return $Path
}

function Test-FileExists {
  param([Parameter(Mandatory)][string]$Path)
  return [IO.File]::Exists((Get-ExtendedPath $Path))
}

function Test-DirectoryExists {
  param([Parameter(Mandatory)][string]$Path)
  return [IO.Directory]::Exists((Get-ExtendedPath $Path))
}

function Get-Sha256Hash {
  param([Parameter(Mandatory)][string]$Path)
  $stream = [IO.File]::Open(
    (Get-ExtendedPath $Path),
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite
  )
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Assert-PathWithinRoot {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path,
    [switch]$AllowRoot
  )
  $resolvedRoot = Get-FullPath $Root
  $resolvedPath = Get-FullPath $Path
  $isRoot = $resolvedPath.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)
  $isChild = $resolvedPath.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)
  if ((-not $AllowRoot -and $isRoot) -or (-not $isRoot -and -not $isChild)) {
    throw "Path escapes the expected root: $resolvedPath"
  }
}

function Assert-IndependentRoots {
  param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ReleaseRoot
  )
  $source = Get-FullPath $SourceRoot
  $release = Get-FullPath $ReleaseRoot
  if ($source.Equals($release, [StringComparison]::OrdinalIgnoreCase) -or
      $source.StartsWith("$release\", [StringComparison]::OrdinalIgnoreCase) -or
      $release.StartsWith("$source\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Source installation and release roots must be independent directories.'
  }
}

function Assert-RequiredFile {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-FileExists $Path)) {
    throw "Required file is missing: $Path"
  }
}

function Assert-RequiredDirectory {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-DirectoryExists $Path)) {
    throw "Required directory is missing: $Path"
  }
}

function Get-DotEnvValue {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Name
  )
  $escapedName = [Regex]::Escape($Name)
  $line = Get-Content -LiteralPath $Path -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$escapedName\s*=" } |
    Select-Object -Last 1
  if ($null -eq $line) { return $null }
  $value = [string](($line -split '=', 2)[1]).Trim()
  if ($value.Length -ge 2 -and
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
       ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Get-ReleaseFiles {
  param(
    [Parameter(Mandatory)][string]$Root,
    [string]$ExcludedRelativePath = 'SHA256SUMS.txt'
  )
  $resolvedRoot = Get-FullPath $Root
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($resolvedRoot)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($filePath in [IO.Directory]::EnumerateFiles((Get-ExtendedPath $directory))) {
      $normalFilePath = Remove-ExtendedPathPrefix $filePath
      $relativePath = $normalFilePath.Substring($resolvedRoot.Length).TrimStart('\').Replace('\', '/')
      if ($relativePath -cne $ExcludedRelativePath) {
        [PSCustomObject]@{
          Path = $normalFilePath
          RelativePath = $relativePath
        }
      }
    }
    foreach ($childPath in [IO.Directory]::EnumerateDirectories((Get-ExtendedPath $directory))) {
      $child = [IO.DirectoryInfo]::new($childPath)
      if (-not ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        $pending.Push((Remove-ExtendedPathPrefix $child.FullName))
      }
    }
  }
}

function Write-ReleaseManifest {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Destination
  )
  $records = @(
    Get-ReleaseFiles -Root $Root | ForEach-Object {
      if ($_.RelativePath.IndexOfAny([char[]]"`r`n") -ge 0) {
        throw "Release path contains a newline: $($_.RelativePath)"
      }
      [PSCustomObject]@{
        RelativePath = $_.RelativePath
        Hash = Get-Sha256Hash $_.Path
      }
    } | Sort-Object RelativePath
  )
  $encoding = [Text.UTF8Encoding]::new($false)
  $writer = [IO.StreamWriter]::new($Destination, $false, $encoding)
  try {
    foreach ($record in $records) {
      $writer.WriteLine("$($record.Hash)  $($record.RelativePath)")
    }
  } finally {
    $writer.Dispose()
  }
  return $records.Count
}

function Test-ReleaseManifest {
  param([Parameter(Mandatory)][string]$Root)
  $resolvedRoot = Get-FullPath $Root
  $manifestPath = Join-Path $resolvedRoot 'SHA256SUMS.txt'
  Assert-RequiredFile $manifestPath
  $manifestPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $entries = 0
  foreach ($line in Get-Content -LiteralPath $manifestPath -Encoding UTF8) {
    if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
      throw "Malformed SHA256 manifest line: $line"
    }
    $expectedHash = $Matches[1].ToUpperInvariant()
    $relativePath = $Matches[2].Replace('/', '\')
    if (-not $manifestPaths.Add($relativePath)) {
      throw "Duplicate SHA256 manifest path: $relativePath"
    }
    $candidate = Get-FullPath (Join-Path $resolvedRoot $relativePath)
    Assert-PathWithinRoot -Root $resolvedRoot -Path $candidate
    Assert-RequiredFile $candidate
    $actualHash = (Get-Sha256Hash $candidate).ToUpperInvariant()
    if ($actualHash -cne $expectedHash) {
      throw "Release checksum mismatch: $relativePath"
    }
    $entries += 1
  }
  if ($entries -lt 1) { throw 'The release manifest is empty.' }

  $actualPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in Get-ReleaseFiles -Root $resolvedRoot) {
    $nativeRelativePath = $file.RelativePath.Replace('/', '\')
    [void]$actualPaths.Add($nativeRelativePath)
    if (-not $manifestPaths.Contains($nativeRelativePath)) {
      throw "Release file is missing from SHA256 manifest: $nativeRelativePath"
    }
  }
  foreach ($relativePath in $manifestPaths) {
    if (-not $actualPaths.Contains($relativePath)) {
      throw "SHA256 manifest contains a missing file: $relativePath"
    }
  }
  return [ordered]@{
    Valid = $true
    Entries = $entries
    ManifestSha256 = Get-Sha256Hash $manifestPath
  }
}

function Get-DirectorySummary {
  param([Parameter(Mandatory)][string]$Path)
  [int64]$bytes = 0
  $files = 0
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push((Get-FullPath $Path))
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($filePath in [IO.Directory]::EnumerateFiles((Get-ExtendedPath $directory))) {
      $item = [IO.FileInfo]::new($filePath)
      $files += 1
      $bytes += [int64]$item.Length
    }
    foreach ($childPath in [IO.Directory]::EnumerateDirectories((Get-ExtendedPath $directory))) {
      $child = [IO.DirectoryInfo]::new($childPath)
      if (-not ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        $pending.Push((Remove-ExtendedPathPrefix $child.FullName))
      }
    }
  }
  return [ordered]@{ Files = $files; Bytes = $bytes }
}

function Assert-ExplicitConfirmation {
  param([bool]$Confirmed)
  if (-not $Confirmed) {
    throw 'Snapshot refresh requires -ConfirmSourceQuiesced after the source Worker, API, Web, Notifier, Sync, MinIO, and managed worker browsers are stopped.'
  }
}

function Assert-SourceQuiesced {
  param([Parameter(Mandatory)][string]$SourceRoot)
  $issues = [Collections.Generic.List[string]]::new()
  foreach ($taskName in @(
    'PDD Native Worker',
    'PDD Native Window Keeper',
    'PDD Native Browser Launcher',
    'PDD Native MinIO',
    'PDD Native Api',
    'PDD Native Web',
    'PDD Native Notifier',
    'PDD Native Sync'
  )) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task -and [string]$task.State -eq 'Running') {
      $issues.Add("scheduled task is running: $taskName")
    }
  }
  foreach ($port in @(3000, 4173, 9000, 9001)) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
      $issues.Add("TCP port is still listening: $port")
    }
  }

  $source = Get-FullPath $SourceRoot
  $sourceApp = Join-Path $source 'app'
  $sourceRuntime = Join-Path $source 'runtime'
  $sourceWorkflow = Join-Path $source 'data\workflow'
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $name = [string]$process.Name
    $executablePath = [string]$process.ExecutablePath
    $commandLine = [string]$process.CommandLine
    $managed = $false
    if ($name -ieq 'minio.exe' -and
        $executablePath.StartsWith("$sourceRuntime\", [StringComparison]::OrdinalIgnoreCase)) {
      $managed = $true
    } elseif ($name -ieq 'node.exe' -and
        $executablePath.StartsWith("$sourceRuntime\", [StringComparison]::OrdinalIgnoreCase) -and
        $commandLine.IndexOf($sourceApp, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $managed = $true
    } elseif ($name -ieq 'powershell.exe' -and
        $commandLine.IndexOf("$sourceApp\scripts\run-native-windows-", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $managed = $true
    } elseif ($name -ieq 'chrome.exe' -and
        $commandLine.IndexOf($sourceWorkflow, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $managed = $true
    }
    if ($managed) {
      $issues.Add("managed source process is still running: $name PID $($process.ProcessId)")
    }
  }

  $postgres = Get-Service -Name 'pdd-postgresql-16' -ErrorAction SilentlyContinue
  if (-not $postgres -or [string]$postgres.Status -ne 'Running') {
    $issues.Add('PostgreSQL service pdd-postgresql-16 must remain running for pg_dump')
  }
  if ($issues.Count -gt 0) {
    throw "Source is not quiesced:`r`n - $($issues -join "`r`n - ")"
  }
}

function Invoke-DirectoryMirror {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination
  )
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  & robocopy.exe $Source $Destination /MIR /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1 /MT:8 /NFL /NDL /NJH /NJS /NP | Out-Null
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "MinIO snapshot copy failed with robocopy exit code $exitCode"
  }
}

function Invoke-DirectoryOverlay {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination
  )
  Assert-RequiredDirectory $Source
  Assert-RequiredDirectory $Destination
  & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1 /MT:8 /NFL /NDL /NJH /NJS /NP | Out-Null
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "Application overlay copy failed with robocopy exit code $exitCode"
  }
}

function Invoke-RefreshReleaseApplicationOverlay {
  param(
    [Parameter(Mandatory)][string]$OverlayRoot,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$RefreshScriptPath,
    [Parameter(Mandatory)][string]$MigrationCatalogToolsPath,
    [Parameter(Mandatory)][string]$MigrationSourceRoot,
    [Parameter(Mandatory)][string]$ExpectedMigrationRoot
  )
  $overlay = Get-FullPath $OverlayRoot
  $release = Get-FullPath $ReleaseRoot
  Assert-IndependentRoots -SourceRoot $overlay -ReleaseRoot $release
  $releaseApp = Join-Path $release 'app'
  $releaseMetadata = Join-Path $release 'SNAPSHOT-METADATA.json'
  $releaseManifest = Join-Path $release 'SHA256SUMS.txt'
  $releaseMigrationRoot = Join-Path $releaseApp 'infra\db\migrations'
  foreach ($directory in @($overlay, $releaseApp, $MigrationSourceRoot, $ExpectedMigrationRoot)) {
    Assert-RequiredDirectory $directory
  }
  foreach ($file in @($releaseMetadata, $releaseManifest, $RefreshScriptPath, $MigrationCatalogToolsPath)) {
    Assert-RequiredFile $file
  }

  $overlayFiles = @(Get-ReleaseFiles -Root $overlay -ExcludedRelativePath '')
  if ($overlayFiles.Count -lt 1) {
    throw 'Application overlay contains no files.'
  }
  foreach ($file in $overlayFiles) {
    $target = Get-FullPath (Join-Path $releaseApp $file.RelativePath.Replace('/', '\'))
    Assert-PathWithinRoot -Root $releaseApp -Path $target
  }

  New-Item -ItemType Directory -Path $releaseMigrationRoot -Force | Out-Null
  foreach ($migration in @(Get-PddMigrationFiles -MigrationRoot $MigrationSourceRoot)) {
    Copy-Item -LiteralPath $migration.FullName -Destination `
      (Join-Path $releaseMigrationRoot $migration.Name) -Force
  }
  Invoke-DirectoryOverlay -Source $overlay -Destination $releaseApp
  Assert-PddMigrationNames -ExpectedRoot $ExpectedMigrationRoot -ActualRoot $releaseMigrationRoot `
    -Context 'Refreshed release migration directory' | Out-Null
  $releaseMigrationCatalog = Write-PddMigrationCatalog -MigrationRoot $releaseMigrationRoot `
    -Destination (Join-Path $releaseApp 'infra\db\migration-catalog.json')
  Copy-Item -LiteralPath $RefreshScriptPath -Destination (Join-Path $release 'REFRESH-SNAPSHOT.ps1') -Force
  Copy-Item -LiteralPath $MigrationCatalogToolsPath `
    -Destination (Join-Path $release 'MigrationCatalog.ps1') -Force

  $refreshedAt = [DateTimeOffset]::Now.ToString('o')
  $metadata = Get-Content -LiteralPath $releaseMetadata -Raw -Encoding UTF8 | ConvertFrom-Json
  $metadata | Add-Member -NotePropertyName applicationOverlayRefreshedAt `
    -NotePropertyValue $refreshedAt -Force
  $metadata | Add-Member -NotePropertyName applicationOverlayFiles `
    -NotePropertyValue ([int]$overlayFiles.Count) -Force
  $metadata | Add-Member -NotePropertyName migrationCount `
    -NotePropertyValue ([int]$releaseMigrationCatalog.migrationCount) -Force
  $metadata | Add-Member -NotePropertyName latestMigration `
    -NotePropertyValue ([string]$releaseMigrationCatalog.latestMigration) -Force
  [IO.File]::WriteAllText(
    $releaseMetadata,
    ($metadata | ConvertTo-Json -Depth 8),
    [Text.UTF8Encoding]::new($false)
  )

  $manifestStaging = Join-Path (Split-Path -Parent $release) `
    ('.' + (Split-Path -Leaf $release) + '.application-overlay-' + [Guid]::NewGuid().ToString('N') + '.sha256')
  try {
    $manifestEntries = Write-ReleaseManifest -Root $release -Destination $manifestStaging
    Move-Item -LiteralPath $manifestStaging -Destination $releaseManifest -Force
    $validation = Test-ReleaseManifest -Root $release
    return [ordered]@{
      ApplicationOverlayRefreshed = $true
      RefreshedAt = $refreshedAt
      OverlayFiles = [int]$overlayFiles.Count
      MigrationCount = [int]$releaseMigrationCatalog.migrationCount
      LatestMigration = [string]$releaseMigrationCatalog.latestMigration
      ManifestEntries = [int]$manifestEntries
      ManifestSha256 = [string]$validation.ManifestSha256
      DatabaseRefreshed = $false
      ObjectStorageRefreshed = $false
    }
  } finally {
    if (Test-FileExists $manifestStaging) {
      [IO.File]::Delete((Get-ExtendedPath $manifestStaging))
    }
  }
}

function Invoke-SnapshotTool {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments
  )
  if ([IO.Path]::GetExtension($Path) -ieq '.ps1') {
    return [int](& $Path -Arguments $Arguments)
  }
  & $Path @Arguments *> $null
  return [int]$LASTEXITCODE
}

function Remove-PathSafely {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path
  )
  Assert-PathWithinRoot -Root $Root -Path $Path
  $extendedPath = Get-ExtendedPath $Path
  if ([IO.File]::Exists($extendedPath)) {
    [IO.File]::Delete($extendedPath)
  } elseif ([IO.Directory]::Exists($extendedPath)) {
    [IO.Directory]::Delete($extendedPath, $true)
  }
}

function Switch-SnapshotPath {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[object]]$Journal,
    [Parameter(Mandatory)][string]$Label,
    [Parameter(Mandatory)][string]$Target,
    [Parameter(Mandatory)][string]$Staged,
    [Parameter(Mandatory)][string]$Backup
  )
  if (-not (Test-FileExists $Target) -and -not (Test-DirectoryExists $Target)) {
    throw "Snapshot target is missing: $Target"
  }
  if (-not (Test-FileExists $Staged) -and -not (Test-DirectoryExists $Staged)) {
    throw "Staged snapshot is missing: $Staged"
  }
  $entry = [PSCustomObject]@{
    Label = $Label
    Target = $Target
    Backup = $Backup
    Installed = $false
  }
  Move-Item -LiteralPath $Target -Destination $Backup
  $Journal.Add($entry)
  Move-Item -LiteralPath $Staged -Destination $Target
  $entry.Installed = $true
}

function Restore-SnapshotJournal {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[object]]$Journal,
    [Parameter(Mandatory)][string]$ReleaseRoot
  )
  for ($index = $Journal.Count - 1; $index -ge 0; $index -= 1) {
    $entry = $Journal[$index]
    if ((Test-FileExists $entry.Target) -or (Test-DirectoryExists $entry.Target)) {
      Remove-PathSafely -Root $ReleaseRoot -Path $entry.Target
    }
    if ((Test-FileExists $entry.Backup) -or (Test-DirectoryExists $entry.Backup)) {
      Move-Item -LiteralPath $entry.Backup -Destination $entry.Target
    }
  }
}

function Invoke-RefreshReleaseSnapshot {
  param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$PgDumpPath,
    [Parameter(Mandatory)][string]$PgRestorePath,
    [switch]$SkipRuntimeChecks,
    [string]$FailAfterSwitchLabel = ''
  )
  $source = Get-FullPath $SourceRoot
  $release = Get-FullPath $ReleaseRoot
  Assert-IndependentRoots -SourceRoot $source -ReleaseRoot $release

  $sourceEnvironment = Join-Path $source 'app\.env.native'
  $sourceMinio = Join-Path $source 'data\minio'
  $releaseEnvironment = Join-Path $release 'app\.env.native'
  $releaseDatabase = Join-Path $release 'database\pdd-workflow.dump'
  $releaseMinio = Join-Path $release 'object-storage\minio-data'
  $releaseMetadata = Join-Path $release 'SNAPSHOT-METADATA.json'
  $releaseManifest = Join-Path $release 'SHA256SUMS.txt'
  foreach ($file in @(
    $sourceEnvironment,
    $releaseEnvironment,
    $releaseDatabase,
    $releaseMetadata,
    $releaseManifest,
    $PgDumpPath,
    $PgRestorePath
  )) {
    Assert-RequiredFile $file
  }
  foreach ($directory in @($sourceMinio, $releaseMinio)) {
    Assert-RequiredDirectory $directory
  }
  if (-not $SkipRuntimeChecks) {
    Assert-SourceQuiesced -SourceRoot $source
  }
  [void](Test-ReleaseManifest -Root $release)

  $databaseUrl = Get-DotEnvValue -Path $sourceEnvironment -Name 'DATABASE_URL'
  if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
    throw 'DATABASE_URL is missing from the source .env.native.'
  }

  $transactionRoot = Join-Path (Split-Path -Parent $release) `
    ('.' + (Split-Path -Leaf $release) + '.snapshot-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $transactionRoot | Out-Null
  Assert-PathWithinRoot -Root (Split-Path -Parent $release) -Path $transactionRoot
  $journal = [Collections.Generic.List[object]]::new()
  $completed = $false
  try {
    $stagedEnvironment = Join-Path $transactionRoot 'new.env.native'
    $stagedDatabase = Join-Path $transactionRoot 'new.pdd-workflow.dump'
    $stagedMinio = Join-Path $transactionRoot 'new.minio-data'
    Copy-Item -LiteralPath $sourceEnvironment -Destination $stagedEnvironment

    $dumpExitCode = Invoke-SnapshotTool -Path $PgDumpPath -Arguments @(
      '--format=custom',
      '--compress=6',
      '--no-owner',
      '--no-privileges',
      "--file=$stagedDatabase",
      "--dbname=$databaseUrl"
    )
    if ($dumpExitCode -ne 0 -or -not (Test-FileExists $stagedDatabase) -or
        ([IO.FileInfo]::new((Get-ExtendedPath $stagedDatabase))).Length -lt 1) {
      throw "pg_dump snapshot refresh failed with exit code $dumpExitCode"
    }
    $restoreExitCode = Invoke-SnapshotTool -Path $PgRestorePath -Arguments @('--list', $stagedDatabase)
    if ($restoreExitCode -ne 0) {
      throw "pg_restore catalog validation failed with exit code $restoreExitCode"
    }

    Invoke-DirectoryMirror -Source $sourceMinio -Destination $stagedMinio
    $sourceMinioSummary = Get-DirectorySummary $sourceMinio
    $stagedMinioSummary = Get-DirectorySummary $stagedMinio
    if ($sourceMinioSummary.Files -ne $stagedMinioSummary.Files -or
        $sourceMinioSummary.Bytes -ne $stagedMinioSummary.Bytes) {
      throw 'Staged MinIO snapshot file count or byte count differs from the stopped source.'
    }
    $refreshedAt = [DateTimeOffset]::Now.ToString('o')
    $stagedDatabaseFile = [IO.FileInfo]::new((Get-ExtendedPath $stagedDatabase))
    $stagedDatabaseHash = Get-Sha256Hash $stagedDatabase
    $stagedEnvironmentHash = Get-Sha256Hash $stagedEnvironment
    $stagedMetadata = Join-Path $transactionRoot 'new.SNAPSHOT-METADATA.json'
    $metadata = [ordered]@{
      formatVersion = 1
      refreshedAt = $refreshedAt
      sourceInstallRoot = $source
      sourceQuiescenceVerified = -not [bool]$SkipRuntimeChecks
      environment = [ordered]@{
        source = 'app/.env.native'
        sha256 = $stagedEnvironmentHash
      }
      database = [ordered]@{
        source = 'DATABASE_URL from app/.env.native'
        path = 'database/pdd-workflow.dump'
        format = 'PostgreSQL custom'
        bytes = [int64]$stagedDatabaseFile.Length
        sha256 = $stagedDatabaseHash
        catalogValidated = $true
      }
      objectStorage = [ordered]@{
        source = 'data/minio'
        path = 'object-storage/minio-data'
        files = [int]$stagedMinioSummary.Files
        bytes = [int64]$stagedMinioSummary.Bytes
      }
    }
    [IO.File]::WriteAllText(
      $stagedMetadata,
      ($metadata | ConvertTo-Json -Depth 6),
      [Text.UTF8Encoding]::new($false)
    )

    foreach ($item in @(
      [ordered]@{ Label = 'Environment'; Target = $releaseEnvironment; Staged = $stagedEnvironment; Backup = (Join-Path $transactionRoot 'old.env.native') },
      [ordered]@{ Label = 'Database'; Target = $releaseDatabase; Staged = $stagedDatabase; Backup = (Join-Path $transactionRoot 'old.pdd-workflow.dump') },
      [ordered]@{ Label = 'MinIO'; Target = $releaseMinio; Staged = $stagedMinio; Backup = (Join-Path $transactionRoot 'old.minio-data') },
      [ordered]@{ Label = 'Metadata'; Target = $releaseMetadata; Staged = $stagedMetadata; Backup = (Join-Path $transactionRoot 'old.SNAPSHOT-METADATA.json') }
    )) {
      Switch-SnapshotPath -Journal $journal -Label $item.Label -Target $item.Target `
        -Staged $item.Staged -Backup $item.Backup
      if ($FailAfterSwitchLabel -and $item.Label -eq $FailAfterSwitchLabel) {
        throw "Injected self-test failure after switching $($item.Label)."
      }
    }

    $stagedManifest = Join-Path $transactionRoot 'new.SHA256SUMS.txt'
    [void](Write-ReleaseManifest -Root $release -Destination $stagedManifest)
    Switch-SnapshotPath -Journal $journal -Label 'Manifest' -Target $releaseManifest `
      -Staged $stagedManifest -Backup (Join-Path $transactionRoot 'old.SHA256SUMS.txt')
    if ($FailAfterSwitchLabel -eq 'Manifest') {
      throw 'Injected self-test failure after switching Manifest.'
    }

    $validation = Test-ReleaseManifest -Root $release
    $completed = $true
    return [ordered]@{
      Refreshed = $true
      RefreshedAt = $refreshedAt
      DatabaseBytes = [int64]$stagedDatabaseFile.Length
      DatabaseSha256 = $stagedDatabaseHash
      MinioFiles = [int]$stagedMinioSummary.Files
      MinioBytes = [int64]$stagedMinioSummary.Bytes
      ManifestEntries = [int]$validation.Entries
      ManifestSha256 = [string]$validation.ManifestSha256
    }
  } catch {
    Restore-SnapshotJournal -Journal $journal -ReleaseRoot $release
    throw
  } finally {
    if ($completed) {
      foreach ($entry in $journal) {
        if ((Test-FileExists $entry.Backup) -or (Test-DirectoryExists $entry.Backup)) {
          Remove-PathSafely -Root $transactionRoot -Path $entry.Backup
        }
      }
    }
    if (Test-DirectoryExists $transactionRoot) {
      Remove-PathSafely -Root (Split-Path -Parent $release) -Path $transactionRoot
    }
  }
}

function Write-FixtureText {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Value
  )
  $parent = Split-Path -Parent $Path
  if ($parent) { [void][IO.Directory]::CreateDirectory((Get-ExtendedPath $parent)) }
  [IO.File]::WriteAllText((Get-ExtendedPath $Path), $Value, [Text.UTF8Encoding]::new($false))
}

function Invoke-SnapshotRefreshSelfTest {
  $selfTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('pdd-release-refresh-' + [Guid]::NewGuid().ToString('N'))
  $source = Join-Path $selfTestRoot 'source'
  $release = Join-Path $selfTestRoot 'release'
  $tools = Join-Path $selfTestRoot 'tools'
  New-Item -ItemType Directory -Path $source, $release, $tools -Force | Out-Null
  try {
    Write-FixtureText -Path (Join-Path $source 'app\.env.native') `
      -Value "DATABASE_URL=postgresql://fixture`r`nSNAPSHOT_MARKER=new`r`n"
    Write-FixtureText -Path (Join-Path $source 'data\minio\bucket\new-object.txt') -Value 'new-object'
    Write-FixtureText -Path (Join-Path $release 'app\.env.native') `
      -Value "DATABASE_URL=postgresql://old`r`nSNAPSHOT_MARKER=old`r`n"
    Write-FixtureText -Path (Join-Path $release 'app\workflow.mjs') -Value 'fixture-code'
    $longFixturePath = Join-Path $release `
      ('app\long-path-fixture\' + ('a' * 90) + '\' + ('b' * 90) + '\' + ('c' * 70) + '.txt')
    Write-FixtureText -Path $longFixturePath -Value 'long-path-fixture'
    if ((Get-FullPath $longFixturePath).Length -le 260) {
      throw 'Self-test: long-path fixture did not exceed 260 characters.'
    }
    Write-FixtureText -Path (Join-Path $release 'database\pdd-workflow.dump') -Value 'old-dump'
    Write-FixtureText -Path (Join-Path $release 'object-storage\minio-data\bucket\old-object.txt') -Value 'old-object'
    Write-FixtureText -Path (Join-Path $release 'SNAPSHOT-METADATA.json') -Value '{"fixture":"old"}'

    $pgDump = Join-Path $tools 'pg_dump.ps1'
    $pgRestore = Join-Path $tools 'pg_restore.ps1'
    Write-FixtureText -Path $pgDump -Value (@'
param([string[]]$Arguments)
$outputArgument = @($Arguments | Where-Object { $_.StartsWith('--file=') } | Select-Object -First 1)
if ($outputArgument.Count -ne 1) { return 41 }
[IO.File]::WriteAllText($outputArgument[0].Substring(7), 'MOCK-CUSTOM-DUMP')
return 0
'@)
    Write-FixtureText -Path $pgRestore -Value (@'
param([string[]]$Arguments)
if ($Arguments.Count -eq 2 -and $Arguments[0] -eq '--list' -and
    (Test-Path -LiteralPath $Arguments[1] -PathType Leaf)) { return 0 }
return 42
'@)
    [void](Write-ReleaseManifest -Root $release -Destination (Join-Path $release 'SHA256SUMS.txt'))

    $confirmationGuarded = $false
    try { Assert-ExplicitConfirmation -Confirmed $false } catch { $confirmationGuarded = $true }
    if (-not $confirmationGuarded) { throw 'Self-test: explicit confirmation guard did not fail.' }
    $pathGuarded = $false
    try {
      Assert-IndependentRoots -SourceRoot $source -ReleaseRoot (Join-Path $source 'nested-release')
    } catch { $pathGuarded = $true }
    if (-not $pathGuarded) { throw 'Self-test: nested release path guard did not fail.' }

    $result = Invoke-RefreshReleaseSnapshot -SourceRoot $source -ReleaseRoot $release `
      -PgDumpPath $pgDump -PgRestorePath $pgRestore -SkipRuntimeChecks
    if ((Get-Content -LiteralPath (Join-Path $release 'app\.env.native') -Raw) -notmatch 'SNAPSHOT_MARKER=new') {
      throw 'Self-test: environment snapshot was not refreshed.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $release 'object-storage\minio-data\bucket\new-object.txt') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $release 'object-storage\minio-data\bucket\old-object.txt'))) {
      throw 'Self-test: MinIO mirror did not replace the old snapshot.'
    }
    [void](Test-ReleaseManifest -Root $release)

    $baselineEnvironmentHash = Get-Sha256Hash (Join-Path $release 'app\.env.native')
    $baselineDatabaseHash = Get-Sha256Hash (Join-Path $release 'database\pdd-workflow.dump')
    $baselineMinioHash = Get-Sha256Hash (Join-Path $release 'object-storage\minio-data\bucket\new-object.txt')
    $baselineMetadataHash = Get-Sha256Hash (Join-Path $release 'SNAPSHOT-METADATA.json')
    $baselineManifestHash = Get-Sha256Hash (Join-Path $release 'SHA256SUMS.txt')
    Write-FixtureText -Path (Join-Path $source 'app\.env.native') `
      -Value "DATABASE_URL=postgresql://fixture`r`nSNAPSHOT_MARKER=rollback-test`r`n"
    Write-FixtureText -Path (Join-Path $source 'data\minio\bucket\new-object.txt') -Value 'rollback-test-object'
    $rolledBack = $false
    try {
      [void](Invoke-RefreshReleaseSnapshot -SourceRoot $source -ReleaseRoot $release `
        -PgDumpPath $pgDump -PgRestorePath $pgRestore -SkipRuntimeChecks `
        -FailAfterSwitchLabel 'Database')
    } catch {
      $rolledBack = $_.Exception.Message -like 'Injected self-test failure*'
    }
    if (-not $rolledBack) { throw 'Self-test: injected switch failure did not occur.' }
    $postRollbackHashes = @(
      (Get-Sha256Hash (Join-Path $release 'app\.env.native')),
      (Get-Sha256Hash (Join-Path $release 'database\pdd-workflow.dump')),
      (Get-Sha256Hash (Join-Path $release 'object-storage\minio-data\bucket\new-object.txt')),
      (Get-Sha256Hash (Join-Path $release 'SNAPSHOT-METADATA.json')),
      (Get-Sha256Hash (Join-Path $release 'SHA256SUMS.txt'))
    )
    $baselineHashes = @(
      $baselineEnvironmentHash,
      $baselineDatabaseHash,
      $baselineMinioHash,
      $baselineMetadataHash,
      $baselineManifestHash
    )
    for ($index = 0; $index -lt $baselineHashes.Count; $index += 1) {
      if ($baselineHashes[$index] -ne $postRollbackHashes[$index]) {
        throw 'Self-test: a failed transaction did not restore every original snapshot file.'
      }
    }
    [void](Test-ReleaseManifest -Root $release)

    $overlay = Join-Path $selfTestRoot 'overlay'
    $expectedMigrations = Join-Path $selfTestRoot 'expected-migrations'
    Write-FixtureText -Path (Join-Path $source 'app\infra\db\migrations\998_source_fixture.sql') `
      -Value '-- source migration fixture'
    Write-FixtureText -Path (Join-Path $overlay 'workflow.mjs') -Value 'fixture-code-refreshed'
    Write-FixtureText -Path (Join-Path $overlay 'infra\db\migrations\999_overlay_fixture.sql') `
      -Value '-- overlay fixture'
    Write-FixtureText -Path (Join-Path $expectedMigrations '998_source_fixture.sql') `
      -Value '-- source migration fixture'
    Write-FixtureText -Path (Join-Path $expectedMigrations '999_overlay_fixture.sql') `
      -Value '-- overlay fixture'
    $databaseHashBeforeOverlay = Get-Sha256Hash (Join-Path $release 'database\pdd-workflow.dump')
    $minioHashBeforeOverlay = Get-Sha256Hash `
      (Join-Path $release 'object-storage\minio-data\bucket\new-object.txt')
    $overlayResult = Invoke-RefreshReleaseApplicationOverlay -OverlayRoot $overlay `
      -ReleaseRoot $release -RefreshScriptPath $PSCommandPath `
      -MigrationCatalogToolsPath $migrationCatalogTools `
      -MigrationSourceRoot (Join-Path $source 'app\infra\db\migrations') `
      -ExpectedMigrationRoot $expectedMigrations
    if ((Get-Content -LiteralPath (Join-Path $release 'app\workflow.mjs') -Raw) `
        -ne 'fixture-code-refreshed') {
      throw 'Self-test: application overlay did not replace the target file.'
    }
    if (-not (Test-FileExists (Join-Path $release `
          'app\infra\db\migrations\999_overlay_fixture.sql'))) {
      throw 'Self-test: application overlay did not add the new migration.'
    }
    $fixtureMigrationCatalog = Get-Content -LiteralPath (Join-Path $release `
      'app\infra\db\migration-catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$fixtureMigrationCatalog.migrationCount -ne 2 -or
        [string]$fixtureMigrationCatalog.latestMigration -ne '999_overlay_fixture.sql') {
      throw 'Self-test: complete release migration catalog was not generated.'
    }
    if ($databaseHashBeforeOverlay -ne (Get-Sha256Hash (Join-Path $release `
          'database\pdd-workflow.dump')) -or
        $minioHashBeforeOverlay -ne (Get-Sha256Hash (Join-Path $release `
          'object-storage\minio-data\bucket\new-object.txt'))) {
      throw 'Self-test: application overlay modified database or object-storage data.'
    }
    $overlayMetadata = Get-Content -LiteralPath (Join-Path $release 'SNAPSHOT-METADATA.json') `
      -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $overlayMetadata.applicationOverlayRefreshedAt -or
        [int]$overlayMetadata.applicationOverlayFiles -ne 2) {
      throw 'Self-test: application overlay metadata is incomplete.'
    }
    [void](Test-ReleaseManifest -Root $release)

    return [ordered]@{
      SelfTestPassed = $true
      ConfirmationGuardPassed = $true
      PathGuardPassed = $true
      SuccessfulRefreshPassed = $true
      RollbackPassed = $true
      ApplicationOverlayRefreshPassed = [bool]$overlayResult.ApplicationOverlayRefreshed
      ManifestValidationPassed = $true
      FixtureManifestEntries = [int]$overlayResult.ManifestEntries
    }
  } finally {
    if (Test-DirectoryExists $selfTestRoot) {
      Remove-PathSafely -Root ([IO.Path]::GetTempPath()) -Path $selfTestRoot
    }
  }
}

if ($SelfTest) {
  Invoke-SnapshotRefreshSelfTest | ConvertTo-Json -Compress
  return
}

$resolvedReleaseRoot = Get-FullPath $ReleaseRoot
if ($ValidateOnly) {
  Test-ReleaseManifest -Root $resolvedReleaseRoot | ConvertTo-Json -Compress
  return
}
if ($RefreshApplicationOverlay) {
  if ([string]::IsNullOrWhiteSpace($ApplicationOverlayRoot)) {
    throw '-ApplicationOverlayRoot is required with -RefreshApplicationOverlay.'
  }
  $resolvedSourceRoot = Get-FullPath $SourceInstallRoot
  $sourceMigrationRoot = Join-Path $resolvedSourceRoot 'app\infra\db\migrations'
  $requiredMigrationRoot = Resolve-PddExpectedMigrationRoot `
    -ExplicitRoot $ExpectedMigrationRoot -ScriptRoot $PSScriptRoot `
    -FallbackRoot $sourceMigrationRoot
  Invoke-RefreshReleaseApplicationOverlay -OverlayRoot $ApplicationOverlayRoot `
    -ReleaseRoot $resolvedReleaseRoot -RefreshScriptPath $PSCommandPath `
    -MigrationCatalogToolsPath $migrationCatalogTools `
    -MigrationSourceRoot $sourceMigrationRoot `
    -ExpectedMigrationRoot $requiredMigrationRoot | ConvertTo-Json -Compress
  return
}

Assert-ExplicitConfirmation -Confirmed ([bool]$ConfirmSourceQuiesced)
$resolvedSourceRoot = Get-FullPath $SourceInstallRoot
$pgDump = Join-Path $resolvedSourceRoot 'runtime\postgres\bin\pg_dump.exe'
$pgRestore = Join-Path $resolvedSourceRoot 'runtime\postgres\bin\pg_restore.exe'
Invoke-RefreshReleaseSnapshot -SourceRoot $resolvedSourceRoot -ReleaseRoot $resolvedReleaseRoot `
  -PgDumpPath $pgDump -PgRestorePath $pgRestore | ConvertTo-Json -Compress
