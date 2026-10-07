param(
  [int]$PollSeconds = 2,
  [switch]$RestoreInitialMinimized
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
$workflowRoot = Join-Path $installRoot 'data\workflow'
$workflowShopsRoot = Join-Path $installRoot 'data\workflow\shops'
$verificationFocusLockRoot = Join-Path $workflowRoot 'locks\verification-focus'
$legacyVerificationFocusLockPath = Join-Path $workflowRoot 'locks\verification-focus.lock'
$logRoot = Join-Path $installRoot 'logs'
$logFile = Join-Path $logRoot 'window-keeper.log'
. (Join-Path $PSScriptRoot 'load-native-windows-env.ps1') -ProjectRoot $projectRoot
$autoFocusVerificationValue = [string]$env:WORKFLOW_AUTO_FOCUS_VERIFICATION
if ([string]::IsNullOrWhiteSpace($autoFocusVerificationValue)) { $autoFocusVerificationValue = 'true' }
$autoFocusVerification = @('1', 'true', 'yes', 'on') -contains $autoFocusVerificationValue.Trim().ToLowerInvariant()
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public static class PddWindowTools {
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public sealed class WindowSnapshot {
    public IntPtr Handle;
    public uint ProcessId;
    public string Title;
    public string ClassName;
    public bool Visible;
    public bool Minimized;
    public Rect Bounds;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr window);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr window);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern int GetClassName(IntPtr window, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr window, out Rect rect);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr window, int command);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(
    IntPtr window,
    IntPtr insertAfter,
    int x,
    int y,
    int width,
    int height,
    uint flags
  );

  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);

  public static WindowSnapshot[] SnapshotWindows() {
    var windows = new List<WindowSnapshot>();
    EnumWindows((window, state) => {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      var title = new StringBuilder(1024);
      var className = new StringBuilder(256);
      Rect bounds;
      GetWindowText(window, title, title.Capacity);
      GetClassName(window, className, className.Capacity);
      GetWindowRect(window, out bounds);
      windows.Add(new WindowSnapshot {
        Handle = window,
        ProcessId = processId,
        Title = title.ToString(),
        ClassName = className.ToString(),
        Visible = IsWindowVisible(window),
        Minimized = IsIconic(window),
        Bounds = bounds
      });
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@

$lastEmptyLogAt = [datetime]::MinValue
$lastFocusRestoreLogAt = [datetime]::MinValue
$seenWindowHandles = [Collections.Generic.HashSet[long]]::new()
$lastVerificationFocusKeys = @{}
$lastAllowedForegroundHandle = [PddWindowTools]::GetForegroundWindow()

function Write-WindowKeeperLog {
  param([Parameter(Mandatory)][string]$Message)
  "$(Get-Date -Format o) $Message" | Add-Content -LiteralPath $logFile -Encoding UTF8
}

function Get-WorkerBrowserWindows {
  $windows = [Collections.Generic.List[object]]::new()
  $desktopWindows = @([PddWindowTools]::SnapshotWindows())
  $chromeProcesses = @{}
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue)) {
    $chromeProcesses[[uint32]$process.ProcessId] = $process
  }
  foreach ($desktopWindow in $desktopWindows) {
    $processId = $desktopWindow.ProcessId
    if (-not $processId) { continue }

    $process = $chromeProcesses[$processId]
    if (-not $process) { continue }
    $commandLine = [string]$process.CommandLine
    if ($commandLine.IndexOf($workflowShopsRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $commandLine.IndexOf('browser-profile', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      continue
    }

    if ($desktopWindow.ClassName -eq 'Chrome_WidgetWin_0') {
      if ($desktopWindow.Visible) { [void][PddWindowTools]::ShowWindow($desktopWindow.Handle, 0) }
      continue
    }
    if ($desktopWindow.ClassName -ne 'Chrome_WidgetWin_1' -or
        [string]::IsNullOrWhiteSpace($desktopWindow.Title)) {
      continue
    }

    $profileMatch = [regex]::Match($commandLine, 'shops\\([^\\]+)\\browser-profile', 'IgnoreCase')
    $windows.Add([pscustomobject]@{
      Handle = $desktopWindow.Handle
      HandleValue = $desktopWindow.Handle.ToInt64()
      ProcessId = $processId
      ShopId = if ($profileMatch.Success) { $profileMatch.Groups[1].Value } else { 'unknown' }
      Title = $desktopWindow.Title
      Visible = $desktopWindow.Visible
      Minimized = $desktopWindow.Minimized
      Rect = $desktopWindow.Bounds
    })
  }
  return [pscustomobject]@{
    DesktopWindowCount = $desktopWindows.Count
    WorkerBrowserWindows = $windows
  }
}

function Read-JsonFile {
  param([Parameter(Mandatory)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-ShopWaitingForVerification {
  param(
    [Parameter(Mandatory)][string]$ShopId,
    [AllowNull()][string]$FocusOwner
  )

  $progressPath = Join-Path $workflowShopsRoot "$ShopId\state\workflow-progress.json"
  $progress = Read-JsonFile -Path $progressPath
  if (-not $progress) { return $false }
  if ([string]$progress.verificationFocus.status -eq 'waiting') { return $true }
  return [string]$progress.step -in @('human-verification-required', 'manual-login-required') -and
    -not [string]::IsNullOrWhiteSpace($FocusOwner) -and $FocusOwner -ne $ShopId
}

function Get-VerificationFocusOwner {
  param([AllowNull()][string]$ShopId)

  # Each shop has an isolated Chromium window, so verification focus is also
  # isolated. Keep accepting the legacy global lock while old workers drain.
  $paths = [Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($ShopId)) {
    $safeShopId = [regex]::Replace($ShopId, '[^a-z0-9_-]+', '_')
    [void]$paths.Add((Join-Path $verificationFocusLockRoot "$safeShopId.lock"))
  }
  [void]$paths.Add($legacyVerificationFocusLockPath)
  foreach ($path in $paths) {
    $owner = Read-JsonFile -Path $path
    if (-not $owner -or [string]::IsNullOrWhiteSpace([string]$owner.shopId)) { continue }
    $heartbeatAt = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$owner.heartbeatAt, [ref]$heartbeatAt)) { continue }
    if ((Get-Date).ToUniversalTime() - $heartbeatAt.ToUniversalTime() -gt [timespan]::FromSeconds(15)) { continue }
    if ([string]::IsNullOrWhiteSpace($ShopId) -or [string]$owner.shopId -eq $ShopId) {
      return [string]$owner.shopId
    }
  }
  return $null
}

function Test-ShopNeedsVerificationFocus {
  param(
    [Parameter(Mandatory)][string]$ShopId,
    [AllowNull()][string]$VerificationFocusOwner
  )

  if ([string]::IsNullOrWhiteSpace($VerificationFocusOwner) -or
      $VerificationFocusOwner -ne $ShopId) {
    return $false
  }
  $progressPath = Join-Path $workflowShopsRoot "$ShopId\state\workflow-progress.json"
  $progress = Read-JsonFile -Path $progressPath
  if (-not $progress) { return $false }
  $focusStatus = [string]$progress.verificationFocus.status
  if ($focusStatus -ne 'active' -and $script:autoFocusVerification -ne $true) { return $false }
  $step = [string]$progress.step
  if ($step -eq 'manual-login-required') {
    # Login progress intentionally has no verificationLocation. The active
    # focus lease is the authoritative signal for the operator login page.
    return $focusStatus -eq 'active'
  }
  return $step -eq 'human-verification-required' -and
    -not [string]::IsNullOrWhiteSpace([string]$progress.verificationLocation.system)
}

function Test-ShopPopupFocusSuppressed {
  param([Parameter(Mandatory)][string]$ShopId)

  $suppressionPath = Join-Path $workflowRoot "locks\background-popup-focus-$ShopId.json"
  $suppression = Read-JsonFile -Path $suppressionPath
  if (-not $suppression) { return $false }
  try {
    return [string]$suppression.shopId -eq $ShopId -and
      [DateTimeOffset]::Parse([string]$suppression.expiresAt) -gt [DateTimeOffset]::Now
  } catch {
    return $false
  }
}

function Restore-WorkerBrowserWindow {
  param(
    [Parameter(Mandatory)]$Window,
    [AllowNull()][string]$VerificationFocusOwner,
    [switch]$InitialObservation
  )

  $virtualLeft = [PddWindowTools]::GetSystemMetrics(76)
  $virtualTop = [PddWindowTools]::GetSystemMetrics(77)
  $virtualWidth = [PddWindowTools]::GetSystemMetrics(78)
  $virtualHeight = [PddWindowTools]::GetSystemMetrics(79)
  $virtualRight = $virtualLeft + $virtualWidth
  $virtualBottom = $virtualTop + $virtualHeight
  $rect = $Window.Rect
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $offScreen = $width -lt 320 -or $height -lt 240 -or
    $rect.Right -le $virtualLeft -or $rect.Left -ge $virtualRight -or
    $rect.Bottom -le $virtualTop -or $rect.Top -ge $virtualBottom
  $needsRestore = -not $Window.Visible -or $Window.Minimized -or $offScreen
  $needsFocus = Test-ShopNeedsVerificationFocus `
    -ShopId $Window.ShopId `
    -VerificationFocusOwner $VerificationFocusOwner

  # Keep resident automation browsers parked in the taskbar. Only the shop
  # holding the verification/login focus lock is restored for operator input.
  # This also collapses the initial set of overlapping windows at task start;
  # a browser explicitly opened from the owner UI is left alone afterwards.
  # Keep the native window exactly as the operator left it. Window focus and
  # tab selection are handled by workflow.mjs through CDP.

  $focusKey = if ($needsFocus) { "$($Window.ShopId):$($Window.HandleValue)" } else { $null }
  $minimumOperatorWidth = [Math]::Max(800, [Math]::Floor($virtualWidth * 0.8))
  $minimumOperatorHeight = [Math]::Max(600, [Math]::Floor($virtualHeight * 0.8))
  $operatorWindowTooSmall = $needsFocus -and (
    $width -lt $minimumOperatorWidth -or $height -lt $minimumOperatorHeight
  )
  $needsVerificationFocus = $focusKey -and (
    $focusKey -ne $script:lastVerificationFocusKeys[$Window.ShopId] -or
    $Window.Minimized -or -not $Window.Visible -or $offScreen -or $operatorWindowTooSmall
  )
  if (-not $needsRestore -and -not $needsVerificationFocus) { return }

  if ($InitialObservation) {
    Write-WindowKeeperLog "observed without native window mutation shop=$($Window.ShopId) pid=$($Window.ProcessId) handle=$($Window.HandleValue) title=$($Window.Title)"
  }
}

function Restore-AllowedForegroundWindow {
  param(
    [Parameter(Mandatory)]$ForegroundWorker,
    [AllowNull()][string]$FocusOwner,
    [string]$Reason = 'queued-verification'
  )

  # Do not manipulate the Windows foreground. A browser tab can be activated
  # inside its Chromium session while the operator keeps the current desktop
  # window. Returning false leaves the foreground untouched.
  if ((Get-Date) -gt $script:lastFocusRestoreLogAt.AddSeconds(5)) {
    Write-WindowKeeperLog "foreground unchanged reason=$Reason shop=$($ForegroundWorker.ShopId) owner=$FocusOwner"
    $script:lastFocusRestoreLogAt = Get-Date
  }
  return $false
}

Write-WindowKeeperLog "started session=$((Get-Process -Id $PID).SessionId)"
while ($true) {
  try {
    $snapshot = Get-WorkerBrowserWindows
    $verificationFocusOwners = @{}
    foreach ($candidate in @($snapshot.WorkerBrowserWindows)) {
      $owner = Get-VerificationFocusOwner -ShopId $candidate.ShopId
      if ($owner) { $verificationFocusOwners[$candidate.ShopId] = $owner }
    }
    foreach ($seenShopId in @($script:lastVerificationFocusKeys.Keys)) {
      if (-not $verificationFocusOwners.ContainsKey($seenShopId)) {
        $script:lastVerificationFocusKeys.Remove($seenShopId)
      }
    }
    foreach ($window in @($snapshot.WorkerBrowserWindows)) {
      $initialObservation = $seenWindowHandles.Add([long]$window.HandleValue)
      $verificationFocusOwner = $verificationFocusOwners[$window.ShopId]
      Restore-WorkerBrowserWindow `
        -Window $window `
        -VerificationFocusOwner $verificationFocusOwner `
        -InitialObservation:$initialObservation
    }
    $foregroundHandle = [PddWindowTools]::GetForegroundWindow()
    $foregroundWorker = @($snapshot.WorkerBrowserWindows | Where-Object {
      [long]$_.HandleValue -eq $foregroundHandle.ToInt64()
    } | Select-Object -First 1)
    $queuedVerificationFocus = $foregroundWorker.Count -gt 0 -and
      $verificationFocusOwners.Count -gt 0 -and
      -not $verificationFocusOwners.ContainsKey($foregroundWorker[0].ShopId) -and
      (Test-ShopWaitingForVerification `
        -ShopId $foregroundWorker[0].ShopId `
        -FocusOwner ($verificationFocusOwners.Values -join ','))
    $backgroundPopupFocus = $foregroundWorker.Count -gt 0 -and
      $verificationFocusOwners.Count -gt 0 -and
      -not $verificationFocusOwners.ContainsKey($foregroundWorker[0].ShopId) -and
      (Test-ShopPopupFocusSuppressed -ShopId $foregroundWorker[0].ShopId)
    if ($queuedVerificationFocus -or $backgroundPopupFocus) {
      $focusBlockReason = if ($backgroundPopupFocus) { 'background-popup' } else { 'queued-verification' }
      [void](Restore-AllowedForegroundWindow `
        -ForegroundWorker $foregroundWorker[0] `
        -FocusOwner ($verificationFocusOwners.Values -join ',') `
        -Reason $focusBlockReason)
    } elseif ($foregroundHandle -ne [IntPtr]::Zero) {
      $lastAllowedForegroundHandle = $foregroundHandle
    }
    if (-not $snapshot.WorkerBrowserWindows.Count -and
        (Get-Date) -gt $lastEmptyLogAt.AddSeconds(30)) {
      $chromeRoots = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'chrome.exe' -and
        ([string]$_.CommandLine).IndexOf($workflowShopsRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        ([string]$_.CommandLine).IndexOf('--type=', [StringComparison]::OrdinalIgnoreCase) -lt 0
      })
      Write-WindowKeeperLog "no worker windows; desktopWindows=$($snapshot.DesktopWindowCount) chromeRoots=$($chromeRoots.Count)"
      $lastEmptyLogAt = Get-Date
    }
  } catch {
    Write-WindowKeeperLog "scan failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
}
