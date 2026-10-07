[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$BundleRoot,
  [string]$InstallRoot = 'C:\pdd-native',
  [switch]$InstallDatabase,
  [switch]$InstallSystemComponents,
  [switch]$InstallTasks,
  [switch]$StartServices,
  [switch]$StartWorker,
  [switch]$AllowUnquiescedSnapshot,
  [switch]$Full
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

function Invoke-DirectoryCopy([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:2 `
    /MT:16 /NP /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy failed ($LASTEXITCODE): $Source" }
}

function Assert-CriticalFiles([string]$Root, $Manifest) {
  foreach ($entry in @($Manifest.criticalFiles)) {
    $relative = ([string]$entry.path).Replace('/', '\')
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Bundle file missing: $relative" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$entry.sha256) { throw "Bundle hash mismatch: $relative" }
  }
}

function Set-InstallRootInEnvironment([string]$EnvFile, [string]$OldRoot, [string]$NewRoot) {
  $oldPattern = [regex]::Escape($OldRoot.TrimEnd('\'))
  $lines = foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
    [regex]::Replace($line, $oldPattern, { param($match) $NewRoot }, 'IgnoreCase')
  }
  [IO.File]::WriteAllLines($EnvFile, $lines, [Text.UTF8Encoding]::new($false))
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'System component and scheduled-task installation requires an elevated PowerShell window.'
  }
}

$bundle = Get-FullPath $BundleRoot
$install = Get-FullPath $InstallRoot
$manifestPath = Join-Path $bundle 'migration-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Migration manifest is missing: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sourceQuiescenceConfirmed = @($manifest.PSObject.Properties.Name).Contains('sourceQuiescenceConfirmed') -and
  [bool]$manifest.sourceQuiescenceConfirmed
if (-not $sourceQuiescenceConfirmed -and -not $AllowUnquiescedSnapshot) {
  throw 'Bundle source quiescence was not confirmed. Refusing final restore; create a stopped-source export or use -AllowUnquiescedSnapshot only for an isolated test.'
}
Assert-CriticalFiles -Root $bundle -Manifest $manifest
$bundleMigrationRoot = Join-Path $bundle 'payload\app\infra\db\migrations'
$bundleMigrationCatalogPath = Join-Path $bundle 'payload\app\infra\db\migration-catalog.json'
if (-not @($manifest.PSObject.Properties.Name).Contains('migrationCatalog')) {
  throw 'Bundle manifest does not contain the required migration catalog.'
}
if (-not (Test-Path -LiteralPath $bundleMigrationCatalogPath -PathType Leaf)) {
  throw "Bundle migration catalog is missing: $bundleMigrationCatalogPath"
}
$payloadMigrationCatalog = Get-Content -LiteralPath $bundleMigrationCatalogPath -Raw -Encoding UTF8 |
  ConvertFrom-Json
Assert-PddMigrationCatalog -MigrationRoot $bundleMigrationRoot `
  -Catalog $manifest.migrationCatalog -Context 'Bundle manifest migration catalog' | Out-Null
Assert-PddMigrationCatalog -MigrationRoot $bundleMigrationRoot `
  -Catalog $payloadMigrationCatalog -Context 'Bundle payload migration catalog' | Out-Null

if (Test-Path -LiteralPath $install) {
  if (@(Get-ChildItem -LiteralPath $install -Force).Count) {
    throw "InstallRoot must be absent or empty: $install"
  }
} else {
  New-Item -ItemType Directory -Path $install -Force | Out-Null
}
Invoke-DirectoryCopy -Source (Join-Path $bundle 'payload') -Destination $install

$appRoot = Join-Path $install 'app'
$installedMigrationRoot = Join-Path $appRoot 'infra\db\migrations'
$installedMigrationCatalogPath = Join-Path $appRoot 'infra\db\migration-catalog.json'
$installedMigrationCatalog = Get-Content -LiteralPath $installedMigrationCatalogPath -Raw -Encoding UTF8 |
  ConvertFrom-Json
Assert-PddMigrationCatalog -MigrationRoot $installedMigrationRoot `
  -Catalog $installedMigrationCatalog -Context 'Restored migration catalog' | Out-Null
$envFile = Join-Path $appRoot '.env.native'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'Restored .env.native is missing.' }
Set-InstallRootInEnvironment -EnvFile $envFile `
  -OldRoot ([string]$manifest.sourceInstallRoot) -NewRoot $install

$InstallDatabase = $InstallDatabase -or $Full
$InstallSystemComponents = $InstallSystemComponents -or $Full
$InstallTasks = $InstallTasks -or $Full
$StartServices = $StartServices -or $Full
if ($InstallDatabase -or $InstallSystemComponents -or $InstallTasks) { Assert-Administrator }

if ($InstallSystemComponents) {
  $iirpaSource = Join-Path $bundle 'external\IIRPA\RPAChromeExtension'
  $iirpaTarget = Join-Path $env:LOCALAPPDATA 'IIRPA\RPAChromeExtension'
  Invoke-DirectoryCopy -Source $iirpaSource -Destination $iirpaTarget
  $nativeManifest = Join-Path $iirpaTarget 'manifest.json'
  if (Test-Path -LiteralPath $nativeManifest -PathType Leaf) {
    $native = Get-Content -LiteralPath $nativeManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $native.path = Join-Path $iirpaTarget 'II.RPA.NativeMessagingHost.exe'
    [IO.File]::WriteAllText($nativeManifest, ($native | ConvertTo-Json -Depth 10), `
      [Text.UTF8Encoding]::new($false))
    $nativeHostKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\ii.rpa.chromenativemsg'
    New-Item -Path $nativeHostKey -Force | Out-Null
    Set-Item -Path $nativeHostKey -Value $nativeManifest
  }

  $coreSource = Join-Path $bundle 'external\PddCoreService'
  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $coreTarget = Join-Path $programFilesX86 'PddCoreService'
  Invoke-DirectoryCopy -Source $coreSource -Destination $coreTarget
  $coreExecutable = Join-Path $coreTarget 'PddCoreService.exe'
  if ((Test-Path -LiteralPath $coreExecutable -PathType Leaf) -and
      -not (Get-Service -Name 'PddCoreService' -ErrorAction SilentlyContinue)) {
    & sc.exe create PddCoreService "binPath= `"$coreExecutable`"" 'start= auto' `
      'DisplayName= PddCoreService' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PddCoreService registration failed.' }
  }
  $coreService = Get-Service -Name 'PddCoreService' -ErrorAction SilentlyContinue
  if ($coreService) {
    & sc.exe failure PddCoreService 'reset=' 86400 `
      'actions=' 'restart/5000/restart/15000/restart/60000' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PddCoreService recovery configuration failed.' }
    & sc.exe failureflag PddCoreService 1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PddCoreService failure flag configuration failed.' }
    Start-Service -Name 'PddCoreService' -ErrorAction Stop
    Start-Sleep -Seconds 2
    if ([string](Get-Service -Name 'PddCoreService').Status -ne 'Running') {
      throw 'PddCoreService did not remain running after startup.'
    }
  }
  & (Join-Path $appRoot 'scripts\install-bundled-native-extension.ps1') -InstallRoot $install
}

if ($InstallDatabase) {
  $dumpPath = Join-Path $bundle 'database\postgres-workorders.dump'
  if (-not (Test-Path -LiteralPath $dumpPath -PathType Leaf)) { throw 'Database dump is missing.' }
  $incoming = Join-Path $install 'backup\incoming\postgres-workorders.dump'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $incoming) | Out-Null
  Copy-Item -LiteralPath $dumpPath -Destination $incoming -Force
  & (Join-Path $appRoot 'scripts\restore-native-windows-postgres.ps1') `
    -InstallRoot $install -DumpPath $incoming
  & (Join-Path $PSScriptRoot 'Apply-PddDatabaseMigrations.ps1') -InstallRoot $install
}

if ($InstallTasks) {
  & (Join-Path $appRoot 'scripts\install-native-windows-vcredist.ps1')
  & (Join-Path $appRoot 'scripts\install-native-windows-tasks.ps1')
}

if ($StartServices) {
  $startArguments = @{ NoBrowser = $true }
  if ($StartWorker) { $startArguments.StartWorker = $true }
  & (Join-Path $appRoot 'scripts\start-native-windows.ps1') @startArguments
}

[ordered]@{
  restored = $true
  installRoot = $install
  databaseInstalled = [bool]$InstallDatabase
  systemComponentsInstalled = [bool]$InstallSystemComponents
  tasksInstalled = [bool]$InstallTasks
  servicesStarted = [bool]$StartServices
  workerStarted = [bool]($StartServices -and $StartWorker)
  browserLoginRequired = -not [bool]$manifest.browserProfilesIncluded
} | ConvertTo-Json -Depth 4
