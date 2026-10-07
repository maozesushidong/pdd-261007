param(
  [string]$InstallRoot = 'C:\pdd-native',
  [string]$DumpPath = 'C:\pdd-native\backup\incoming\postgres-workorders.dump'
)

$ErrorActionPreference = 'Stop'
$app = Join-Path $InstallRoot 'app'
$pgBin = Join-Path $InstallRoot 'runtime\postgres\bin'
$pgData = Join-Path $InstallRoot 'data\postgres16-final'
$logPath = Join-Path $InstallRoot 'logs\postgres-restore.log'

. (Join-Path $app 'scripts\load-native-windows-env.ps1') -ProjectRoot $app
if (Test-Path -LiteralPath $pgData) { throw "PostgreSQL data target already exists: $pgData" }
if (-not (Test-Path -LiteralPath $DumpPath)) { throw "PostgreSQL dump was not found: $DumpPath" }
$passwordFile = Join-Path $InstallRoot 'backup\pg-init-password.tmp'
[IO.File]::WriteAllText($passwordFile, $env:POSTGRES_PASSWORD, (New-Object Text.UTF8Encoding($false)))
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & (Join-Path $pgBin 'initdb.exe') -D $pgData -U $env:POSTGRES_USER `
    --pwfile=$passwordFile --encoding=UTF8 --locale-provider=icu `
    --icu-locale=en-US --auth=scram-sha-256
  $initExitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
  $ErrorActionPreference = $previousPreference
}
if ($initExitCode -ne 0) { throw "initdb failed with exit code $initExitCode" }

@(
  "listen_addresses = '127.0.0.1'"
  'port = 5432'
  "timezone = 'UTC'"
  'max_connections = 100'
) | Add-Content -LiteralPath (Join-Path $pgData 'postgresql.conf') -Encoding ascii

if (Get-Service -Name 'pdd-postgresql-16' -ErrorAction SilentlyContinue) {
  throw 'PostgreSQL service pdd-postgresql-16 already exists.'
}
$ErrorActionPreference = 'Continue'
& (Join-Path $pgBin 'pg_ctl.exe') register -N 'pdd-postgresql-16' -D $pgData -S auto
$registerExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
if ($registerExitCode -ne 0) { throw "Service registration failed with exit code $registerExitCode" }

Start-Service 'pdd-postgresql-16'
$env:PGPASSWORD = $env:POSTGRES_PASSWORD
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    & (Join-Path $pgBin 'pg_isready.exe') -h 127.0.0.1 -p 5432 -U $env:POSTGRES_USER *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'PostgreSQL did not become ready.' }

  $ErrorActionPreference = 'Continue'
  & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p 5432 -U $env:POSTGRES_USER `
    --encoding=UTF8 --locale-provider=icu --icu-locale=en-US --template=template0 $env:POSTGRES_DB
  $createExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($createExitCode -ne 0) { throw "Database creation failed with exit code $createExitCode" }

  $ErrorActionPreference = 'Continue'
  & (Join-Path $pgBin 'pg_restore.exe') -h 127.0.0.1 -p 5432 -U $env:POSTGRES_USER `
    -d $env:POSTGRES_DB --exit-on-error --no-owner $DumpPath *> $logPath
  $restoreExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($restoreExitCode -ne 0) {
    Get-Content -LiteralPath $logPath -Tail 100
    throw "PostgreSQL restore failed with exit code $restoreExitCode"
  }

  $ErrorActionPreference = 'Continue'
  & (Join-Path $pgBin 'vacuumdb.exe') -h 127.0.0.1 -p 5432 -U $env:POSTGRES_USER `
    -d $env:POSTGRES_DB --analyze-in-stages *>> $logPath
  $vacuumExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($vacuumExitCode -ne 0) { throw "PostgreSQL analyze failed with exit code $vacuumExitCode" }

  [ordered]@{
    Service = (Get-Service 'pdd-postgresql-16').Status.ToString()
    Version = (& (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -U $env:POSTGRES_USER `
      -d $env:POSTGRES_DB -Atc 'select version()')
    DatabaseBytes = [int64](& (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -U $env:POSTGRES_USER `
      -d $env:POSTGRES_DB -Atc 'select pg_database_size(current_database())')
    Tables = [int](& (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -U $env:POSTGRES_USER `
      -d $env:POSTGRES_DB -Atc "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
