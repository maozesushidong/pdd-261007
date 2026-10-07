param(
  [Parameter(Mandatory)]
  [string]$SqlFile,
  [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedSqlFile = (Resolve-Path -LiteralPath $SqlFile -ErrorAction Stop).Path

. (Join-Path $PSScriptRoot 'load-native-windows-env.ps1') -ProjectRoot $projectRoot

$installRootCandidates = @()
if ($InstallRoot) {
  $installRootCandidates += [IO.Path]::GetFullPath($InstallRoot)
}
$installRootCandidates += Split-Path -Parent $projectRoot
if ($env:WORKFLOW_DATA_ROOT) {
  $workflowDataRoot = [IO.Path]::GetFullPath($env:WORKFLOW_DATA_ROOT)
  $workflowDataParent = Split-Path -Parent $workflowDataRoot
  $installRootCandidates += $workflowDataParent
  if ($workflowDataParent) {
    $installRootCandidates += Split-Path -Parent $workflowDataParent
  }
}

$psql = $null
foreach ($candidate in $installRootCandidates | Select-Object -Unique) {
  $candidatePsql = Join-Path $candidate 'runtime\postgres\bin\psql.exe'
  if (Test-Path -LiteralPath $candidatePsql -PathType Leaf) {
    $psql = $candidatePsql
    break
  }
}
if (-not $psql) {
  $pathPsql = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($pathPsql) { $psql = $pathPsql.Source }
}
if (-not $psql) {
  $searchedRoots = ($installRootCandidates | Select-Object -Unique) -join ', '
  throw "Missing native PostgreSQL client; searched install roots: $searchedRoots"
}

& $psql -X -v ON_ERROR_STOP=1 -P pager=off -P null=NULL -f $resolvedSqlFile $env:DATABASE_URL
if ($LASTEXITCODE -ne 0) {
  throw "psql failed with exit code $LASTEXITCODE"
}
