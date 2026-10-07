param(
  [string]$InstallRoot = 'C:\pdd-native',
  [string]$ExtensionId = 'pcopnibgkbdnlaeagepigbboebdfejmb',
  [string]$SourceRoot = '',
  [string]$BrowserExecutable = '',
  [string]$UpdateUrl = 'https://clients2.google.com/service/update2/crx'
)

$ErrorActionPreference = 'Stop'

function Set-NativeEnvironmentValue {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Value
  )

  $lines = [Collections.Generic.List[string]]::new()
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) { $lines.Add($line) }
  $replacement = "$Name=$Value"
  $index = -1
  for ($position = 0; $position -lt $lines.Count; $position += 1) {
    if ($lines[$position].StartsWith("$Name=", [StringComparison]::Ordinal)) {
      $index = $position
      break
    }
  }
  if ($index -ge 0) { $lines[$index] = $replacement } else { $lines.Add($replacement) }
  [IO.File]::WriteAllLines($Path, $lines, [Text.UTF8Encoding]::new($false))
}

function Resolve-ExtensionSource {
  param([string]$RequestedRoot, [string]$RequestedId)

  if ($RequestedRoot) {
    $resolved = (Resolve-Path -LiteralPath $RequestedRoot).Path
    if (-not (Test-Path -LiteralPath (Join-Path $resolved 'manifest.json') -PathType Leaf)) {
      throw "Extension manifest is missing: $resolved"
    }
    return $resolved
  }

  $profileExtensionRoot = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Extensions\$RequestedId"
  if (-not (Test-Path -LiteralPath $profileExtensionRoot -PathType Container)) {
    throw "Chrome extension is not installed in the default profile: $RequestedId"
  }
  $candidates = foreach ($directory in Get-ChildItem -LiteralPath $profileExtensionRoot -Directory) {
    $manifestPath = Join-Path $directory.FullName 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      [PSCustomObject]@{
        Root = $directory.FullName
        Version = [version]$manifest.version
      }
    } catch { }
  }
  $selected = $candidates | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $selected) { throw "No valid installed version found for Chrome extension: $RequestedId" }
  return $selected.Root
}

function Resolve-ExtensionCapableBrowser {
  param([string]$RequestedExecutable)

  if ($RequestedExecutable) {
    $resolved = (Resolve-Path -LiteralPath $RequestedExecutable).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      throw "Browser executable is missing: $resolved"
    }
    return $resolved
  }

  $playwrightRoot = Join-Path $env:LOCALAPPDATA 'ms-playwright'
  $candidates = foreach ($executable in Get-ChildItem -LiteralPath $playwrightRoot `
    -Recurse -File -Filter 'chrome.exe' -ErrorAction SilentlyContinue) {
    if ($executable.FullName -notmatch '\\chromium-\d+\\chrome-win64\\chrome\.exe$') { continue }
    $rawVersion = [string]$executable.VersionInfo.ProductVersion
    if (-not $rawVersion) { $rawVersion = [string]$executable.VersionInfo.FileVersion }
    try {
      [PSCustomObject]@{
        Path = $executable.FullName
        Version = [version]$rawVersion
      }
    } catch { }
  }
  $selected = $candidates | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $selected) {
    throw 'Playwright Chrome for Testing is missing; install the Chromium browser before configuring the extension.'
  }
  return $selected.Path
}

function Set-ChromeForceInstallPolicy {
  param([string]$Id, [string]$Url)

  $policyRoot = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
  $forceList = Join-Path $policyRoot 'ExtensionInstallForcelist'
  New-Item -Path $policyRoot, $forceList -Force | Out-Null

  $forceProperties = Get-ItemProperty -Path $forceList
  $slot = $null
  $highestSlot = 0
  foreach ($property in $forceProperties.PSObject.Properties) {
    if ($property.Name -match '^\d+$') {
      $highestSlot = [Math]::Max($highestSlot, [int]$property.Name)
      if ([string]$property.Value -like "$Id;*") { $slot = $property.Name }
    }
  }
  if (-not $slot) { $slot = [string]($highestSlot + 1) }
  New-ItemProperty -Path $forceList -Name $slot -Value "$Id;$Url" `
    -PropertyType String -Force | Out-Null

  $settings = [ordered]@{}
  $existingSettings = (Get-ItemProperty -Path $policyRoot -Name ExtensionSettings `
    -ErrorAction SilentlyContinue).ExtensionSettings
  if ($existingSettings) {
    try {
      $parsed = $existingSettings | ConvertFrom-Json
      foreach ($property in $parsed.PSObject.Properties) {
        $settings[$property.Name] = $property.Value
      }
    } catch { }
  }
  $settings[$Id] = [ordered]@{
    installation_mode = 'force_installed'
    update_url = $Url
  }
  New-ItemProperty -Path $policyRoot -Name ExtensionSettings `
    -Value ($settings | ConvertTo-Json -Compress -Depth 10) -PropertyType String -Force | Out-Null
}

function Add-NativeMessagingOrigin {
  param([string]$Id)

  $nativeManifestPath = Join-Path $env:LOCALAPPDATA 'IIRPA\RPAChromeExtension\manifest.json'
  if (-not (Test-Path -LiteralPath $nativeManifestPath -PathType Leaf)) { return }
  $manifest = Get-Content -LiteralPath $nativeManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $origin = "chrome-extension://$Id/"
  $allowedOrigins = [Collections.Generic.List[string]]::new()
  foreach ($existingOrigin in @($manifest.allowed_origins)) {
    if ($existingOrigin -and -not $allowedOrigins.Contains([string]$existingOrigin)) {
      $allowedOrigins.Add([string]$existingOrigin)
    }
  }
  if (-not $allowedOrigins.Contains($origin)) { $allowedOrigins.Add($origin) }
  $manifest.allowed_origins = @($allowedOrigins)
  [IO.File]::WriteAllText(
    $nativeManifestPath,
    ($manifest | ConvertTo-Json -Depth 10),
    [Text.UTF8Encoding]::new($false)
  )
}

if ($ExtensionId -notmatch '^[a-p]{32}$') { throw "Invalid Chrome extension ID: $ExtensionId" }
$appRoot = Join-Path $InstallRoot 'app'
$envFile = Join-Path $appRoot '.env.native'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  throw "Native environment file is missing: $envFile"
}

