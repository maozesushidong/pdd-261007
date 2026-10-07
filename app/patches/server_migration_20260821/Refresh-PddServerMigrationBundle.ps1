[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$PatchOverlayRoot,
  [string]$SourceInstallRoot = 'C:\pdd-native',
  [string]$ExpectedMigrationRoot = '',
  [string]$SourceGitCommit = '',
  [switch]$RefreshDatabaseDump
)

$ErrorActionPreference = 'Stop'
$migrationCatalogTools = Join-Path $PSScriptRoot 'MigrationCatalog.ps1'
if (-not (Test-Path -LiteralPath $migrationCatalogTools -PathType Leaf)) {
  throw "Migration catalog tools are missing: $migrationCatalogTools"
}
. $migrationCatalogTools

function Get-FullPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-ChildPath([string]$Root, [string]$Path) {
  $rootPrefix = "$Root\"
  if (-not $Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escapes bundle root: $Path"
  }
}

function Get-DirectorySummary([string]$Path) {
  $fileCount = 0
  [int64]$byteCount = 0
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Path)
  while ($pending.Count) {
    $directory = $pending.Pop()
    try {
      foreach ($filePath in [IO.Directory]::EnumerateFiles($directory)) {
        try {
          $file = [IO.FileInfo]::new($filePath)
          $fileCount++
          $byteCount += [int64]$file.Length
        } catch { }
      }
      foreach ($childPath in [IO.Directory]::EnumerateDirectories($directory)) {
        try {
          $child = [IO.DirectoryInfo]::new($childPath)
          if (-not ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $pending.Push($childPath)
          }
        } catch { }
      }
    } catch { }
  }
  return [ordered]@{
    files = $fileCount
    bytes = $byteCount
  }
}

function Copy-MaterializedDirectNodeModules {
  param(
    [Parameter(Mandatory)][string]$SourceApp,
    [Parameter(Mandatory)][string]$DestinationApp
  )
  $sourceNodeModules = Join-Path $SourceApp 'node_modules'
  $sourcePackage = Get-Content -LiteralPath (Join-Path $SourceApp 'package.json') -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $declaredNodeModules = @(
    @($sourcePackage.dependencies.PSObject.Properties.Name)
    @($sourcePackage.devDependencies.PSObject.Properties.Name)
  ) | Sort-Object -Unique
  if (-not (Test-Path -LiteralPath $sourceNodeModules -PathType Container)) {
    if (-not $declaredNodeModules.Count) { return @() }
    throw "Source node_modules is missing: $sourceNodeModules"
  }
  $destinationNodeModules = Join-Path $DestinationApp 'node_modules'
  New-Item -ItemType Directory -Path $destinationNodeModules -Force | Out-Null
  $sourceRoot = Get-FullPath $sourceNodeModules
  $sourcePrefix = (Get-FullPath $sourceNodeModules) + '\'
  $materialized = [Collections.Generic.List[string]]::new()
  foreach ($moduleName in $declaredNodeModules) {
    $sourcePath = Join-Path $sourceNodeModules $moduleName.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
      throw "Direct node module is missing from source install: $moduleName"
    }
    $entry = Get-Item -LiteralPath $sourcePath -Force
    $copySource = Get-FullPath $sourcePath
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $targets = @($entry.Target)
      if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) {
        throw "Direct node module link target is invalid: $moduleName"
      }
      $copySource = if ([IO.Path]::IsPathRooted([string]$targets[0])) {
        Get-FullPath ([string]$targets[0])
      } else {
        Get-FullPath (Join-Path (Split-Path -Parent $entry.FullName) ([string]$targets[0]))
      }
    }
    if ($copySource -ne $sourceRoot -and
        -not $copySource.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Direct node module source escapes node_modules: $moduleName -> $copySource"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $copySource 'package.json') -PathType Leaf)) {
      throw "Direct node module source is incomplete: $moduleName -> $copySource"
    }
    $destinationPath = Join-Path $destinationNodeModules $moduleName.Replace('/', '\')
    $copyArguments = @(
      $copySource, $destinationPath, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ',
      '/R:2', '/W:2', '/MT:8', '/NP', '/NFL', '/NDL', '/NJH', '/NJS'
    )
    & robocopy.exe @copyArguments | Out-Null
    if ($LASTEXITCODE -gt 7) {
      throw "Node module materialization failed with robocopy exit code $LASTEXITCODE`: $moduleName"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $destinationPath 'package.json') -PathType Leaf)) {
      throw "Materialized node module is incomplete: $moduleName"
    }
    $materialized.Add($moduleName)
  }
  return @($materialized)
}

