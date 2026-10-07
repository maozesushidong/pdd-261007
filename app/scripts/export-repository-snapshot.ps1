param(
  [string]$InstallRoot = 'C:\pdd-native',
  [string]$SnapshotId = (Get-Date -Format 'yyyy-MM-dd'),
  [int]$PartSizeMb = 90
)

$ErrorActionPreference = 'Stop'
$app = Join-Path $InstallRoot 'app'
$snapshotRoot = Join-Path $app "deployment\native-snapshot\$SnapshotId"
$stageRoot = Join-Path $InstallRoot "backup\repository-snapshot-$SnapshotId"
$pgBin = Join-Path $InstallRoot 'runtime\postgres\bin'
$mc = Join-Path $InstallRoot 'runtime\minio\mc.exe'

if ($PartSizeMb -lt 10 -or $PartSizeMb -gt 95) {
  throw 'PartSizeMb must be between 10 and 95 so every file remains below the GitHub 100 MB limit.'
}
if (Test-Path -LiteralPath $snapshotRoot) {
  throw "Snapshot already exists: $snapshotRoot"
}
foreach ($required in @(
  (Join-Path $pgBin 'pg_dump.exe'),
  (Join-Path $pgBin 'pg_restore.exe'),
  $mc,
  (Join-Path $app '.env.native')
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required file is missing: $required"
  }
}

. (Join-Path $app 'scripts\load-native-windows-env.ps1') -ProjectRoot $app
New-Item -ItemType Directory -Force -Path $snapshotRoot, $stageRoot | Out-Null

function Split-Archive {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][int64]$PartSize
  )

  $parts = @()
  $inputStream = [IO.File]::OpenRead($Source)
  try {
    $partNumber = 1
    $buffer = New-Object byte[] (1024 * 1024)
    while ($inputStream.Position -lt $inputStream.Length) {
      $partName = ('{0}.part{1:D3}' -f ([IO.Path]::GetFileName($Source)), $partNumber)
      $partPath = Join-Path $Destination $partName
      $outputStream = [IO.File]::Create($partPath)
      try {
        $written = [int64]0
        while ($written -lt $PartSize -and $inputStream.Position -lt $inputStream.Length) {
          $remaining = [Math]::Min($buffer.Length, $PartSize - $written)
          $read = $inputStream.Read($buffer, 0, [int]$remaining)
          if ($read -le 0) { break }
          $outputStream.Write($buffer, 0, $read)
          $written += $read
        }
      } finally {
        $outputStream.Dispose()
      }
      $file = Get-Item -LiteralPath $partPath
      $parts += [ordered]@{
        file = $file.Name
        sizeBytes = $file.Length
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
      $partNumber += 1
    }
  } finally {
    $inputStream.Dispose()
  }
  return @($parts)
}

$dumpPath = Join-Path $stageRoot 'postgres-workorders.dump'
$objectRoot = Join-Path $stageRoot 'minio-objects'
$objectArchive = Join-Path $stageRoot 'minio-objects.tar.gz'
$mcConfig = Join-Path $stageRoot 'mc-config'

$env:PGPASSWORD = $env:POSTGRES_PASSWORD
try {
  & (Join-Path $pgBin 'pg_dump.exe') -h 127.0.0.1 -p 5432 `
    -U $env:POSTGRES_USER -d $env:POSTGRES_DB --format=custom --compress=9 `
    --no-owner --no-privileges --file $dumpPath
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

& (Join-Path $pgBin 'pg_restore.exe') --list $dumpPath *> $null
if ($LASTEXITCODE -ne 0) { throw "pg_restore validation failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force -Path $objectRoot | Out-Null
& $mc --quiet --config-dir $mcConfig alias set snapshot-source `
  $env:S3_ENDPOINT $env:S3_ACCESS_KEY $env:S3_SECRET_KEY *> $null
if ($LASTEXITCODE -ne 0) { throw "MinIO alias setup failed with exit code $LASTEXITCODE" }
& $mc --quiet --config-dir $mcConfig mirror --overwrite `
  "snapshot-source/$($env:S3_BUCKET)" $objectRoot *> $null
if ($LASTEXITCODE -ne 0) { throw "MinIO mirror failed with exit code $LASTEXITCODE" }

& tar.exe -czf $objectArchive -C $objectRoot .
if ($LASTEXITCODE -ne 0) { throw "MinIO archive creation failed with exit code $LASTEXITCODE" }

$partSize = [int64]$PartSizeMb * 1MB
$dumpParts = Split-Archive -Source $dumpPath -Destination $snapshotRoot -PartSize $partSize
$objectParts = Split-Archive -Source $objectArchive -Destination $snapshotRoot -PartSize $partSize
$objects = Get-ChildItem -LiteralPath $objectRoot -Recurse -File | Measure-Object Length -Sum

$env:PGPASSWORD = $env:POSTGRES_PASSWORD
try {
  $databaseBytes = [int64](& (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p 5432 `
    -U $env:POSTGRES_USER -d $env:POSTGRES_DB -Atc 'select pg_database_size(current_database())')
  $tableCount = [int](& (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p 5432 `
    -U $env:POSTGRES_USER -d $env:POSTGRES_DB -Atc `
    "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

$manifest = [ordered]@{
  schemaVersion = 1
  snapshotId = $SnapshotId
  createdAt = [DateTimeOffset]::Now.ToUniversalTime().ToString('o')
  source = [ordered]@{
    database = $env:POSTGRES_DB
    databaseBytes = $databaseBytes
    tableCount = $tableCount
    s3Bucket = $env:S3_BUCKET
    objectCount = $objects.Count
    objectBytes = [int64]$objects.Sum
  }
  archives = @(
    [ordered]@{
      name = 'postgres-workorders.dump'
      format = 'postgres-custom'
      sizeBytes = (Get-Item -LiteralPath $dumpPath).Length
      sha256 = (Get-FileHash -LiteralPath $dumpPath -Algorithm SHA256).Hash.ToLowerInvariant()
      parts = $dumpParts
    },
    [ordered]@{
      name = 'minio-objects.tar.gz'
      format = 'tar-gzip'
      sizeBytes = (Get-Item -LiteralPath $objectArchive).Length
      sha256 = (Get-FileHash -LiteralPath $objectArchive -Algorithm SHA256).Hash.ToLowerInvariant()
      parts = $objectParts
    }
  )
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $snapshotRoot 'manifest.json') -Encoding UTF8

Write-Output ([ordered]@{
  SnapshotRoot = $snapshotRoot
  DatabaseBytes = $databaseBytes
  ObjectCount = $objects.Count
  SnapshotBytes = ((Get-ChildItem -LiteralPath $snapshotRoot -File |
    Where-Object { $_.Name -match '\.part\d{3}$' } |
    Measure-Object Length -Sum).Sum)
} | ConvertTo-Json -Compress)
