param(
  [ValidateRange(10, 300)]
  [int]$DrainTimeoutSeconds = 45,
  [ValidateRange(5, 120)]
  [int]$ForceTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
$runtimeRoot = Join-Path $installRoot 'runtime'
$dataRoot = Join-Path $installRoot 'data'
$workflowRoot = Join-Path $installRoot 'data\workflow'
$shopProfileRoot = Join-Path $installRoot 'data\workflow\shops'
$consoleProfileRoot = Join-Path $installRoot 'data\console-browser-profile'
$node = Join-Path $runtimeRoot 'node\node.exe'
$drainScript = Join-Path $projectRoot 'scripts\worker-maintenance-drain.mjs'
$stopStartedAt = Get-Date
$stopTaskNames = @(
  'PDD Native Worker',
  'PDD Native Browser Launcher',
  'PDD Native Window Keeper',
  'PDD Native Sync',
  'PDD Native Notifier',
  'PDD Native ExtensionServer',
  'PDD Verification Desktop Notifier'
)

function Get-NativeTasks {
  @(
    foreach ($taskName in $stopTaskNames) {
      Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
  )
}

function Invoke-MaintenanceDrain {
  param([ValidateSet('enable', 'disable')][string]$Mode)
  if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or
      -not (Test-Path -LiteralPath $drainScript -PathType Leaf)) {
    throw 'Native Node or maintenance drain script is missing.'
  }
  Push-Location -LiteralPath $projectRoot
  try {
    & $node $drainScript "--$Mode" | ForEach-Object { Write-Output "[drain] $_" }
    if ($LASTEXITCODE -ne 0) { throw "Maintenance drain $Mode failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

function Get-ManagedProcesses {
  $runtime = $runtimeRoot.Replace('/', '\').TrimEnd('\')
  $project = $projectRoot.Replace('/', '\').TrimEnd('\')
  $shopProfiles = $shopProfileRoot.Replace('/', '\').TrimEnd('\')
  $consoleProfile = $consoleProfileRoot.Replace('/', '\').TrimEnd('\')
  @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      if ([int]$_.ProcessId -eq $PID) { return $false }
      $executablePath = [string]$_.ExecutablePath
      $commandLine = ([string]$_.CommandLine).Replace('/', '\')
      if ($commandLine -match '(?i)stop-native-windows\.ps1') { return $false }
      $workerProcess = $commandLine -match '(?i)(apps\\worker\\src\\main\.mjs|apps\\worker\\src\\dynamic-supervisor\.mjs|run-shops\.mjs|dingtalk-dispatcher\.mjs|sync-windows-worker-state\.mjs|native-extension-update-server\.mjs)'
      $lifecycleProcess = $commandLine -match '(?i)(run-native-windows-browser-launcher\.ps1|restore-native-worker-windows\.ps1|watch-verification-alerts\.ps1|run-native-windows-component\.ps1.*-Component (Worker|Sync|Notifier|ExtensionServer))'
      ($workerProcess -or $lifecycleProcess) -or
        ($_.Name -in @('chrome.exe', 'msedge.exe') -and
          $commandLine.IndexOf($shopProfiles, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
  )
}

function Get-ProcessTreeIds {
  param([Parameter(Mandatory)][int]$RootProcessId, [Parameter(Mandatory)][object[]]$Processes)
  $ordered = [System.Collections.Generic.List[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $queue.Enqueue($RootProcessId)
  while ($queue.Count -gt 0) {
    $processId = $queue.Dequeue()
    if (-not $seen.Add($processId)) { continue }
    $ordered.Add($processId)
    foreach ($child in $Processes) {
      if ([int]$child.ParentProcessId -eq $processId) { $queue.Enqueue([int]$child.ProcessId) }
    }
  }
  return $ordered.ToArray()
}

function Stop-ManagedProcessTrees {
  param([switch]$Force)
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $managed = @(Get-ManagedProcesses)
  if (-not $managed.Count) { return 0 }
  $managedIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($process in $managed) { [void]$managedIds.Add([int]$process.ProcessId) }
  $roots = @($managed | Where-Object { -not $managedIds.Contains([int]$_.ParentProcessId) })
  foreach ($root in $roots) {
    $tree = @(Get-ProcessTreeIds -RootProcessId ([int]$root.ProcessId) -Processes $processes)
    for ($index = $tree.Count - 1; $index -ge 0; $index -= 1) {
      if ($Force) {
        $process = $processes | Where-Object { [int]$_.ProcessId -eq $tree[$index] } | Select-Object -First 1
        if ($process -and $process.ProcessId) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
      } else {
        Stop-Process -Id $tree[$index] -ErrorAction SilentlyContinue
      }
    }
  }
  return $managed.Count
}

Write-Output 'PDD native stop requested.'
Write-Output 'Enabling maintenance drain so no new work order is claimed.'
try { Invoke-MaintenanceDrain -Mode enable } catch { Write-Warning $_.Exception.Message }

$tasks = @(Get-NativeTasks)
# Disable first: this prevents an AtLogOn/RestartCount task from immediately
# recreating a process while the stop operation is draining it.
foreach ($task in $tasks) {
  Disable-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue | Out-Null
}
foreach ($task in $tasks) {
  Stop-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue
}
Write-Output "Stopped and disabled $($tasks.Count) native scheduled task(s)."

$deadline = (Get-Date).AddSeconds($DrainTimeoutSeconds)
do {
  $remaining = @(Get-ManagedProcesses)
  if (-not $remaining.Count) { break }
  Write-Output "Waiting for $($remaining.Count) managed process(es) to exit..."
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

$remaining = @(Get-ManagedProcesses)
if ($remaining.Count) {
  Write-Warning "Graceful stop timed out; cleaning $($remaining.Count) project process(es)."
  Stop-ManagedProcessTrees -Force | Out-Null
  $forceDeadline = (Get-Date).AddSeconds($ForceTimeoutSeconds)
  do {
    $remaining = @(Get-ManagedProcesses)
    if (-not $remaining.Count) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $forceDeadline)
}

if ((Get-ManagedProcesses).Count) {
  throw 'Some PDD native processes are still running; inspect the process list before starting again.'
}
$elapsed = [Math]::Round(((Get-Date) - $stopStartedAt).TotalSeconds, 1)
Write-Output "PDD backend processing stopped in ${elapsed}s; PostgreSQL, API, Web, MinIO and public gateway remained online. Data and browser profiles were preserved."
