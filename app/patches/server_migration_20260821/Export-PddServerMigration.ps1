[CmdletBinding()]
param(
  [string]$SourceInstallRoot = 'C:\pdd-native',
  [Parameter(Mandatory)][string]$DestinationRoot,
  [string]$PatchOverlayRoot = '',
  [string]$ExpectedMigrationRoot = '',
  [switch]$IncludeBrowserProfiles,
  [switch]$IncludeGitHistory,
  [switch]$IncludeDevelopmentCaches,
  [switch]$ConfirmSourceQuiesced,
  [switch]$SkipDatabaseDump,
  [switch]$SkipHistoricalArchives,
  [switch]$SkipExternalComponents
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

function Assert-EmptyDestination([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count) {
      throw "Destination must be empty: $Path"
    }
  } else {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Invoke-DirectoryCopy {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination,
    [string[]]$ExcludeDirectories = @(),
    [string[]]$ExcludeFiles = @()
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return $false }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $arguments = @(
    $Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ',
    '/R:2', '/W:2', '/MT:16', '/NP', '/NFL', '/NDL', '/NJH', '/NJS'
  )
  if ($ExcludeDirectories.Count) { $arguments += '/XD'; $arguments += $ExcludeDirectories }
  if ($ExcludeFiles.Count) { $arguments += '/XF'; $arguments += $ExcludeFiles }
  $exitCode = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & robocopy.exe @arguments | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -le 7) { break }
    if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
  }
  if ($exitCode -gt 7) { throw "robocopy failed after 3 attempts ($exitCode): $Source" }
  return $true
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
    Invoke-DirectoryCopy -Source $copySource -Destination $destinationPath | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $destinationPath 'package.json') -PathType Leaf)) {
      throw "Materialized node module is incomplete: $moduleName"
    }
    $materialized.Add($moduleName)
  }
  return @($materialized)
}

function Get-DirectorySummary([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return [ordered]@{ files = 0; bytes = 0 }
  }
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue)
  return [ordered]@{
    files = $files.Count
    bytes = [int64](($files | Measure-Object Length -Sum).Sum)
  }
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