$resolvedSource = Resolve-ExtensionSource -RequestedRoot $SourceRoot -RequestedId $ExtensionId
$sourceManifest = Get-Content -LiteralPath (Join-Path $resolvedSource 'manifest.json') `
  -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $sourceManifest.key) {
  throw 'The extension manifest has no signing key; its unpacked extension ID cannot be kept stable.'
}
$version = [string]$sourceManifest.version
if ($version -notmatch '^[0-9]+(?:\.[0-9]+){1,3}$') { throw "Invalid extension version: $version" }

$permanentRoot = Join-Path $InstallRoot "extensions\permanent\$ExtensionId"
$destinationRoot = Join-Path $permanentRoot $version
if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $resolvedSource '*') -Destination $destinationRoot -Recurse -Force
}
$copiedManifest = Get-Content -LiteralPath (Join-Path $destinationRoot 'manifest.json') `
  -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$copiedManifest.version -ne $version) { throw 'Permanent extension copy validation failed.' }

$resolvedBrowser = Resolve-ExtensionCapableBrowser -RequestedExecutable $BrowserExecutable
$browserVersion = [string](Get-Item -LiteralPath $resolvedBrowser).VersionInfo.ProductVersion
if (-not $browserVersion) {
  $browserVersion = [string](Get-Item -LiteralPath $resolvedBrowser).VersionInfo.FileVersion
}
$permanentBrowserRoot = Join-Path $InstallRoot "runtime\chrome-for-testing\$browserVersion"
$permanentBrowser = Join-Path $permanentBrowserRoot 'chrome.exe'
if (-not (Test-Path -LiteralPath $permanentBrowser -PathType Leaf)) {
  New-Item -ItemType Directory -Path $permanentBrowserRoot -Force | Out-Null
  Copy-Item -Path (Join-Path (Split-Path -Parent $resolvedBrowser) '*') `
    -Destination $permanentBrowserRoot -Recurse -Force
}
if (-not (Test-Path -LiteralPath $permanentBrowser -PathType Leaf)) {
  throw 'Permanent Chrome for Testing copy validation failed.'
}

Set-NativeEnvironmentValue -Path $envFile -Name 'WORKFLOW_BROWSER_EXECUTABLE_PATH' -Value $permanentBrowser
Set-NativeEnvironmentValue -Path $envFile -Name 'WORKFLOW_BROWSER_EXTENSION_PATHS' -Value $destinationRoot
Set-NativeEnvironmentValue -Path $envFile -Name 'WORKFLOW_REQUIRED_EXTENSION_IDS' -Value $ExtensionId
Set-NativeEnvironmentValue -Path $envFile -Name 'WORKFLOW_BROWSER_ALWAYS_LOAD_EXTENSIONS' -Value 'true'
Set-NativeEnvironmentValue -Path $envFile -Name 'WORKFLOW_ALLOW_MANUAL_EXTENSIONS' -Value 'false'
Set-NativeEnvironmentValue -Path $envFile -Name 'WORKFLOW_EXTENSION_STARTUP_TIMEOUT_MS' -Value '60000'
Set-ChromeForceInstallPolicy -Id $ExtensionId -Url $UpdateUrl
Add-NativeMessagingOrigin -Id $ExtensionId

Write-Output "Permanent Chrome extension configured: $ExtensionId $version"
Write-Output "Extension backup: $destinationRoot"
Write-Output "Extension-capable browser: $permanentBrowser ($browserVersion)"
Write-Output "Chrome policy update URL: $UpdateUrl"
Write-Output 'The worker must be restarted before Playwright browsers use the permanent extension configuration.'
