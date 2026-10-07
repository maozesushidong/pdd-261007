[CmdletBinding()]
param([string]$InstallRoot = 'C:\pdd-native')

$ErrorActionPreference = 'Stop'
$migrationCatalogTools = Join-Path $PSScriptRoot 'MigrationCatalog.ps1'
if (-not (Test-Path -LiteralPath $migrationCatalogTools -PathType Leaf)) {
  throw "Migration catalog tools are missing: $migrationCatalogTools"
}
. $migrationCatalogTools
$appRoot = Join-Path $InstallRoot 'app'
$migrationRoot = Join-Path $appRoot 'infra\db\migrations'
$migrationCatalogPath = Join-Path $appRoot 'infra\db\migration-catalog.json'
$psql = Join-Path $InstallRoot 'runtime\postgres\bin\psql.exe'
. (Join-Path $appRoot 'scripts\load-native-windows-env.ps1') -ProjectRoot $appRoot

if (-not (Test-Path -LiteralPath $migrationRoot -PathType Container)) {
  throw "Migration directory is missing: $migrationRoot"
}
if (-not (Test-Path -LiteralPath $migrationCatalogPath -PathType Leaf)) {
  throw "Migration catalog is missing: $migrationCatalogPath"
}
$migrationCatalog = Get-Content -LiteralPath $migrationCatalogPath -Raw -Encoding UTF8 |
  ConvertFrom-Json
Assert-PddMigrationCatalog -MigrationRoot $migrationRoot -Catalog $migrationCatalog `
  -Context 'Installed migration catalog' | Out-Null
if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw "psql is missing: $psql" }
if (-not $env:DATABASE_URL) { throw 'DATABASE_URL is not configured.' }

function Read-AppliedMigrationVersions {
  $versions = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($version in @(& $psql -X -A -t -d $env:DATABASE_URL `
    -c 'select version from schema_migrations order by version')) {
    $trimmed = [string]$version
    if ($trimmed.Trim()) { [void]$versions.Add($trimmed.Trim()) }
  }
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read schema_migrations.' }
  return ,$versions
}

function Register-AppliedMigrationVersion {
  param([Parameter(Mandatory)][string]$Version)

  $escapedVersion = $Version.Replace("'", "''")
  & $psql -X -v 'ON_ERROR_STOP=1' -d $env:DATABASE_URL `
    -c "INSERT INTO schema_migrations (version) VALUES ('$escapedVersion') ON CONFLICT (version) DO NOTHING;"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to register applied migration: $Version"
  }
}

$migrationFiles = @(Get-ChildItem -LiteralPath $migrationRoot -File -Filter '*.sql' | Sort-Object Name)
$applied = Read-AppliedMigrationVersions

$executed = [Collections.Generic.List[string]]::new()
foreach ($migration in $migrationFiles) {
  if ($applied.Contains($migration.Name)) { continue }
  & $psql -X -v 'ON_ERROR_STOP=1' -d $env:DATABASE_URL -f $migration.FullName
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($migration.Name)" }
  Register-AppliedMigrationVersion -Version $migration.Name
  [void]$applied.Add($migration.Name)
  $executed.Add($migration.Name)
}

$recordedAfter = Read-AppliedMigrationVersions
$missingAfter = @($migrationFiles | Where-Object { -not $recordedAfter.Contains($_.Name) } |
  ForEach-Object { $_.Name })
if ($missingAfter.Count -gt 0) {
  throw "Database migration ledger is incomplete after apply: $($missingAfter -join ', ')"
}

[ordered]@{
  appliedNow = @($executed)
  appliedCount = $executed.Count
  migrationFileCount = $migrationFiles.Count
  recordedMigrationCount = $recordedAfter.Count
  missingAfter = @($missingAfter)
  latest = (& $psql -X -A -t -d $env:DATABASE_URL `
    -c 'select version from schema_migrations order by version desc limit 1').Trim()
} | ConvertTo-Json -Depth 4
