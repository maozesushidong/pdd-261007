$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $env:TEMP ("pdd-server-migration-self-test-{0}" -f [guid]::NewGuid())
$source = Join-Path $testRoot 'source'
$bundle = Join-Path $testRoot 'bundle'
$restored = Join-Path $testRoot 'restored'
$overlay = Join-Path $testRoot 'overlay'
$expectedMigrations = Join-Path $testRoot 'expected-migrations'
$staleBundle = Join-Path $testRoot 'stale-source-bundle'
$tamperedBundle = Join-Path $testRoot 'tampered-bundle'
$tamperedRestore = Join-Path $testRoot 'tampered-restore'

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeSource = if ($nodeCommand) { $nodeCommand.Source } else { 'C:\pdd-native\runtime\node\node.exe' }
if (-not (Test-Path -LiteralPath $nodeSource -PathType Leaf)) {
  throw 'A working Node.js executable is required for the migration dependency self-test.'
}

function Write-TestFile([string]$Path, [string]$Value) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

try {
  Write-TestFile (Join-Path $source 'app\.env.native') @"
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/workorders
WORKFLOW_DATA_ROOT=$source\data\workflow
WORKFLOW_BROWSER_EXECUTABLE_PATH=$source\runtime\chrome-for-testing\chrome.exe
"@
  Write-TestFile (Join-Path $source 'app\package.json') `
    '{"name":"migration-test","dependencies":{"fixture-package":"1.0.0","@fixture/scoped-package":"1.0.0"}}'
  $fixturePackageTarget = Join-Path $source `
    'app\node_modules\.pnpm\fixture-package@1.0.0\node_modules\fixture-package'
  Write-TestFile (Join-Path $fixturePackageTarget 'package.json') `
    '{"name":"fixture-package","version":"1.0.0","type":"module","exports":"./index.mjs"}'
  Write-TestFile (Join-Path $fixturePackageTarget 'index.mjs') 'export const ready = true;'
  $scopedPackageTarget = Join-Path $source `
    'app\node_modules\.pnpm\@fixture+scoped-package@1.0.0\node_modules\@fixture\scoped-package'
  Write-TestFile (Join-Path $scopedPackageTarget 'package.json') `
    '{"name":"@fixture/scoped-package","version":"1.0.0","type":"module","exports":"./index.mjs"}'
  Write-TestFile (Join-Path $scopedPackageTarget 'index.mjs') 'export const ready = true;'
  New-Item -ItemType SymbolicLink `
    -Path (Join-Path $source 'app\node_modules\fixture-package') `
    -Target $fixturePackageTarget | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $source 'app\node_modules\@fixture') -Force |
    Out-Null
  New-Item -ItemType SymbolicLink `
    -Path (Join-Path $source 'app\node_modules\@fixture\scoped-package') `
    -Target $scopedPackageTarget |
    Out-Null
  Write-TestFile (Join-Path $source 'app\workflow.mjs') 'export const source = true;'
  Write-TestFile (Join-Path $source 'app\workflow-runtime.mjs') 'export const runtime = true;'
  Write-TestFile (Join-Path $source 'app\apps\worker\src\dynamic-supervisor.mjs') `
    'export const supervisor = true;'
  Write-TestFile (Join-Path $source 'app\apps\worker\src\postgres-playwright-runner.mjs') `
    'export const runner = true;'
  Write-TestFile (Join-Path $source 'app\apps\web\src\components\WorkOrderDrawer.jsx') `
    'export default function WorkOrderDrawer() { return null; }'
  Write-TestFile (Join-Path $source 'app\apps\web\dist\index.html') `
    '<script type="module" src="/assets/index-test.js"></script>'
  Write-TestFile (Join-Path $source 'app\apps\web\dist\assets\index-test.js') `
    'console.log("migration-test");'
  Write-TestFile (Join-Path $source 'app\packages\adapters\src\pdd\ordinary-work-orders.mjs') `
    'export const ordinary = true;'
  Write-TestFile (Join-Path $source 'app\packages\adapters\src\pdd\order-remark.mjs') `
    'export const remark = true;'
  Write-TestFile (Join-Path $source 'app\packages\adapters\src\pdd\render-wait.mjs') `
    'export const renderWait = true;'
  Write-TestFile (Join-Path $source 'app\packages\adapters\src\pdd\return-refund.mjs') `
    'export const refund = true;'
  Write-TestFile (Join-Path $source 'app\packages\adapters\src\postgres\index.mjs') `
    'export const postgres = true;'
  Write-TestFile (Join-Path $source 'app\scripts\ordinary-work-order-instance-self-test.mjs') `
    'export const ordinaryInstanceSelfTest = true;'
  Write-TestFile (Join-Path $source 'app\scripts\install-bundled-native-extension.ps1') `
    "`$extensionVersion = '4.0.1.237'"
  Write-TestFile (Join-Path $source 'app\scripts\install-native-windows-tasks.ps1') `
    "Write-Output 'install tasks'"
  Write-TestFile (Join-Path $source 'app\scripts\restore-native-worker-windows.ps1') `
    "Write-Output 'restore windows'"
  Write-TestFile (Join-Path $source 'app\scripts\return-refund-api-self-test.mjs') `
    'export const returnRefundApiTest = true;'
  foreach ($migration in @(
    '162_add_delivered_not_received_and_consumer_refusal.sql',
    '163_recover_deterministic_ordinary_pauses.sql',
    '164_restore_owner_deleted_return_refund_identity.sql',
    '165_recover_api_created_tms_row_verification.sql',
    '166_requery_api_created_tms_rows.sql',
    '167_recover_pdd_order_remark_reload_abort.sql',
    '168_recover_prefilled_reply_submit_form.sql',
    '169_recover_pdd_evidence_order_parsing.sql',
    '170_recover_stale_pdd_evidence_detail.sql',
    '171_recover_unique_existing_tms_warehouse.sql',
    '172_recover_flattened_oms_warehouse_text.sql',
    '173_reconcile_return_refund_schedule_and_orphans.sql',
    '206_resume_consumer_negotiation_followups_without_tms_replay.sql',
    '207_finalize_confirmed_consumer_negotiation_followups.sql',
    '208_finalize_already_confirmed_consumer_negotiation_followups.sql',
    '209_recover_consumer_negotiation_followup_race.sql',
    '210_recover_terminal_oms_manual_allocation_pauses.sql',
    '211_resume_resolved_verification_backoffs.sql',
    '212_recover_consumer_negotiation_missing_evidence_disposition.sql',
    '213_recover_stale_ordinary_detail_render_loop.sql',
    '214_recover_oms_reissue_render_pauses.sql',
    '215_retry_oms_reissue_with_dom_diagnostics.sql',
    '216_reconcile_orphaned_tms_create_effects.sql'
  )) {
    Write-TestFile (Join-Path $source "app\infra\db\migrations\$migration") '-- test'
  }
  New-Item -ItemType Directory -Path $expectedMigrations -Force | Out-Null
  Copy-Item -Path (Join-Path $source 'app\infra\db\migrations\*.sql') `
    -Destination $expectedMigrations -Force
  Write-TestFile (Join-Path $source `
    'extensions\permanent\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json') `
    '{"version":"4.0.1.246"}'
  Write-TestFile (Join-Path $source `
    'app\vendor\chrome-extension\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json') `
    '{"version":"4.0.1.246"}'
  New-Item -ItemType Directory -Path (Join-Path $source 'runtime\node') -Force | Out-Null
  Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $source 'runtime\node\node.exe') -Force
  Write-TestFile (Join-Path $source 'data\workflow\shops\shop-a\state\progress.json') `
    '{"step":"ready"}'
  Write-TestFile (Join-Path $source 'data\workflow\shops\shop-a\diagnostics\evidence.txt') `
    'evidence'
  Write-TestFile (Join-Path $source 'data\workflow\shops\shop-a\browser-profile\Cookies') `
    'login-state'
  Write-TestFile (Join-Path $source 'data\workflow\shops\shop-a\auth\pdd.json') `
    'login-state'
  Write-TestFile (Join-Path $source 'data\workflow\shops\shop-a\locks\worker.lock') `
    'stale-lock'
  Write-TestFile (Join-Path $source 'data\postgres16-final\PG_VERSION') '16'
  Write-TestFile (Join-Path $overlay 'workflow.mjs') 'export const overlay = true;'
  Write-TestFile (Join-Path $overlay 'scripts\install-bundled-native-extension.ps1') `
    "`$extensionVersion = '4.0.1.246'"
  Write-TestFile (Join-Path $overlay 'scripts\ordinary-latency-gate.mjs') `
    'export const latencyGate = true;'

  & (Join-Path $PSScriptRoot 'Export-PddServerMigration.ps1') `
    -SourceInstallRoot $source -DestinationRoot $bundle -PatchOverlayRoot $overlay `
    -ExpectedMigrationRoot $expectedMigrations `
    -ConfirmSourceQuiesced `
    -SkipDatabaseDump -SkipHistoricalArchives -SkipExternalComponents | Out-Null

  if (-not (Test-Path -LiteralPath (Join-Path $bundle `
      'payload\data\workflow\shops\shop-a\state\progress.json'))) {
    throw 'Business state was not exported.'
  }
  if (Test-Path -LiteralPath (Join-Path $bundle `
      'payload\data\workflow\shops\shop-a\browser-profile')) {
    throw 'Browser profile must be excluded.'
  }
  if (Test-Path -LiteralPath (Join-Path $bundle `
      'payload\data\workflow\shops\shop-a\auth')) {
    throw 'Authentication cache must be excluded.'
  }
  if (Test-Path -LiteralPath (Join-Path $bundle 'payload\data\postgres16-final')) {
    throw 'The live PostgreSQL physical cluster must be excluded.'
  }
  if ((Get-Content -LiteralPath (Join-Path $bundle 'payload\app\workflow.mjs') -Raw) `
      -notmatch 'overlay') {
    throw 'Patch overlay was not applied.'
  }
  $bundledPluginInstaller = Get-Content -LiteralPath (Join-Path $bundle `
    'payload\app\scripts\install-bundled-native-extension.ps1') -Raw
  if ($bundledPluginInstaller -notmatch '4\.0\.1\.246' -or
      $bundledPluginInstaller -match '4\.0\.1\.237') {
    throw 'Patch overlay did not pin the bundled plugin installer to 4.0.1.246.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $bundle `
      'migration-tools\SERVER-MIGRATION-RUNBOOK-ZH.md') -PathType Leaf)) {
    throw 'Server migration runbook was not exported.'
  }
  foreach ($modulePath in @(
    'payload\app\node_modules\fixture-package\package.json',
    'payload\app\node_modules\@fixture\scoped-package\package.json'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $bundle $modulePath) -PathType Leaf)) {
      throw "Direct node module was not materialized: $modulePath"
    }
  }
  $bundleManifest = Get-Content -LiteralPath (Join-Path $bundle 'migration-manifest.json') `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($bundleManifest.materializedNodeModules).Count -ne 2 -or
      -not @($bundleManifest.materializedNodeModules).Contains('fixture-package') -or
      -not @($bundleManifest.materializedNodeModules).Contains('@fixture/scoped-package')) {
    throw 'Migration manifest does not list every materialized direct node module.'
  }
  $expectedMigrationFiles = @(Get-ChildItem -LiteralPath $expectedMigrations -File -Filter '*.sql' |
    Sort-Object Name)
  if ([int]$bundleManifest.migrationCatalog.migrationCount -ne $expectedMigrationFiles.Count -or
      [string]$bundleManifest.migrationCatalog.latestMigration -ne $expectedMigrationFiles[-1].Name) {
    throw 'Migration manifest does not describe the complete expected migration set.'
  }

  $temporarilyMissingMigration = Join-Path $source `
    'app\infra\db\migrations\173_reconcile_return_refund_schedule_and_orphans.sql'
  $missingMigrationBackup = Join-Path $testRoot '173_reconcile_return_refund_schedule_and_orphans.sql'
  Move-Item -LiteralPath $temporarilyMissingMigration -Destination $missingMigrationBackup
  $staleSourceRejected = $false
  try {
    & (Join-Path $PSScriptRoot 'Export-PddServerMigration.ps1') `
      -SourceInstallRoot $source -DestinationRoot $staleBundle -PatchOverlayRoot $overlay `
      -ExpectedMigrationRoot $expectedMigrations `
      -ConfirmSourceQuiesced `
      -SkipDatabaseDump -SkipHistoricalArchives -SkipExternalComponents | Out-Null
  } catch {
    $staleSourceRejected = $_.Exception.Message -like '*required migration set*'
  } finally {
    Move-Item -LiteralPath $missingMigrationBackup -Destination $temporarilyMissingMigration -Force
  }
  if (-not $staleSourceRejected) {
    throw 'Exporter accepted a source installation with a required migration missing.'
  }
  $bundledMigrationApply = Get-Content -LiteralPath (Join-Path $bundle `
    'migration-tools\Apply-PddDatabaseMigrations.ps1') -Raw
  if ($bundledMigrationApply -notmatch 'missingAfter' -or
      $bundledMigrationApply -notmatch 'Database migration ledger is incomplete after apply' -or
      $bundledMigrationApply -notmatch 'Register-AppliedMigrationVersion' -or
      $bundledMigrationApply -notmatch 'return\s+,\$versions') {
    throw 'Bundled migration apply tool does not verify the complete migration ledger.'
  }

  & (Join-Path $PSScriptRoot 'Test-PddServerMigration.ps1') -BundleRoot $bundle | Out-Null
  & (Join-Path $PSScriptRoot 'Restore-PddServerMigration.ps1') `
    -BundleRoot $bundle -InstallRoot $restored | Out-Null

  Copy-Item -LiteralPath $bundle -Destination $tamperedBundle -Recurse
  $removedMigrationName = '173_reconcile_return_refund_schedule_and_orphans.sql'
  Remove-Item -LiteralPath (Join-Path $tamperedBundle `
      "payload\app\infra\db\migrations\$removedMigrationName") -Force
  $tamperedManifestPath = Join-Path $tamperedBundle 'migration-manifest.json'
  $tamperedManifest = Get-Content -LiteralPath $tamperedManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $removedCriticalPath = "payload/app/infra/db/migrations/$removedMigrationName"
  $tamperedManifest.criticalFiles = @($tamperedManifest.criticalFiles | Where-Object {
    [string]$_.path -ne $removedCriticalPath
  })
  [IO.File]::WriteAllText($tamperedManifestPath, ($tamperedManifest | ConvertTo-Json -Depth 10),
    [Text.UTF8Encoding]::new($false))
  $powershell = (Get-Command powershell.exe -ErrorAction Stop | Select-Object -First 1).Source
  & $powershell -NoProfile -ExecutionPolicy Bypass -File `
    (Join-Path $PSScriptRoot 'Test-PddServerMigration.ps1') -BundleRoot $tamperedBundle *> $null
  if ($LASTEXITCODE -eq 0) {
    throw 'Bundle validation accepted a migration omitted from both payload and criticalFiles.'
  }
  $tamperedRestoreRejected = $false
  try {
    & (Join-Path $PSScriptRoot 'Restore-PddServerMigration.ps1') `
      -BundleRoot $tamperedBundle -InstallRoot $tamperedRestore | Out-Null
  } catch {
    $tamperedRestoreRejected = $_.Exception.Message -like '*migration catalog*'
  }
  if (-not $tamperedRestoreRejected -or (Test-Path -LiteralPath $tamperedRestore)) {
    throw 'Restore did not reject the incomplete migration set before creating the installation.'
  }

  $restoredEnv = Get-Content -LiteralPath (Join-Path $restored 'app\.env.native') -Raw
  if ($restoredEnv -notmatch [regex]::Escape($restored)) {
    throw 'Absolute install paths were not rewritten.'
  }
  if ($restoredEnv -match [regex]::Escape($source)) {
    throw 'Source install path remained in the restored environment.'
  }
  if ((Get-Content -LiteralPath (Join-Path $restored 'app\workflow.mjs') -Raw) `
      -notmatch 'overlay') {
    throw 'Restored code does not contain the overlay.'
  }
  Write-Output 'server migration self-test passed'
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    if ($resolved.StartsWith("$resolvedTemp\", [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
