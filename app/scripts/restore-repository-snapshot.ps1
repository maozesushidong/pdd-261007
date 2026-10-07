param(
  [string]$InstallRoot = 'C:\pdd-native',
  [string]$SnapshotRoot = '',
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$app = Join-Path $InstallRoot 'app'
$pgBin = Join-Path $InstallRoot 'runtime\postgres\bin'
$mc = Join-Path $InstallRoot 'runtime\minio\mc.exe'
if (-not $SnapshotRoot) {
  $SnapshotRoot = Join-Path $app 'deployment\native-snapshot\2026-08-16'
}
$SnapshotRoot = [IO.Path]::GetFullPath($SnapshotRoot)
$manifestPath = Join-Path $SnapshotRoot 'manifest.json'

foreach ($required in @((Join-Path $pgBin 'pg_restore.exe'), $mc, $manifestPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required file is missing: $required"
  }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) {
  throw "Unsupported snapshot schema version: $($manifest.schemaVersion)"
}

$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("pdd-repository-restore-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

function Join-ArchiveParts {
  param([Parameter(Mandatory)]$Archive)

  $destination = Join-Path $workRoot $Archive.name
  $outputStream = [IO.File]::Create($destination)
  try {
    foreach ($part in $Archive.parts) {
      $partPath = [IO.Path]::GetFullPath((Join-Path $SnapshotRoot $part.file))
      if (-not $partPath.StartsWith($SnapshotRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Snapshot part escapes the snapshot root: $($part.file)"
      }
      if (-not (Test-Path -LiteralPath $partPath -PathType Leaf)) {
        throw "Snapshot part is missing: $partPath"
      }
      $actualPartHash = (Get-FileHash -LiteralPath $partPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualPartHash -ne $part.sha256) {
        throw "Snapshot part checksum mismatch: $partPath"
      }
      $inputStream = [IO.File]::OpenRead($partPath)
      try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose() }
    }
  } finally {
    $outputStream.Dispose()
  }

  $file = Get-Item -LiteralPath $destination
  if ($file.Length -ne [int64]$Archive.sizeBytes) {
    throw "Reconstructed archive size mismatch: $($Archive.name)"
  }
  $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $Archive.sha256) {
    throw "Reconstructed archive checksum mismatch: $($Archive.name)"
  }
  return $destination
}

try {
  $databaseArchive = $manifest.archives | Where-Object { $_.format -eq 'postgres-custom' } | Select-Object -First 1
  $objectArchive = $manifest.archives | Where-Object { $_.format -eq 'tar-gzip' } | Select-Object -First 1
  if (-not $databaseArchive -or -not $objectArchive) { throw 'Snapshot archives are incomplete.' }

  $dumpPath = Join-ArchiveParts -Archive $databaseArchive
  $objectArchivePath = Join-ArchiveParts -Archive $objectArchive

  & (Join-Path $pgBin 'pg_restore.exe') --list $dumpPath *> $null
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL snapshot validation failed with exit code $LASTEXITCODE" }
  & tar.exe -tzf $objectArchivePath *> $null
  if ($LASTEXITCODE -ne 0) { throw "MinIO snapshot validation failed with exit code $LASTEXITCODE" }

  if ($VerifyOnly) {
    Write-Output ([ordered]@{
      Verified = $true
      SnapshotId = $manifest.snapshotId
      DatabaseBytes = $manifest.source.databaseBytes
      TableCount = $manifest.source.tableCount
      ObjectCount = $manifest.source.objectCount
      ObjectBytes = $manifest.source.objectBytes
    } | ConvertTo-Json -Compress)
    return
  }

  $pgData = Join-Path $InstallRoot 'data\postgres16-final'
  $minioData = Join-Path $InstallRoot 'data\minio'
  if (Test-Path -LiteralPath $pgData) {
    throw "PostgreSQL target already exists; refusing to overwrite it: $pgData"
  }
  if ((Test-Path -LiteralPath $minioData) -and (Get-ChildItem -LiteralPath $minioData -Force | Select-Object -First 1)) {
    throw "MinIO target is not empty; refusing to overwrite it: $minioData"
  }

  & (Join-Path $app 'scripts\restore-native-windows-postgres.ps1') `
    -InstallRoot $InstallRoot -DumpPath $dumpPath

  $objectRoot = Join-Path $workRoot 'minio-objects'
  New-Item -ItemType Directory -Force -Path $objectRoot, $minioData | Out-Null
  & tar.exe -xzf $objectArchivePath -C $objectRoot
  if ($LASTEXITCODE -ne 0) { throw "MinIO snapshot extraction failed with exit code $LASTEXITCODE" }

  . (Join-Path $app 'scripts\load-native-windows-env.ps1') -ProjectRoot $app
  $env:MINIO_ROOT_USER = $env:S3_ACCESS_KEY
  $env:MINIO_ROOT_PASSWORD = $env:S3_SECRET_KEY
  $minioProcess = Start-Process -FilePath (Join-Path $InstallRoot 'runtime\minio\minio.exe') `
    -ArgumentList @('server', $minioData, '--address', '127.0.0.1:9000', '--console-address', '127.0.0.1:9001') `
    -WindowStyle Hidden -PassThru
  try {
    $ready = $false
    $deadline = (Get-Date).AddMinutes(2)
    do {
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9000/minio/health/live' -TimeoutSec 3
        if ($response.StatusCode -eq 200) { $ready = $true; break }
      } catch { }
      Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if (-not $ready) { throw 'Temporary MinIO process did not become ready.' }

    $mcConfig = Join-Path $workRoot 'mc-config'
    & $mc --quiet --config-dir $mcConfig alias set restore-target `
      $env:S3_ENDPOINT $env:S3_ACCESS_KEY $env:S3_SECRET_KEY *> $null
    if ($LASTEXITCODE -ne 0) { throw "MinIO alias setup failed with exit code $LASTEXITCODE" }
    & $mc --quiet --config-dir $mcConfig mb --ignore-existing "restore-target/$($env:S3_BUCKET)" *> $null
    if ($LASTEXITCODE -ne 0) { throw "MinIO bucket creation failed with exit code $LASTEXITCODE" }
    & $mc --quiet --config-dir $mcConfig mirror --overwrite `
      $objectRoot "restore-target/$($env:S3_BUCKET)" *> $null
    if ($LASTEXITCODE -ne 0) { throw "MinIO object restore failed with exit code $LASTEXITCODE" }
  } finally {
    if ($minioProcess -and -not $minioProcess.HasExited) {
      Stop-Process -Id $minioProcess.Id -Force
      $minioProcess.WaitForExit()
    }
  }

  Write-Output ([ordered]@{
    Restored = $true
    SnapshotId = $manifest.snapshotId
    Database = $manifest.source.database
    Bucket = $manifest.source.s3Bucket
    ObjectCount = $manifest.source.objectCount
  } | ConvertTo-Json -Compress)
} finally {
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedWork = [IO.Path]::GetFullPath($workRoot)
  if ($resolvedWork.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedWork)) {
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force
  }
}