function Get-EnvironmentValue([string]$EnvFile, [string]$Name) {
  $line = Get-Content -LiteralPath $EnvFile -Encoding UTF8 |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -First 1
  if (-not $line) { return $null }
  $value = $line.Substring($line.IndexOf('=') + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

$bundle = Get-FullPath $BundleRoot
$overlay = Get-FullPath $PatchOverlayRoot
$sourceRoot = Get-FullPath $SourceInstallRoot
$sourceApp = Join-Path $sourceRoot 'app'
$manifestPath = Join-Path $bundle 'migration-manifest.json'
$payloadApp = Join-Path $bundle 'payload\app'
$toolsRoot = Join-Path $bundle 'migration-tools'

foreach ($required in @($bundle, $overlay, $payloadApp, $toolsRoot)) {
  if (-not (Test-Path -LiteralPath $required -PathType Container)) {
    throw "Required directory is missing: $required"
  }
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Migration manifest is missing: $manifestPath"
}

$sourceMigrationRoot = Join-Path $sourceApp 'infra\db\migrations'
$requiredMigrationRoot = Resolve-PddExpectedMigrationRoot `
  -ExplicitRoot $ExpectedMigrationRoot -ScriptRoot $PSScriptRoot `
  -FallbackRoot $sourceMigrationRoot
Assert-PddMigrationNames -ExpectedRoot $requiredMigrationRoot -ActualRoot $sourceMigrationRoot `
  -Context 'Source installation migration directory' | Out-Null
$payloadMigrationRoot = Join-Path $payloadApp 'infra\db\migrations'
New-Item -ItemType Directory -Path $payloadMigrationRoot -Force | Out-Null
foreach ($migration in @(Get-PddMigrationFiles -MigrationRoot $sourceMigrationRoot)) {
  Copy-Item -LiteralPath $migration.FullName -Destination `
    (Join-Path $payloadMigrationRoot $migration.Name) -Force
}

$copyArguments = @(
  $overlay, $payloadApp, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ',
  '/R:2', '/W:2', '/MT:8', '/NP', '/NFL', '/NDL', '/NJH', '/NJS'
)
& robocopy.exe @copyArguments | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Overlay refresh failed with robocopy exit code $LASTEXITCODE" }
Assert-PddMigrationNames -ExpectedRoot $requiredMigrationRoot -ActualRoot $payloadMigrationRoot `
  -Context 'Refreshed bundle migration directory' | Out-Null
$payloadMigrationCatalog = Write-PddMigrationCatalog -MigrationRoot $payloadMigrationRoot `
  -Destination (Join-Path $payloadApp 'infra\db\migration-catalog.json')
$materializedNodeModules = @(Copy-MaterializedDirectNodeModules `
  -SourceApp $sourceApp -DestinationApp $payloadApp)

Copy-Item -Path (Join-Path $PSScriptRoot '*.ps1') -Destination $toolsRoot -Force
Copy-Item -Path (Join-Path $PSScriptRoot '*.md') -Destination $toolsRoot -Force

if ($RefreshDatabaseDump) {
  $sourceEnv = Join-Path $sourceRoot 'app\.env.native'
  $pgDump = Join-Path $sourceRoot 'runtime\postgres\bin\pg_dump.exe'
  $pgRestore = Join-Path $sourceRoot 'runtime\postgres\bin\pg_restore.exe'
  foreach ($required in @($sourceEnv, $pgDump, $pgRestore)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Database refresh prerequisite is missing: $required"
    }
  }
  $databaseUrl = Get-EnvironmentValue -EnvFile $sourceEnv -Name 'DATABASE_URL'
  if (-not $databaseUrl) { throw 'DATABASE_URL is missing from .env.native.' }
  $databaseRoot = Join-Path $bundle 'database'
  New-Item -ItemType Directory -Path $databaseRoot -Force | Out-Null
  $dumpPath = Join-Path $databaseRoot 'postgres-workorders.dump'
  $temporaryDump = Join-Path $databaseRoot 'postgres-workorders.dump.refreshing'
  try {
    & $pgDump '--format=custom' '--compress=6' '--no-owner' '--no-privileges' `
      "--file=$temporaryDump" "--dbname=$databaseUrl"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryDump -PathType Leaf)) {
      throw "pg_dump refresh failed with exit code $LASTEXITCODE"
    }
    & $pgRestore '--list' $temporaryDump | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "pg_restore catalog validation failed: $LASTEXITCODE" }
    Move-Item -LiteralPath $temporaryDump -Destination $dumpPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryDump -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryDump -Force
    }
  }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not @($manifest.PSObject.Properties.Name).Contains('sourceQuiescenceConfirmed')) {
  $manifest | Add-Member -NotePropertyName sourceQuiescenceConfirmed `
    -NotePropertyValue $false -Force
}
$criticalPaths = [Collections.Generic.List[string]]::new()
foreach ($entry in @($manifest.criticalFiles)) {
  $criticalPaths.Add(([string]$entry.path).Replace('\', '/'))
}
foreach ($requiredCriticalPath in @(
  'migration-tools/Apply-PddDatabaseMigrations.ps1',
  'migration-tools/MigrationCatalog.ps1',
  'payload/app/apps/worker/src/main.mjs',
  'payload/app/apps/worker/src/dynamic-supervisor.mjs',
  'payload/app/apps/worker/src/postgres-playwright-runner.mjs',
  'payload/app/scripts/dingtalk-dispatcher.mjs',
  'payload/app/apps/web/src/components/WorkOrderDrawer.jsx',
  'payload/app/workflow-runtime.mjs',
  'payload/app/packages/adapters/src/pdd/order-remark.mjs',
  'payload/app/packages/adapters/src/pdd/render-wait.mjs',
  'payload/app/packages/adapters/src/postgres/index.mjs',
  'payload/app/infra/db/migration-catalog.json',
  'payload/app/infra/db/migrations/166_requery_api_created_tms_rows.sql',
  'payload/app/infra/db/migrations/167_recover_pdd_order_remark_reload_abort.sql',
  'payload/app/infra/db/migrations/168_recover_prefilled_reply_submit_form.sql',
  'payload/app/infra/db/migrations/169_recover_pdd_evidence_order_parsing.sql',
  'payload/app/infra/db/migrations/170_recover_stale_pdd_evidence_detail.sql',
  'payload/app/infra/db/migrations/171_recover_unique_existing_tms_warehouse.sql',
  'payload/app/infra/db/migrations/172_recover_flattened_oms_warehouse_text.sql',
  'payload/app/infra/db/migrations/173_reconcile_return_refund_schedule_and_orphans.sql',
  'payload/app/infra/db/migrations/206_resume_consumer_negotiation_followups_without_tms_replay.sql',
  'payload/app/infra/db/migrations/207_finalize_confirmed_consumer_negotiation_followups.sql',
  'payload/app/infra/db/migrations/208_finalize_already_confirmed_consumer_negotiation_followups.sql',
  'payload/app/infra/db/migrations/209_recover_consumer_negotiation_followup_race.sql',
  'payload/app/infra/db/migrations/210_recover_terminal_oms_manual_allocation_pauses.sql',
  'payload/app/infra/db/migrations/211_resume_resolved_verification_backoffs.sql',
  'payload/app/infra/db/migrations/212_recover_consumer_negotiation_missing_evidence_disposition.sql',
  'payload/app/infra/db/migrations/213_recover_stale_ordinary_detail_render_loop.sql',
  'payload/app/infra/db/migrations/214_recover_oms_reissue_render_pauses.sql',
  'payload/app/infra/db/migrations/215_retry_oms_reissue_with_dom_diagnostics.sql',
  'payload/app/infra/db/migrations/216_reconcile_orphaned_tms_create_effects.sql',
  'payload/app/infra/db/migrations/217_add_reverse_logistics_signed_refund.sql',
  'payload/app/infra/db/migrations/218_enforce_oms_warehouse_scope.sql',
  'payload/app/infra/db/migrations/219_expand_oms_warehouse_scope.sql',
  'payload/app/infra/db/migrations/220_recover_safe_pdd_detail_reload_and_rebind.sql',
  'payload/app/infra/db/migrations/221_recover_sparse_pdd_detail_and_render_pauses.sql',
  'payload/app/infra/db/migrations/222_backfill_current_pdd_upload_authorization_notifications.sql',
  'payload/app/infra/db/migrations/223_reclassify_automatic_return_refund_terminal_scans.sql',
  'payload/app/scripts/install-native-windows-tasks.ps1',
  'payload/app/scripts/run-native-windows-component.ps1',
  'payload/app/scripts/restore-native-worker-windows.ps1',
  'payload/app/scripts/return-refund-api-self-test.mjs',
  'payload/app/scripts/windows-local-browser-self-test.mjs',
  'payload/app/scripts/worker-runtime-self-test.mjs'
)) {
  if (-not $criticalPaths.Contains($requiredCriticalPath)) {
    $criticalPaths.Add($requiredCriticalPath)
  }
}
$packageManifest = Get-Content -LiteralPath (Join-Path $payloadApp 'package.json') -Raw -Encoding UTF8 |
  ConvertFrom-Json
$directNodeModules = @(
  @($packageManifest.dependencies.PSObject.Properties.Name)
  @($packageManifest.devDependencies.PSObject.Properties.Name)
) | Sort-Object -Unique
foreach ($moduleName in $directNodeModules) {
  $dependencyPath = "payload/app/node_modules/$moduleName/package.json"
  if (-not $criticalPaths.Contains($dependencyPath)) {
    $criticalPaths.Add($dependencyPath)
  }
}
foreach ($migration in @(Get-ChildItem -LiteralPath $payloadMigrationRoot -File -Filter '*.sql' `
    -ErrorAction SilentlyContinue)) {
  $relativeMigration = (Get-PddRelativePath -Root $bundle -Path $migration.FullName).Replace('\', '/')
  if (-not $criticalPaths.Contains($relativeMigration)) {
    $criticalPaths.Add($relativeMigration)
  }
}
$webDistRoot = Join-Path $payloadApp 'apps\web\dist'
foreach ($webAsset in @(Get-ChildItem -LiteralPath $webDistRoot -File -Recurse -ErrorAction SilentlyContinue)) {
  $relativeWebAsset = (Get-PddRelativePath -Root $bundle -Path $webAsset.FullName).Replace('\', '/')
  if (-not $criticalPaths.Contains($relativeWebAsset)) {
    $criticalPaths.Add($relativeWebAsset)
  }
}

$criticalFiles = [Collections.Generic.List[object]]::new()
foreach ($relativePath in $criticalPaths) {
  $nativeRelative = $relativePath.Replace('/', '\')
  $path = Get-FullPath (Join-Path $bundle $nativeRelative)
  Assert-ChildPath -Root $bundle -Path $path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Critical bundle file is missing after refresh: $relativePath"
  }
  $file = Get-Item -LiteralPath $path
  $criticalFiles.Add([ordered]@{
    path = $relativePath
    bytes = [int64]$file.Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  })
}

$refreshedAt = [DateTimeOffset]::Now.ToString('o')
$manifest.payload = Get-DirectorySummary (Join-Path $bundle 'payload')
$manifest.database = Get-DirectorySummary (Join-Path $bundle 'database')
$manifest.criticalFiles = @($criticalFiles)
$manifest | Add-Member -NotePropertyName migrationCatalog `
  -NotePropertyValue $payloadMigrationCatalog -Force
$manifest | Add-Member -NotePropertyName materializedNodeModules `
  -NotePropertyValue @($materializedNodeModules) -Force
if ($SourceGitCommit) {
  if ($SourceGitCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'SourceGitCommit must be a full 40-character Git commit hash.'
  }
  $manifest.sourceGitCommit = $SourceGitCommit.ToLowerInvariant()
}
$manifest | Add-Member -NotePropertyName payloadRefreshedAt -NotePropertyValue $refreshedAt -Force
if ($RefreshDatabaseDump) {
  $manifest | Add-Member -NotePropertyName databaseRefreshedAt `
    -NotePropertyValue $refreshedAt -Force
}
[IO.File]::WriteAllText(
  $manifestPath,
  ($manifest | ConvertTo-Json -Depth 10),
  [Text.UTF8Encoding]::new($false)
)
$markerName = if ([bool]$manifest.sourceQuiescenceConfirmed) {
  'MIGRATION_READY.txt'
} else {
  'MIGRATION_PREVIEW.txt'
}
$oppositeMarker = Join-Path $bundle $(if ($markerName -eq 'MIGRATION_READY.txt') {
  'MIGRATION_PREVIEW.txt'
} else {
  'MIGRATION_READY.txt'
})
if (Test-Path -LiteralPath $oppositeMarker -PathType Leaf) {
  Remove-Item -LiteralPath $oppositeMarker -Force
}
[IO.File]::WriteAllText(
  (Join-Path $bundle $markerName),
  "PDD server migration bundle payload refreshed at $refreshedAt; sourceQuiescenceConfirmed=$([bool]$manifest.sourceQuiescenceConfirmed).`r`n",
  [Text.UTF8Encoding]::new($false)
)

$manifest | ConvertTo-Json -Depth 10
