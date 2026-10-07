param(
  [Parameter(Mandatory)]
  [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $ProjectRoot '.env.native'
if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Missing native environment file: $envFile"
}

foreach ($rawLine in Get-Content -LiteralPath $envFile -Encoding UTF8) {
  $line = $rawLine.Trim()
  if (-not $line -or $line.StartsWith('#')) { continue }
  $separator = $line.IndexOf('=')
  if ($separator -lt 1) { continue }
  $name = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

$secretDirectory = Join-Path $ProjectRoot 'secrets\staging'
foreach ($secretName in @(
  'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'OWNER_PASSWORD', 'OWNER_SESSION_SECRET',
  'OWNER_INITIAL_PASSWORD', 'WORKER_INGEST_TOKEN', 'DINGTALK_WEBHOOK',
  'DINGTALK_SIGNING_SECRET', 'DINGTALK_RECIPIENTS',
  'DINGTALK_RETURN_REFUND_RECIPIENTS', 'PDD_HEALTHCARE_ACCOUNT',
  'PDD_HEALTHCARE_PASSWORD', 'PDD_MEDICAL_DEVICE_ACCOUNT',
  'PDD_MEDICAL_DEVICE_PASSWORD', 'PDD_SONGTENG_YAZC_ACCOUNT',
  'PDD_SONGTENG_YAZC_PASSWORD', 'JEOMS_ACCOUNT', 'JEOMS_PASSWORD',
  'TMS_ACCOUNT', 'TMS_PASSWORD', 'WORKFLOW_BROWSER_PROXY_USERNAME',
  'WORKFLOW_BROWSER_PROXY_PASSWORD'
)) {
  $secretPath = Join-Path $secretDirectory $secretName
  if (Test-Path -LiteralPath $secretPath) {
    [Environment]::SetEnvironmentVariable("${secretName}_FILE", $secretPath, 'Process')
  }
}

$env:DEPLOYMENT_PLATFORM = 'Windows Native'
$env:WORKFLOW_SECRETS_DIR = $secretDirectory
