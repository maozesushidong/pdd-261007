param([string]$CaddyRoot = 'D:\pdd-native\caddy')

$ErrorActionPreference = 'Stop'
$caddyPath = Join-Path $CaddyRoot 'caddy.exe'
$configPath = Join-Path $CaddyRoot 'Caddyfile'
if (-not (Test-Path -LiteralPath $caddyPath)) { throw "Caddy executable not found: $caddyPath" }
if (-not (Test-Path -LiteralPath $configPath)) { throw "Caddy config not found: $configPath" }

$env:XDG_DATA_HOME = Join-Path $CaddyRoot 'data'
$env:XDG_CONFIG_HOME = Join-Path $CaddyRoot 'config'
New-Item -ItemType Directory -Force -Path $env:XDG_DATA_HOME, $env:XDG_CONFIG_HOME | Out-Null

& $caddyPath run --config $configPath --adapter caddyfile
exit $LASTEXITCODE
