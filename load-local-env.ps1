$ErrorActionPreference = 'Stop'
$localRoot = $PSScriptRoot
$localApp = Join-Path $localRoot 'app'
# Use the same parser and secret-file mappings as the native server.
. (Join-Path $localApp 'scripts\load-native-windows-env.ps1') -ProjectRoot $localApp

if (-not $env:DATABASE_URL) { throw 'DATABASE_URL is missing from app\.env.native.' }
$localDb = [UriBuilder]::new($env:DATABASE_URL)
$localDb.Host = '127.0.0.1'
$localDb.Port = 5433
$env:DATABASE_URL = $localDb.Uri.AbsoluteUri
$env:DATA_BACKEND = 'postgres'
$env:WORKER_DATA_BACKEND = 'postgres'
$env:DEPLOYMENT_PLATFORM = 'Windows Native'
$env:WORKFLOW_DATA_ROOT = Join-Path $localRoot 'data\workflow'
$env:WORKER_HEARTBEAT_FILE = Join-Path $env:WORKFLOW_DATA_ROOT 'supervisor\worker-heartbeat.json'
$env:PDD_AUTOMATION_START_SCRIPT = Join-Path $localRoot 'start-local-worker.ps1'
$env:PDD_AUTOMATION_STOP_SCRIPT = Join-Path $localRoot 'stop-local-worker.ps1'
$env:API_HOST = '127.0.0.1'
$env:API_PORT = '3000'
$env:API_BASE_URL = 'http://127.0.0.1:3000'
$env:WORKER_SYNC_API_URL = $env:API_BASE_URL
$env:WEB_HOST = '0.0.0.0'
$env:WEB_PORT = '5148'
$env:PUBLIC_WEB_HOST = '0.0.0.0'
$env:PUBLIC_WEB_PORT = '5145'
$env:WEB_TLS_PEM_FILE = Join-Path $localRoot 'https\self-signed\server.pem'
$env:PUBLIC_WEB_EXTRA_PORTS = ''
$env:OWNER_ENTRY_CONCEALED = 'true'
$env:OWNER_ALLOWED_ORIGINS = 'http://183.214.198.74:5148,http://10.10.12.188:5148,http://127.0.0.1:5148,http://localhost:5148,https://183.214.198.74:5148,https://10.10.12.188:5148,https://127.0.0.1:5148,https://localhost:5148'
$env:COOKIE_SECURE = 'false'
$env:DASHBOARD_PUBLIC_URL = 'http://183.214.198.74:5148'
$env:DINGTALK_DAILY_SUMMARY_ONLY = 'true'
$env:WORKFLOW_BROWSER_MODE = 'headed'
$env:WORKFLOW_BROWSER_EXECUTABLE_PATH = Join-Path $localRoot 'runtime\chrome-for-testing\151.0.7922.34\chrome.exe'
# Bypass Windows proxy settings only for this project's browsers.
$env:WORKFLOW_BROWSER_PROXY_FORCE_DIRECT = 'true'
$env:WORKFLOW_BROWSER_PROXY_REQUIRED = 'false'
foreach ($localProxyKey in @('WORKFLOW_BROWSER_PROXY_SERVER', 'WORKFLOW_BROWSER_PROXY_USERNAME',
    'WORKFLOW_BROWSER_PROXY_PASSWORD', 'WORKFLOW_BROWSER_PROXY_USERNAME_FILE', 'WORKFLOW_BROWSER_PROXY_PASSWORD_FILE')) {
    [Environment]::SetEnvironmentVariable($localProxyKey, $null, 'Process')
}
