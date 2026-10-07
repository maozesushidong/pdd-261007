[CmdletBinding()]
param(
  [string]$BundleRoot = '',
  [string]$InstallRoot = ''
)

$ErrorActionPreference = 'Stop'
$migrationCatalogTools = Join-Path $PSScriptRoot 'MigrationCatalog.ps1'
if (-not (Test-Path -LiteralPath $migrationCatalogTools -PathType Leaf)) {
  throw "Migration catalog tools are missing: $migrationCatalogTools"
}
. $migrationCatalogTools

function Test-CriticalFiles([string]$Root, $Manifest) {
  $results = [Collections.Generic.List[object]]::new()
  foreach ($entry in @($Manifest.criticalFiles)) {
    $relative = ([string]$entry.path).Replace('/', '\')
    $path = Join-Path $Root $relative
    $exists = Test-Path -LiteralPath $path -PathType Leaf
    $hashMatches = $false
    if ($exists) {
      $hashMatches = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() `
        -eq [string]$entry.sha256
    }
    $results.Add([ordered]@{ path = $relative; exists = $exists; hashMatches = $hashMatches })
  }
  return @($results)
}

function Get-DirectNodeModuleNames([string]$PackageJsonPath) {
  if (-not (Test-Path -LiteralPath $PackageJsonPath -PathType Leaf)) { return @() }
  $package = Get-Content -LiteralPath $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  return @(
    @($package.dependencies.PSObject.Properties.Name)
    @($package.devDependencies.PSObject.Properties.Name)
  ) | Sort-Object -Unique
}

function Test-NodeModuleImports {
  param(
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$AppRoot,
    [Parameter(Mandatory)][string[]]$ModuleNames
  )
  if (-not $ModuleNames.Count) {
    return [ordered]@{ valid = $true; exitCode = $null; output = 'no-direct-node-modules' }
  }
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
    return [ordered]@{ valid = $false; exitCode = $null; output = 'node-missing' }
  }
  $moduleJson = $ModuleNames | ConvertTo-Json -Compress
  $moduleEnvironmentName = 'PDD_MIGRATION_MODULES_JSON'
  $previousModuleJson = [Environment]::GetEnvironmentVariable($moduleEnvironmentName, 'Process')
  $probe = 'const names = JSON.parse(process.env.PDD_MIGRATION_MODULES_JSON); for (const name of names) { await import(name); }'
  Push-Location $AppRoot
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    [Environment]::SetEnvironmentVariable($moduleEnvironmentName, $moduleJson, 'Process')
    $ErrorActionPreference = 'Continue'
    $output = @(& $Node '--input-type=module' '--eval' $probe 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    [Environment]::SetEnvironmentVariable($moduleEnvironmentName, $previousModuleJson, 'Process')
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  return [ordered]@{
    valid = $exitCode -eq 0
    exitCode = $exitCode
    output = ($output -join [Environment]::NewLine)
  }
}

function Test-DatabaseDumpCatalog {
  param(
    [Parameter(Mandatory)][string]$PgRestore,
    [Parameter(Mandatory)][string]$DumpPath,
    [Parameter(Mandatory)][bool]$Required
  )
  if (-not $Required) {
    return [ordered]@{ required = $false; valid = $true; exitCode = $null }
  }
  if (-not (Test-Path -LiteralPath $PgRestore -PathType Leaf) -or
      -not (Test-Path -LiteralPath $DumpPath -PathType Leaf)) {
    return [ordered]@{ required = $true; valid = $false; exitCode = $null }
  }
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $PgRestore '--list' $DumpPath *> $null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [ordered]@{ required = $true; valid = ($exitCode -eq 0); exitCode = $exitCode }
}

$result = [ordered]@{ checkedAt = [DateTimeOffset]::Now.ToString('o') }
if ($BundleRoot) {
  $bundle = [IO.Path]::GetFullPath($BundleRoot).TrimEnd('\')
  $manifestPath = Join-Path $bundle 'migration-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Migration manifest is missing: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $sourceQuiescenceConfirmed = @($manifest.PSObject.Properties.Name).Contains('sourceQuiescenceConfirmed') -and
    [bool]$manifest.sourceQuiescenceConfirmed
  $files = Test-CriticalFiles -Root $bundle -Manifest $manifest
  $bundleApp = Join-Path $bundle 'payload\app'
  $directNodeModules = @(Get-DirectNodeModuleNames (Join-Path $bundleApp 'package.json'))
  $importableNodeModules = @($directNodeModules | Where-Object { -not $_.StartsWith('@types/') })
  $requiredNodeModuleFiles = @($directNodeModules | ForEach-Object {
    "payload/app/node_modules/$_/package.json"
  })
  $requiredPluginCriticalFiles = @(
    'migration-tools/MigrationCatalog.ps1',
    'payload/app/packages/domain/src/workflow-event-state.mjs',
    'payload/app/scripts/workflow-event-state-self-test.mjs',
    'payload/app/scripts/install-bundled-native-extension.ps1',
    'payload/app/vendor/chrome-extension/pcopnibgkbdnlaeagepigbboebdfejmb/4.0.1.246/manifest.json',
    'payload/extensions/permanent/pcopnibgkbdnlaeagepigbboebdfejmb/4.0.1.246/manifest.json'
  )
  if ([bool]$manifest.externalComponentsIncluded) {
    $requiredPluginCriticalFiles += @(
      'external/IIRPA/RPAChromeExtension/manifest.json',
      'external/IIRPA/RPAChromeExtension/II.RPA.NativeMessagingHost.exe',
      'external/PddCoreService/PddCoreService.exe'
    )
  }
  $criticalPaths = @($manifest.criticalFiles | ForEach-Object {
    ([string]$_.path).Replace('\\', '/').ToLowerInvariant()
  })
  $missingPluginCriticalFiles = @($requiredPluginCriticalFiles | Where-Object {
    -not $criticalPaths.Contains($_.ToLowerInvariant())
  })
  $migrationRoot = Join-Path $bundle 'payload\app\infra\db\migrations'
  $migrationCatalogPath = Join-Path $bundle 'payload\app\infra\db\migration-catalog.json'
  $migrationCatalogCriticalPath = 'payload/app/infra/db/migration-catalog.json'
  $manifestCatalogValidation = [ordered]@{ valid = $false; error = 'manifest-catalog-missing' }
  if (@($manifest.PSObject.Properties.Name).Contains('migrationCatalog')) {
    $manifestCatalogValidation = Test-PddMigrationCatalog -MigrationRoot $migrationRoot `
      -Catalog $manifest.migrationCatalog
  }
  $payloadCatalogValidation = [ordered]@{ valid = $false; error = 'payload-catalog-missing' }
  if (Test-Path -LiteralPath $migrationCatalogPath -PathType Leaf) {
    $payloadCatalog = Get-Content -LiteralPath $migrationCatalogPath -Raw -Encoding UTF8 |
      ConvertFrom-Json
    $payloadCatalogValidation = Test-PddMigrationCatalog -MigrationRoot $migrationRoot `
      -Catalog $payloadCatalog
  }
  $requiredMigrationCriticalFiles = if (Test-Path -LiteralPath $migrationRoot -PathType Container) {
    @(Get-ChildItem -LiteralPath $migrationRoot -File -Filter '*.sql' | ForEach-Object {
      (Get-PddRelativePath -Root $bundle -Path $_.FullName).Replace('\', '/').ToLowerInvariant()
    })
  } else { @() }
  $missingMigrationCriticalFiles = @($requiredMigrationCriticalFiles | Where-Object {
    -not $criticalPaths.Contains($_)
  })
  if (-not $criticalPaths.Contains($migrationCatalogCriticalPath)) {
    $missingMigrationCriticalFiles += $migrationCatalogCriticalPath
  }
  $missingNodeModuleFiles = @($requiredNodeModuleFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $bundle $_.Replace('/', '\')) -PathType Leaf)
  })
  $missingNodeModuleCriticalFiles = @($requiredNodeModuleFiles | Where-Object {
    -not $criticalPaths.Contains($_.ToLowerInvariant())
  })
  $nodeModuleImports = Test-NodeModuleImports `
    -Node (Join-Path $bundle 'payload\runtime\node\node.exe') `
    -AppRoot $bundleApp -ModuleNames $importableNodeModules
  $databaseDumpCatalog = Test-DatabaseDumpCatalog `
    -PgRestore (Join-Path $bundle 'payload\runtime\postgres\bin\pg_restore.exe') `
    -DumpPath (Join-Path $bundle 'database\postgres-workorders.dump') `
    -Required ([bool]$manifest.databaseDumpIncluded)
  $result.bundle = [ordered]@{
    root = $bundle
    manifest = $manifestPath
    criticalFiles = $files
    missingPluginCriticalFiles = $missingPluginCriticalFiles
    missingMigrationCriticalFiles = $missingMigrationCriticalFiles
    manifestMigrationCatalog = $manifestCatalogValidation
    payloadMigrationCatalog = $payloadCatalogValidation
    missingNodeModuleFiles = $missingNodeModuleFiles
    missingNodeModuleCriticalFiles = $missingNodeModuleCriticalFiles
    nodeModuleImports = $nodeModuleImports
    databaseDumpCatalog = $databaseDumpCatalog
    sourceQuiescenceConfirmed = $sourceQuiescenceConfirmed
    cutoverReady = $false
    valid = -not @($files | Where-Object { -not $_.exists -or -not $_.hashMatches }).Count -and
      -not $missingPluginCriticalFiles.Count -and
      -not $missingMigrationCriticalFiles.Count -and
      $manifestCatalogValidation.valid -and
      $payloadCatalogValidation.valid -and
      -not $missingNodeModuleFiles.Count -and
      -not $missingNodeModuleCriticalFiles.Count -and
      $databaseDumpCatalog.valid -and
      $nodeModuleImports.valid
  }
  $result.bundle.cutoverReady = $result.bundle.valid -and $sourceQuiescenceConfirmed
}

if ($InstallRoot) {
  $install = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $app = Join-Path $install 'app'
  $node = Join-Path $install 'runtime\node\node.exe'
  $required = @(
    'app\.env.native',
    'app\workflow.mjs',
    'app\workflow-runtime.mjs',
    'app\apps\api\src\data-backend.mjs',
    'app\apps\api\src\main.mjs',
    'app\apps\api\src\worker-event-identity.mjs',
    'app\scripts\dingtalk-dispatcher.mjs',
    'app\apps\worker\src\dynamic-supervisor.mjs',
    'app\apps\worker\src\postgres-playwright-runner.mjs',
    'app\apps\web\dist\index.html',
    'app\apps\web\src\components\WorkOrderDrawer.jsx',
    'app\packages\adapters\src\pdd\ordinary-work-orders.mjs',
    'app\packages\adapters\src\pdd\order-remark.mjs',
    'app\packages\adapters\src\pdd\render-wait.mjs',
    'app\packages\adapters\src\pdd\return-refund.mjs',
    'app\packages\adapters\src\postgres\index.mjs',
    'app\packages\domain\src\workflow-event-state.mjs',
    'app\infra\db\migration-catalog.json',
    'app\infra\db\migrations\165_recover_api_created_tms_row_verification.sql',
    'app\infra\db\migrations\166_requery_api_created_tms_rows.sql',
    'app\infra\db\migrations\167_recover_pdd_order_remark_reload_abort.sql',
    'app\infra\db\migrations\168_recover_prefilled_reply_submit_form.sql',
    'app\infra\db\migrations\169_recover_pdd_evidence_order_parsing.sql',
    'app\infra\db\migrations\170_recover_stale_pdd_evidence_detail.sql',
    'app\infra\db\migrations\171_recover_unique_existing_tms_warehouse.sql',
    'app\infra\db\migrations\172_recover_flattened_oms_warehouse_text.sql',
    'app\infra\db\migrations\173_reconcile_return_refund_schedule_and_orphans.sql',
    'app\infra\db\migrations\206_resume_consumer_negotiation_followups_without_tms_replay.sql',
    'app\infra\db\migrations\207_finalize_confirmed_consumer_negotiation_followups.sql',
    'app\infra\db\migrations\208_finalize_already_confirmed_consumer_negotiation_followups.sql',
    'app\infra\db\migrations\209_recover_consumer_negotiation_followup_race.sql',
    'app\infra\db\migrations\210_recover_terminal_oms_manual_allocation_pauses.sql',
    'app\infra\db\migrations\211_resume_resolved_verification_backoffs.sql',
    'app\infra\db\migrations\212_recover_consumer_negotiation_missing_evidence_disposition.sql',
    'app\infra\db\migrations\213_recover_stale_ordinary_detail_render_loop.sql',
    'app\infra\db\migrations\222_backfill_current_pdd_upload_authorization_notifications.sql',
    'app\scripts\install-bundled-native-extension.ps1',
    'app\scripts\install-native-windows-tasks.ps1',
    'app\scripts\ordinary-latency-gate.mjs',
    'app\scripts\ordinary-work-order-instance-self-test.mjs',
    'app\scripts\restore-native-worker-windows.ps1',
    'app\scripts\return-refund-api-self-test.mjs',
    'app\scripts\workflow-event-state-self-test.mjs',
    'app\vendor\chrome-extension\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json',
    'extensions\permanent\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json',
    'runtime\node\node.exe',
    'runtime\postgres\bin\psql.exe',
    'runtime\minio\minio.exe'
  )
  $directNodeModules = @(Get-DirectNodeModuleNames (Join-Path $app 'package.json'))
  $importableNodeModules = @($directNodeModules | Where-Object { -not $_.StartsWith('@types/') })
  $required += @($directNodeModules | ForEach-Object {
    "app\node_modules\$_\package.json"
  })
  $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $install $_)) })
  $installedMigrationCatalog = [ordered]@{ valid = $false; error = 'installed-catalog-missing' }
  $installedMigrationRoot = Join-Path $app 'infra\db\migrations'
  $installedMigrationCatalogPath = Join-Path $app 'infra\db\migration-catalog.json'
  if ((Test-Path -LiteralPath $installedMigrationRoot -PathType Container) -and
      (Test-Path -LiteralPath $installedMigrationCatalogPath -PathType Leaf)) {
    $installedCatalog = Get-Content -LiteralPath $installedMigrationCatalogPath -Raw -Encoding UTF8 |
      ConvertFrom-Json
    $installedMigrationCatalog = Test-PddMigrationCatalog `
      -MigrationRoot $installedMigrationRoot -Catalog $installedCatalog
  }
  $webIndex = Join-Path $app 'apps\web\dist\index.html'
  if (Test-Path -LiteralPath $webIndex -PathType Leaf) {
    $webIndexSource = Get-Content -LiteralPath $webIndex -Raw -Encoding UTF8
    foreach ($match in [regex]::Matches($webIndexSource, '(?:src|href)=["'']([^"'']+)["'']')) {
      $assetPath = [string]$match.Groups[1].Value
      if (-not $assetPath.StartsWith('/assets/')) { continue }
      $assetFile = Join-Path (Join-Path $app 'apps\web\dist') $assetPath.TrimStart('/').Replace('/', '\')
      if (-not (Test-Path -LiteralPath $assetFile -PathType Leaf)) {
        $missing += "app\apps\web\dist$($assetPath.Replace('/', '\'))"
      }
    }
  }
  $syntax = [Collections.Generic.List[object]]::new()
  if (-not $missing.Count) {
    foreach ($relative in @(
      'workflow.mjs',
      'workflow-runtime.mjs',
      'apps\api\src\data-backend.mjs',
      'apps\api\src\main.mjs',
      'apps\api\src\worker-event-identity.mjs',
      'apps\worker\src\dynamic-supervisor.mjs',
      'apps\worker\src\postgres-playwright-runner.mjs',
      'scripts\return-refund-api-self-test.mjs',
      'packages\adapters\src\pdd\ordinary-work-orders.mjs',
      'packages\adapters\src\pdd\order-remark.mjs',
      'packages\adapters\src\pdd\render-wait.mjs',
      'packages\adapters\src\pdd\return-refund.mjs',
      'packages\adapters\src\postgres\index.mjs',
      'packages\domain\src\workflow-event-state.mjs',
      'scripts\workflow-event-state-self-test.mjs',
      'scripts\ordinary-latency-gate.mjs'
    )) {
      & $node --check (Join-Path $app $relative)
      $syntax.Add([ordered]@{ file = $relative; valid = ($LASTEXITCODE -eq 0) })
    }
  }
  $extensionManifest = Join-Path $install `
    'extensions\permanent\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json'
  $bundledExtensionManifest = Join-Path $install `
    'app\vendor\chrome-extension\pcopnibgkbdnlaeagepigbboebdfejmb\4.0.1.246\manifest.json'
  $extensionVersion = $null
  $bundledExtensionVersion = $null
  $pluginInstallerPinnedVersion = $null
  $extensionManifestHashMatches = $false
  if (Test-Path -LiteralPath $extensionManifest -PathType Leaf) {
    $extensionVersion = [string](Get-Content -LiteralPath $extensionManifest -Raw | ConvertFrom-Json).version
  }
  if (Test-Path -LiteralPath $bundledExtensionManifest -PathType Leaf) {
    $bundledExtensionVersion = [string](Get-Content -LiteralPath $bundledExtensionManifest -Raw | ConvertFrom-Json).version
  }
  if ((Test-Path -LiteralPath $extensionManifest -PathType Leaf) -and
      (Test-Path -LiteralPath $bundledExtensionManifest -PathType Leaf)) {
    $extensionManifestHashMatches =
      (Get-FileHash -LiteralPath $extensionManifest -Algorithm SHA256).Hash -eq
      (Get-FileHash -LiteralPath $bundledExtensionManifest -Algorithm SHA256).Hash
  }
  $pluginInstaller = Join-Path $app 'scripts\install-bundled-native-extension.ps1'
  if (Test-Path -LiteralPath $pluginInstaller -PathType Leaf) {
    $pluginInstallerSource = Get-Content -LiteralPath $pluginInstaller -Raw -Encoding UTF8
    if ($pluginInstallerSource -match '\$extensionVersion\s*=\s*''([^'']+)''') {
      $pluginInstallerPinnedVersion = $Matches[1]
    }
  }

  $environment = @{}
  foreach ($line in Get-Content -LiteralPath (Join-Path $app '.env.native') -Encoding UTF8) {
    if ($line -notmatch '^([^#=]+)=(.*)$') { continue }
    $environment[$Matches[1].Trim()] = $Matches[2].Trim().Trim('"').Trim("'")
  }
  $extensionId = 'pcopnibgkbdnlaeagepigbboebdfejmb'
  $expectedExtensionRoot = Join-Path $install `
    "extensions\permanent\$extensionId\4.0.1.246"
  $environmentConfigured =
    [string]$environment.WORKFLOW_BROWSER_EXTENSION_PATHS -eq $expectedExtensionRoot -and
    [string]$environment.WORKFLOW_REQUIRED_EXTENSION_IDS -eq $extensionId -and
    [string]$environment.WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS -eq 'true' -and
    [string]$environment.WORKFLOW_ALLOW_MANUAL_EXTENSIONS -eq 'false'

  $forceListConfigured = $false
  $forceListKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
  if (Test-Path -LiteralPath $forceListKey) {
    $forceList = Get-ItemProperty -LiteralPath $forceListKey
    $forceListConfigured = [bool]@($forceList.PSObject.Properties | Where-Object {
      [string]$_.Value -like "$extensionId;*"
    }).Count
  }
  $extensionSettingsConfigured = $false
  $policyRoot = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
  $settingsJson = (Get-ItemProperty -LiteralPath $policyRoot -Name ExtensionSettings `
    -ErrorAction SilentlyContinue).ExtensionSettings
  if ($settingsJson) {
    try {
      $settings = $settingsJson | ConvertFrom-Json
      $extensionSettingsConfigured =
        [string]$settings.$extensionId.installation_mode -eq 'force_installed'
    } catch { }
  }

  $nativeHostRegistered = $false
  $nativeHostManifestValid = $false
  $nativeHostKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\ii.rpa.chromenativemsg'
  if (Test-Path -LiteralPath $nativeHostKey) {
    $nativeHostManifest = [string](Get-Item -LiteralPath $nativeHostKey).GetValue('')
    $nativeHostRegistered = [bool]$nativeHostManifest
    if (Test-Path -LiteralPath $nativeHostManifest -PathType Leaf) {
      try {
        $nativeHost = Get-Content -LiteralPath $nativeHostManifest -Raw -Encoding UTF8 |
          ConvertFrom-Json
        $nativeExecutable = if ([IO.Path]::IsPathRooted([string]$nativeHost.path)) {
          [string]$nativeHost.path
        } else {
          Join-Path (Split-Path -Parent $nativeHostManifest) ([string]$nativeHost.path)
        }
        $nativeHostManifestValid =
          (Test-Path -LiteralPath $nativeExecutable -PathType Leaf) -and
          @($nativeHost.allowed_origins) -contains "chrome-extension://$extensionId/"
      } catch { }
    }
  }

  $coreService = Get-Service -Name 'PddCoreService' -ErrorAction SilentlyContinue
  $coreServiceValid = $null -ne $coreService -and
    [string]$coreService.Status -eq 'Running' -and
    [string]$coreService.StartType -eq 'Automatic'
  $coreServiceRecoveryValid = $false
  if ($coreService) {
    $recoveryOutput = @(& sc.exe qfailure PddCoreService 2>&1)
    $recoveryExitCode = $LASTEXITCODE
    $failureFlagOutput = @(& sc.exe qfailureflag PddCoreService 2>&1)
    $failureFlagExitCode = $LASTEXITCODE
    $restartActionPattern = '(?:\bRESTART\b|\u91CD\u542F\u52A8)'
    $coreServiceRecoveryValid =
      $recoveryExitCode -eq 0 -and
      ([regex]::Matches(($recoveryOutput -join "`n"), $restartActionPattern,
        [Text.RegularExpressions.RegexOptions]::IgnoreCase).Count -ge 3) -and
      $failureFlagExitCode -eq 0 -and
      (($failureFlagOutput -join "`n") -match '\bTRUE\b')
  }
  $nodeModuleImports = Test-NodeModuleImports `
    -Node $node -AppRoot $app -ModuleNames $importableNodeModules
  $result.installation = [ordered]@{
    root = $install
    missing = $missing
    syntax = @($syntax)
    extensionVersion = $extensionVersion
    bundledExtensionVersion = $bundledExtensionVersion
    pluginInstallerPinnedVersion = $pluginInstallerPinnedVersion
    extensionManifestHashMatches = $extensionManifestHashMatches
    environmentConfigured = $environmentConfigured
    forceListConfigured = $forceListConfigured
    extensionSettingsConfigured = $extensionSettingsConfigured
    nativeHostRegistered = $nativeHostRegistered
    nativeHostManifestValid = $nativeHostManifestValid
    coreServiceValid = $coreServiceValid
    coreServiceRecoveryValid = $coreServiceRecoveryValid
    nodeModuleImports = $nodeModuleImports
    migrationCatalog = $installedMigrationCatalog
    valid = -not $missing.Count -and
      -not @($syntax | Where-Object { -not $_.valid }).Count -and
      $extensionVersion -eq '4.0.1.246' -and
      $bundledExtensionVersion -eq '4.0.1.246' -and
      $pluginInstallerPinnedVersion -eq '4.0.1.246' -and
      $extensionManifestHashMatches -and
      $environmentConfigured -and
      $forceListConfigured -and
      $extensionSettingsConfigured -and
      $nativeHostRegistered -and
      $nativeHostManifestValid -and
      $coreServiceValid -and
      $coreServiceRecoveryValid -and
      $installedMigrationCatalog.valid -and
      $nodeModuleImports.valid
  }
}

$result.ok = (($result.bundle -eq $null) -or $result.bundle.valid) -and
  (($result.installation -eq $null) -or $result.installation.valid)
$result | ConvertTo-Json -Depth 10
if (-not $result.ok) { exit 1 }
