param([switch]$PassThru)

$ErrorActionPreference = 'Stop'

$configuredPath = [string]$env:WORKFLOW_BROWSER_EXECUTABLE_PATH
$preferConfiguredPath = $configuredPath.Trim() -and
  [string]$env:WORKFLOW_BROWSER_EXTENSION_PATHS -and
  ([string]$env:WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS).Trim().ToLowerInvariant() -eq 'true'
$registryPaths = @(
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
  'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
)
$candidates = [Collections.Generic.List[string]]::new()
if ($preferConfiguredPath) { $candidates.Add($configuredPath.Trim()) }
foreach ($registryPath in $registryPaths) {
  $registeredPath = (Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue).'(default)'
  if ($registeredPath) { $candidates.Add([string]$registeredPath) }
}
$candidates.Add((Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'))
if (${env:ProgramFiles(x86)}) {
  $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'))
}
if ($env:LOCALAPPDATA) {
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))
}
if ($configuredPath.Trim() -and -not $preferConfiguredPath) { $candidates.Add($configuredPath.Trim()) }

$chromePath = $candidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
  Select-Object -First 1
if (-not $chromePath) { throw 'chrome-not-installed' }

$chrome = Get-Item -LiteralPath $chromePath
$version = [string]$chrome.VersionInfo.ProductVersion
if (-not $version) { $version = [string]$chrome.VersionInfo.FileVersion }
if (-not $version) { throw 'chrome-version-unavailable' }

$env:WORKFLOW_BROWSER_EXECUTABLE_PATH = $chrome.FullName
$env:WORKFLOW_EXPECTED_BROWSER_VERSION = $version
if ([string]$env:WORKFLOW_REQUIRED_EXTENSION_IDS) {
  $env:WORKFLOW_ALLOW_MANUAL_EXTENSIONS = 'false'
} else {
  $env:WORKFLOW_ALLOW_MANUAL_EXTENSIONS = 'true'
}

if ($PassThru) {
  [pscustomobject]@{
    Path = $chrome.FullName
    Version = $version
    ManualExtensionsAllowed = $env:WORKFLOW_ALLOW_MANUAL_EXTENSIONS -eq 'true'
  }
}