function Add-CriticalFile {
  param(
    [Collections.Generic.List[object]]$List,
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$RelativePath
  )
  $path = Join-Path $BundleRoot $RelativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
  $normalizedRelativePath = $RelativePath.Replace('\', '/')
  if (@($List | Where-Object {
      ([string]$_.path).Equals($normalizedRelativePath, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0) { return }
  $item = Get-Item -LiteralPath $path
  $List.Add([ordered]@{
    path = $normalizedRelativePath
    bytes = [int64]$item.Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  })
}

$sourceRoot = Get-FullPath $SourceInstallRoot
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
  throw "Source installation was not found: $sourceRoot"
}
$sourceApp = Join-Path $sourceRoot 'app'
$sourceMigrationRoot = Join-Path $sourceApp 'infra\db\migrations'
$requiredMigrationRoot = Resolve-PddExpectedMigrationRoot `
  -ExplicitRoot $ExpectedMigrationRoot -ScriptRoot $PSScriptRoot `
  -FallbackRoot $sourceMigrationRoot
Assert-PddMigrationNames -ExpectedRoot $requiredMigrationRoot -ActualRoot $sourceMigrationRoot `
  -Context 'Source installation migration directory' | Out-Null

$destination = Get-FullPath $DestinationRoot
if ($destination.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $destination.StartsWith("$sourceRoot\", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Destination must be outside the source installation.'
}
Assert-EmptyDestination $destination

$sourceEnv = Join-Path $sourceApp '.env.native'
if (-not (Test-Path -LiteralPath $sourceEnv -PathType Leaf)) {
  throw "Native environment file was not found: $sourceEnv"
}
if (-not $PatchOverlayRoot) {
  $PatchOverlayRoot = Join-Path (Split-Path -Parent $PSScriptRoot) `
    '162_new_ordinary_scenarios\overlay'
}
$patchOverlay = if (Test-Path -LiteralPath $PatchOverlayRoot -PathType Container) {
  (Resolve-Path -LiteralPath $PatchOverlayRoot).Path
} else { $null }

$payloadRoot = Join-Path $destination 'payload'
$payloadApp = Join-Path $payloadRoot 'app'
$databaseRoot = Join-Path $destination 'database'
$externalRoot = Join-Path $destination 'external'
$toolsRoot = Join-Path $destination 'migration-tools'
New-Item -ItemType Directory -Force -Path $payloadRoot, $databaseRoot, $externalRoot, $toolsRoot | Out-Null

$appExclusions = [Collections.Generic.List[string]]::new()
if (-not $IncludeGitHistory) { $appExclusions.Add((Join-Path $sourceApp '.git')) }
if (-not $IncludeDevelopmentCaches) {
  foreach ($name in @('.codex', '.agents', 'node_modules-interrupted-20260807')) {
    $appExclusions.Add((Join-Path $sourceApp $name))
  }
}
Invoke-DirectoryCopy -Source $sourceApp -Destination (Join-Path $payloadRoot 'app') `
  -ExcludeDirectories @($appExclusions) | Out-Null
$materializedNodeModules = @(Copy-MaterializedDirectNodeModules `
  -SourceApp $sourceApp -DestinationApp $payloadApp)

foreach ($name in @('runtime', 'extensions', 'logs')) {
  Invoke-DirectoryCopy -Source (Join-Path $sourceRoot $name) `
    -Destination (Join-Path $payloadRoot $name) | Out-Null
}
if (-not $SkipHistoricalArchives) {
  foreach ($name in @('backup', 'backups', 'downloads')) {
    Invoke-DirectoryCopy -Source (Join-Path $sourceRoot $name) `
      -Destination (Join-Path $payloadRoot $name) | Out-Null
  }
}

$sourceData = Join-Path $sourceRoot 'data'
$dataExclusions = [Collections.Generic.List[string]]::new()
$dataExclusions.Add((Join-Path $sourceData 'postgres16-final'))
if (-not $IncludeBrowserProfiles) {
  $dataExclusions.Add((Join-Path $sourceData 'console-browser-profile'))
  foreach ($directory in @(Get-ChildItem -LiteralPath $sourceData -Recurse -Directory -ErrorAction SilentlyContinue)) {
    if ($directory.Name -in @('browser-profile', 'auth', 'locks', 'tmp') -or
        $directory.Name -match '(?:^|-)test(?:-|$)|self-test') {
      $dataExclusions.Add($directory.FullName)
    }
  }
}
Invoke-DirectoryCopy -Source $sourceData -Destination (Join-Path $payloadRoot 'data') `
  -ExcludeDirectories @($dataExclusions) | Out-Null

if ($patchOverlay) {
  Invoke-DirectoryCopy -Source $patchOverlay -Destination (Join-Path $payloadRoot 'app') | Out-Null
}

$payloadMigrationRoot = Join-Path $payloadApp 'infra\db\migrations'
Assert-PddMigrationNames -ExpectedRoot $requiredMigrationRoot -ActualRoot $payloadMigrationRoot `
  -Context 'Exported payload migration directory' | Out-Null
