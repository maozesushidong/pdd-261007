function Get-PddRelativePath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path
  )

  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $rootUri = [Uri]::new($resolvedRoot)
  $pathUri = [Uri]::new($resolvedPath)
  return [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace('/', '\')
}

function Get-PddMigrationFiles {
  param([Parameter(Mandatory)][string]$MigrationRoot)

  $resolvedRoot = [IO.Path]::GetFullPath($MigrationRoot).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "Migration directory is missing: $resolvedRoot"
  }
  $files = @(Get-ChildItem -LiteralPath $resolvedRoot -File -Filter '*.sql' |
    Sort-Object Name)
  if (-not $files.Count) {
    throw "Migration directory contains no SQL files: $resolvedRoot"
  }
  $invalidNames = @($files | Where-Object { $_.Name -notmatch '^\d{3}_.+\.sql$' } |
    ForEach-Object { $_.Name })
  if ($invalidNames.Count) {
    throw "Migration filenames are invalid: $($invalidNames -join ', ')"
  }
  $duplicateNames = @($files | Group-Object { $_.Name.ToLowerInvariant() } |
    Where-Object Count -gt 1 | ForEach-Object { $_.Group[0].Name })
  if ($duplicateNames.Count) {
    throw "Migration filenames are duplicated: $($duplicateNames -join ', ')"
  }
  return @($files)
}

function Get-PddMigrationCatalog {
  param([Parameter(Mandatory)][string]$MigrationRoot)

  $files = @(Get-PddMigrationFiles -MigrationRoot $MigrationRoot)
  $entries = @($files | ForEach-Object {
    [ordered]@{
      name = $_.Name
      bytes = [int64]$_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  return [ordered]@{
    formatVersion = 1
    migrationCount = [int]$entries.Count
    latestMigration = [string]$entries[-1].name
    files = @($entries)
  }
}

function Compare-PddMigrationNames {
  param(
    [Parameter(Mandatory)][string]$ExpectedRoot,
    [Parameter(Mandatory)][string]$ActualRoot
  )

  $expected = @(Get-PddMigrationFiles -MigrationRoot $ExpectedRoot |
    ForEach-Object { $_.Name })
  $actual = @(Get-PddMigrationFiles -MigrationRoot $ActualRoot |
    ForEach-Object { $_.Name })
  $expectedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $actualSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $expected) { [void]$expectedSet.Add($name) }
  foreach ($name in $actual) { [void]$actualSet.Add($name) }
  $missing = @($expected | Where-Object { -not $actualSet.Contains($_) })
  $extra = @($actual | Where-Object { -not $expectedSet.Contains($_) })
  return [ordered]@{
    valid = -not $missing.Count -and -not $extra.Count
    expectedCount = [int]$expected.Count
    actualCount = [int]$actual.Count
    missing = @($missing)
    extra = @($extra)
  }
}

function Assert-PddMigrationNames {
  param(
    [Parameter(Mandatory)][string]$ExpectedRoot,
    [Parameter(Mandatory)][string]$ActualRoot,
    [string]$Context = 'migration directory'
  )

  $comparison = Compare-PddMigrationNames -ExpectedRoot $ExpectedRoot -ActualRoot $ActualRoot
  if (-not $comparison.valid) {
    throw "$Context does not match the required migration set. Missing: $($comparison.missing -join ', '); Extra: $($comparison.extra -join ', ')"
  }
  return $comparison
}

function Test-PddMigrationCatalog {
  param(
    [Parameter(Mandatory)][string]$MigrationRoot,
    [Parameter(Mandatory)]$Catalog
  )

  $actualFiles = @(Get-PddMigrationFiles -MigrationRoot $MigrationRoot)
  $actualByName = @{}
  foreach ($file in $actualFiles) {
    $actualByName[$file.Name.ToLowerInvariant()] = $file
  }
  $catalogEntries = @($Catalog.files)
  $catalogNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $missing = [Collections.Generic.List[string]]::new()
  $hashMismatch = [Collections.Generic.List[string]]::new()
  $invalidEntries = [Collections.Generic.List[string]]::new()
  foreach ($entry in $catalogEntries) {
    $name = [string]$entry.name
    if ([string]::IsNullOrWhiteSpace($name) -or $name -match '[\\/]') {
      $invalidEntries.Add($name)
      continue
    }
    if (-not $catalogNames.Add($name)) {
      $invalidEntries.Add($name)
      continue
    }
    $key = $name.ToLowerInvariant()
    if (-not $actualByName.ContainsKey($key)) {
      $missing.Add($name)
      continue
    }
    $file = $actualByName[$key]
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([int64]$file.Length -ne [int64]$entry.bytes -or
        $hash -ne ([string]$entry.sha256).ToLowerInvariant()) {
      $hashMismatch.Add($name)
    }
  }
  $extra = @($actualFiles | Where-Object { -not $catalogNames.Contains($_.Name) } |
    ForEach-Object { $_.Name })
  $latest = if ($actualFiles.Count) { [string]$actualFiles[-1].Name } else { '' }
  $metadataMatches =
    [int]$Catalog.formatVersion -eq 1 -and
    [int]$Catalog.migrationCount -eq $catalogEntries.Count -and
    [int]$Catalog.migrationCount -eq $actualFiles.Count -and
    [string]$Catalog.latestMigration -eq $latest
  return [ordered]@{
    valid = $metadataMatches -and -not $missing.Count -and -not $extra.Count -and
      -not $hashMismatch.Count -and -not $invalidEntries.Count
    metadataMatches = $metadataMatches
    migrationCount = [int]$actualFiles.Count
    latestMigration = $latest
    missing = @($missing)
    extra = @($extra)
    hashMismatch = @($hashMismatch)
    invalidEntries = @($invalidEntries)
  }
}

function Assert-PddMigrationCatalog {
  param(
    [Parameter(Mandatory)][string]$MigrationRoot,
    [Parameter(Mandatory)]$Catalog,
    [string]$Context = 'migration catalog'
  )

  $validation = Test-PddMigrationCatalog -MigrationRoot $MigrationRoot -Catalog $Catalog
  if (-not $validation.valid) {
    throw "$Context is invalid. Missing: $($validation.missing -join ', '); Extra: $($validation.extra -join ', '); Hash mismatch: $($validation.hashMismatch -join ', ')"
  }
  return $validation
}

function Write-PddMigrationCatalog {
  param(
    [Parameter(Mandatory)][string]$MigrationRoot,
    [Parameter(Mandatory)][string]$Destination
  )

  $catalog = Get-PddMigrationCatalog -MigrationRoot $MigrationRoot
  $parent = Split-Path -Parent $Destination
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText(
    $Destination,
    ($catalog | ConvertTo-Json -Depth 6),
    [Text.UTF8Encoding]::new($false)
  )
  return $catalog
}

function Resolve-PddExpectedMigrationRoot {
  param(
    [string]$ExplicitRoot = '',
    [Parameter(Mandatory)][string]$ScriptRoot,
    [Parameter(Mandatory)][string]$FallbackRoot
  )

  $candidates = [Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($ExplicitRoot)) {
    $candidates.Add($ExplicitRoot)
  } else {
    $candidates.Add((Join-Path $ScriptRoot '..\..\infra\db\migrations'))
    $candidates.Add($FallbackRoot)
  }
  foreach ($candidate in $candidates) {
    $resolved = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
    if (Test-Path -LiteralPath $resolved -PathType Container) { return $resolved }
  }
  throw "No authoritative migration directory was found. Checked: $($candidates -join ', ')"
}
