param([string]$InstallRoot = 'C:\pdd-native')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionId = 'pcopnibgkbdnlaeagepigbboebdfejmb'
$extensionVersion = '4.0.1.246'
$sourceRoot = Join-Path $projectRoot "vendor\chrome-extension\$extensionId\$extensionVersion"
$installer = Join-Path $PSScriptRoot 'install-permanent-chrome-extension.ps1'
$environmentLoader = Join-Path $PSScriptRoot 'load-native-windows-env.ps1'
$smokeTest = Join-Path $PSScriptRoot 'chrome-extension-smoke-test.mjs'

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'manifest.json') -PathType Leaf)) {
  throw "Bundled Chrome extension is incomplete: $sourceRoot"
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Extension installer is missing: $installer"
}
if (-not (Test-Path -LiteralPath $environmentLoader -PathType Leaf)) {
  throw "Native environment loader is missing: $environmentLoader"
}
if (-not (Test-Path -LiteralPath $smokeTest -PathType Leaf)) {
  throw "Chrome extension smoke test is missing: $smokeTest"
}

. $environmentLoader -ProjectRoot $projectRoot
$browserExecutable = [string]$env:WORKFLOW_BROWSER_EXECUTABLE_PATH
if (-not $browserExecutable.Trim()) {
  throw 'WORKFLOW_BROWSER_EXECUTABLE_PATH must identify the production Chrome before installing the extension.'
}

& $installer `
  -InstallRoot $InstallRoot `
  -ExtensionId $extensionId `
  -SourceRoot $sourceRoot `
  -BrowserExecutable $browserExecutable

# The installer persists permanent paths in .env.native. Reload them before
# validating the exact Chrome and extension copies that the Worker will use.
. $environmentLoader -ProjectRoot $projectRoot
$installedExtensionRoot = [string]$env:WORKFLOW_BROWSER_EXTENSION_PATHS
$installedBrowser = [string]$env:WORKFLOW_BROWSER_EXECUTABLE_PATH
$nodeExecutable = Join-Path $InstallRoot 'runtime\node\node.exe'

if (-not $installedExtensionRoot.Trim() -or
    -not (Test-Path -LiteralPath (Join-Path $installedExtensionRoot 'manifest.json') -PathType Leaf)) {
  throw "Installed Chrome extension is incomplete: $installedExtensionRoot"
}
if (-not $installedBrowser.Trim() -or
    -not (Test-Path -LiteralPath $installedBrowser -PathType Leaf)) {
  throw "Installed extension-capable Chrome is missing: $installedBrowser"
}
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  throw "Packaged Node.js runtime is missing: $nodeExecutable"
}

& $nodeExecutable $smokeTest $installedExtensionRoot $extensionId $installedBrowser
if ($LASTEXITCODE -ne 0) {
  throw "Chrome extension smoke test failed with exit code $LASTEXITCODE"
}

Write-Output "Bundled extension installed from repository: $extensionId $extensionVersion"