$payloadMigrationCatalog = Write-PddMigrationCatalog -MigrationRoot $payloadMigrationRoot `
  -Destination (Join-Path $payloadApp 'infra\db\migration-catalog.json')

$requiredPluginFiles = @(
  'app\scripts\install-bundled-native-extension.ps1',
  'app\vendor\chrome-extension\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json',
  'extensions\permanent\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json'
)
foreach ($relative in $requiredPluginFiles) {
  $path = Join-Path $payloadRoot $relative
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required plugin migration file is missing: $relative"
  }
}
foreach ($relative in $requiredPluginFiles | Where-Object { $_.EndsWith('manifest.json') }) {
  $manifestPath = Join-Path $payloadRoot $relative
  $pluginVersion = [string](Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json).version
  if ($pluginVersion -ne '4.0.1.246') {
    throw "Plugin version mismatch in ${relative}: $pluginVersion"
  }
}
$pluginInstallerPath = Join-Path $payloadRoot 'app\scripts\install-bundled-native-extension.ps1'
$pluginInstallerSource = Get-Content -LiteralPath $pluginInstallerPath -Raw -Encoding UTF8
if (-not $pluginInstallerSource.Contains("`$extensionVersion = '4.0.1.246'")) {
  throw 'Bundled plugin installer is not pinned to version 4.0.1.246.'
}

if (-not $SkipDatabaseDump) {
  $databaseUrl = Get-EnvironmentValue -EnvFile $sourceEnv -Name 'DATABASE_URL'
  if (-not $databaseUrl) { throw 'DATABASE_URL is missing from .env.native.' }
  $pgDump = Join-Path $sourceRoot 'runtime\postgres\bin\pg_dump.exe'
  if (-not (Test-Path -LiteralPath $pgDump -PathType Leaf)) { throw "pg_dump is missing: $pgDump" }
  $pgRestore = Join-Path $sourceRoot 'runtime\postgres\bin\pg_restore.exe'
  if (-not (Test-Path -LiteralPath $pgRestore -PathType Leaf)) { throw "pg_restore is missing: $pgRestore" }
  $dumpPath = Join-Path $databaseRoot 'postgres-workorders.dump'
  & $pgDump '--format=custom' '--compress=6' '--no-owner' '--no-privileges' `
    "--file=$dumpPath" "--dbname=$databaseUrl"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $dumpPath -PathType Leaf)) {
    throw "pg_dump failed with exit code $LASTEXITCODE"
  }
  & $pgRestore '--list' $dumpPath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "pg_restore catalog validation failed with exit code $LASTEXITCODE"
  }
}

if (-not $SkipExternalComponents) {
  $pddCoreRoot = 'C:\Program Files (x86)\PddCoreService'
  Invoke-DirectoryCopy -Source $pddCoreRoot `
    -Destination (Join-Path $externalRoot 'PddCoreService') | Out-Null
  $iirpaRoot = Join-Path $env:LOCALAPPDATA 'IIRPA\RPAChromeExtension'
  Invoke-DirectoryCopy -Source $iirpaRoot `
    -Destination (Join-Path $externalRoot 'IIRPA\RPAChromeExtension') | Out-Null

  foreach ($relative in @(
    'IIRPA\RPAChromeExtension\manifest.json',
    'IIRPA\RPAChromeExtension\II.RPA.NativeMessagingHost.exe',
    'PddCoreService\PddCoreService.exe'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $externalRoot $relative) -PathType Leaf)) {
      throw "Required plugin runtime component is missing: $relative"
    }
  }
}
Copy-Item -Path (Join-Path $PSScriptRoot '*.ps1') -Destination $toolsRoot -Force
Copy-Item -Path (Join-Path $PSScriptRoot '*.md') -Destination $toolsRoot -Force

foreach ($requiredCurrentFix in @(
  'payload\app\apps\worker\src\dynamic-supervisor.mjs',
  'payload\app\apps\worker\src\postgres-playwright-runner.mjs',
  'payload\app\packages\adapters\src\pdd\render-wait.mjs',
  'payload\app\packages\adapters\src\postgres\index.mjs',
  'payload\app\infra\db\migration-catalog.json'
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $destination $requiredCurrentFix) -PathType Leaf)) {
    throw "Required current automation fix is missing from the export: $requiredCurrentFix"
  }
}

$sourceCommit = $null
try { $sourceCommit = (& git.exe -C $sourceApp rev-parse HEAD 2>$null).Trim() } catch { }
$criticalFiles = [Collections.Generic.List[object]]::new()
foreach ($relative in @(
  'payload\app\.env.native',
  'payload\app\package.json',
  'payload\app\workflow.mjs',
  'payload\app\workflow-runtime.mjs',
  'payload\app\apps\api\src\data-backend.mjs',
  'payload\app\apps\api\src\main.mjs',
  'payload\app\apps\api\src\worker-event-identity.mjs',
  'payload\app\scripts\dingtalk-dispatcher.mjs',
  'payload\app\apps\worker\src\main.mjs',
  'payload\app\apps\worker\src\dynamic-supervisor.mjs',
  'payload\app\apps\worker\src\postgres-playwright-runner.mjs',
  'payload\app\apps\web\src\components\WorkOrderDrawer.jsx',
  'payload\app\packages\adapters\src\pdd\ordinary-work-orders.mjs',
  'payload\app\packages\adapters\src\pdd\order-remark.mjs',
  'payload\app\packages\adapters\src\pdd\render-wait.mjs',
  'payload\app\packages\adapters\src\pdd\return-refund.mjs',
  'payload\app\packages\adapters\src\postgres\index.mjs',
  'payload\app\infra\db\migration-catalog.json',
  'migration-tools\MigrationCatalog.ps1',
  'payload\app\infra\db\migrations\162_add_delivered_not_received_and_consumer_refusal.sql',
  'payload\app\infra\db\migrations\163_recover_deterministic_ordinary_pauses.sql',
  'payload\app\infra\db\migrations\164_restore_owner_deleted_return_refund_identity.sql',
  'payload\app\infra\db\migrations\165_recover_api_created_tms_row_verification.sql',
  'payload\app\infra\db\migrations\166_requery_api_created_tms_rows.sql',
  'payload\app\infra\db\migrations\167_recover_pdd_order_remark_reload_abort.sql',
  'payload\app\infra\db\migrations\168_recover_prefilled_reply_submit_form.sql',
  'payload\app\infra\db\migrations\169_recover_pdd_evidence_order_parsing.sql',
  'payload\app\infra\db\migrations\170_recover_stale_pdd_evidence_detail.sql',
  'payload\app\infra\db\migrations\171_recover_unique_existing_tms_warehouse.sql',
  'payload\app\infra\db\migrations\172_recover_flattened_oms_warehouse_text.sql',
  'payload\app\infra\db\migrations\206_resume_consumer_negotiation_followups_without_tms_replay.sql',
  'payload\app\infra\db\migrations\207_finalize_confirmed_consumer_negotiation_followups.sql',
  'payload\app\infra\db\migrations\208_finalize_already_confirmed_consumer_negotiation_followups.sql',
  'payload\app\infra\db\migrations\209_recover_consumer_negotiation_followup_race.sql',
  'payload\app\infra\db\migrations\210_recover_terminal_oms_manual_allocation_pauses.sql',
  'payload\app\infra\db\migrations\211_resume_resolved_verification_backoffs.sql',
  'payload\app\infra\db\migrations\212_recover_consumer_negotiation_missing_evidence_disposition.sql',
  'payload\app\infra\db\migrations\213_recover_stale_ordinary_detail_render_loop.sql',
  'payload\app\infra\db\migrations\214_recover_oms_reissue_render_pauses.sql',
  'payload\app\infra\db\migrations\215_retry_oms_reissue_with_dom_diagnostics.sql',
  'payload\app\infra\db\migrations\216_reconcile_orphaned_tms_create_effects.sql',
  'payload\app\infra\db\migrations\222_backfill_current_pdd_upload_authorization_notifications.sql',
  'payload\app\scripts\install-bundled-native-extension.ps1',
  'payload\app\scripts\install-native-windows-tasks.ps1',
  'payload\app\scripts\ordinary-latency-gate.mjs',
  'payload\app\scripts\ordinary-work-order-instance-self-test.mjs',
  'payload\app\scripts\run-native-windows-component.ps1',
  'payload\app\scripts\restore-native-worker-windows.ps1',
  'payload\app\scripts\return-refund-api-self-test.mjs',
  'payload\app\scripts\windows-local-browser-self-test.mjs',
  'payload\app\scripts\worker-runtime-self-test.mjs',
  'payload\app\vendor\chrome-extension\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json',
  'payload\extensions\permanent\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json',
  'external\IIRPA\RPAChromeExtension\manifest.json',
  'external\IIRPA\RPAChromeExtension\II.RPA.NativeMessagingHost.exe',
  'external\PddCoreService\PddCoreService.exe',
  'database\postgres-workorders.dump'
)) {
  Add-CriticalFile -List $criticalFiles -BundleRoot $destination -RelativePath $relative
}
$packageManifest = Get-Content -LiteralPath (Join-Path $payloadApp 'package.json') -Raw -Encoding UTF8 |
  ConvertFrom-Json
$directNodeModules = @(
  @($packageManifest.dependencies.PSObject.Properties.Name)
  @($packageManifest.devDependencies.PSObject.Properties.Name)
) | Sort-Object -Unique
foreach ($moduleName in $directNodeModules) {
  Add-CriticalFile -List $criticalFiles -BundleRoot $destination `
    -RelativePath ("payload\app\node_modules\$moduleName\package.json")
}
foreach ($migration in @(Get-ChildItem -LiteralPath $payloadMigrationRoot -File -Filter '*.sql' `
    -ErrorAction SilentlyContinue)) {
  $migrationRelative = Get-PddRelativePath -Root $destination -Path $migration.FullName
  Add-CriticalFile -List $criticalFiles -BundleRoot $destination -RelativePath $migrationRelative
}
foreach ($webAsset in @(Get-ChildItem -LiteralPath (Join-Path $payloadApp 'apps\web\dist') `
    -File -Recurse -ErrorAction SilentlyContinue)) {
  $webAssetRelative = Get-PddRelativePath -Root $destination -Path $webAsset.FullName
  Add-CriticalFile -List $criticalFiles -BundleRoot $destination -RelativePath $webAssetRelative
}

$manifest = [ordered]@{
  formatVersion = 1
  exportedAt = [DateTimeOffset]::Now.ToString('o')
  sourceInstallRoot = $sourceRoot
  sourceGitCommit = $sourceCommit
  browserProfilesIncluded = [bool]$IncludeBrowserProfiles
  databaseDumpIncluded = -not [bool]$SkipDatabaseDump
  externalComponentsIncluded = -not [bool]$SkipExternalComponents
  historicalArchivesIncluded = -not [bool]$SkipHistoricalArchives
  sourceQuiescenceConfirmed = [bool]$ConfirmSourceQuiesced
  patchOverlayApplied = [bool]$patchOverlay
  materializedNodeModules = @($materializedNodeModules)
  migrationCatalog = $payloadMigrationCatalog
  payload = Get-DirectorySummary $payloadRoot
  database = Get-DirectorySummary $databaseRoot
  external = Get-DirectorySummary $externalRoot
  criticalFiles = @($criticalFiles)
}
[IO.File]::WriteAllText(
  (Join-Path $destination 'migration-manifest.json'),
  ($manifest | ConvertTo-Json -Depth 8),
  [Text.UTF8Encoding]::new($false)
)
$readinessMarker = if ($ConfirmSourceQuiesced) { 'MIGRATION_READY.txt' } else { 'MIGRATION_PREVIEW.txt' }
$readinessText = if ($ConfirmSourceQuiesced) {
  "PDD server migration bundle ready at $([DateTimeOffset]::Now.ToString('o'))`r`n"
} else {
  "PDD server migration preview exported from a source that was not confirmed quiesced. Do not use for final cutover.`r`n"
}
[IO.File]::WriteAllText((Join-Path $destination $readinessMarker), $readinessText,
  [Text.UTF8Encoding]::new($false))

$manifest | ConvertTo-Json -Depth 8
