param(
  [Parameter(Mandatory)]
  [ValidateSet('MinIO', 'ExtensionServer', 'Api', 'Web', 'Notifier', 'Sync', 'Worker')]
  [string]$Component
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Split-Path -Parent $projectRoot
$runtimeRoot = Join-Path $installRoot 'runtime'
$dataRoot = Join-Path $installRoot 'data'
$logRoot = Join-Path $installRoot 'logs'
$node = Join-Path $runtimeRoot 'node\node.exe'
$minio = Join-Path $runtimeRoot 'minio\minio.exe'

. (Join-Path $PSScriptRoot 'load-native-windows-env.ps1') -ProjectRoot $projectRoot
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$logFile = Join-Path $logRoot ("{0}.log" -f $Component.ToLowerInvariant())
Set-Location -LiteralPath $projectRoot

function Wait-TcpPort {
  param([int]$Port, [int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
      $task = $client.ConnectAsync('127.0.0.1', $Port)
      if ($task.Wait(1000) -and $client.Connected) { return }
    } catch { } finally { $client.Dispose() }
    Start-Sleep -Seconds 2
  }
  throw "Timed out waiting for localhost TCP port $Port"
}

function Get-NativeProcessTreeIds {
  param(
    [Parameter(Mandatory)][int]$RootProcessId,
    [Parameter(Mandatory)][object[]]$Processes
  )

  $ordered = [System.Collections.Generic.List[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $queue.Enqueue($RootProcessId)
  while ($queue.Count -gt 0) {
    $processId = $queue.Dequeue()
    if (-not $seen.Add($processId)) { continue }
    $ordered.Add($processId)
    foreach ($child in $Processes) {
      if ([int]$child.ParentProcessId -eq $processId) {
        $queue.Enqueue([int]$child.ProcessId)
      }
    }
  }
  return $ordered.ToArray()
}

function Get-StaleNativeWorkerRoots {
  param([Parameter(Mandatory)][object[]]$Processes)

  $nodePath = [IO.Path]::GetFullPath($node)
  return @($Processes | Where-Object {
    $executablePath = [string]$_.ExecutablePath
    $commandLine = ([string]$_.CommandLine).Replace('/', '\')
    $executablePath.Equals($nodePath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine -match '(?i)(^|[\s"])apps\\worker\\src\\main\.mjs(?=$|[\s"])'
  })
}

function Stop-StaleNativeWorkerProcessTrees {
  # Task Scheduler can terminate its PowerShell host without terminating Node
  # descendants. Clear only orphaned workers from this native installation
  # before starting the replacement instance.
  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    $processes = @(Get-CimInstance Win32_Process)
    $roots = @(Get-StaleNativeWorkerRoots -Processes $processes)
    if (-not $roots.Count) { return }

    foreach ($rootProcess in $roots) {
      $treeIds = @(Get-NativeProcessTreeIds -RootProcessId $rootProcess.ProcessId -Processes $processes)
      for ($index = $treeIds.Count - 1; $index -ge 0; $index -= 1) {
        Stop-Process -Id $treeIds[$index] -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Seconds 1
  }

  $remaining = @(Get-StaleNativeWorkerRoots -Processes @(Get-CimInstance Win32_Process))
  if ($remaining.Count) {
    throw "Unable to stop stale native Worker process tree(s): $($remaining.ProcessId -join ', ')"
  }
}

function Stop-NativeLoginBrowserHosts {
  $nodePath = [IO.Path]::GetFullPath($node)
  $loginHosts = @(Get-CimInstance Win32_Process | Where-Object {
    $executablePath = [string]$_.ExecutablePath
    $commandLine = ([string]$_.CommandLine).Replace('/', '\')
    $executablePath.Equals($nodePath, [StringComparison]::OrdinalIgnoreCase) -and
      $commandLine -match '(?i)(?:^|[\\\s"])scripts\\run-native-windows-shop-browser\.mjs(?=$|[\s"])'
  })
  if (-not $loginHosts.Count) { return }

  $workflowDataRoot = if ($env:WORKFLOW_DATA_ROOT) {
    [IO.Path]::GetFullPath($env:WORKFLOW_DATA_ROOT)
  } else {
    Join-Path $dataRoot 'workflow'
  }
  $controlRoot = Join-Path $workflowDataRoot 'supervisor\browser-login-control'
  $stopRequest = Join-Path $controlRoot 'stop-all.json'
  New-Item -ItemType Directory -Force -Path $controlRoot | Out-Null
  [ordered]@{
    requestedAt = (Get-Date).ToUniversalTime().ToString('o')
    reason = 'worker-profile-handoff'
  } | ConvertTo-Json | Set-Content -LiteralPath $stopRequest -Encoding UTF8

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $runningIds = @(Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId)
    if (-not @($loginHosts | Where-Object { $runningIds -contains $_.ProcessId }).Count) {
      Start-Sleep -Milliseconds 750
      return
    }
    Start-Sleep -Milliseconds 500
  }

  # A hung page must not keep the profile locked indefinitely. The fallback is
  # scoped to the known login-host process trees and never deletes profile data.
  $processes = @(Get-CimInstance Win32_Process)
  foreach ($loginHost in $loginHosts) {
    $treeIds = @(Get-NativeProcessTreeIds -RootProcessId $loginHost.ProcessId -Processes $processes)
    for ($index = $treeIds.Count - 1; $index -ge 0; $index -= 1) {
      Stop-Process -Id $treeIds[$index] -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 1
}

function Invoke-LoggedNativeProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory)][string]$Destination
  )
  $logDirectory = Split-Path -Parent $Destination
  $logName = [IO.Path]::GetFileNameWithoutExtension($Destination)
  $stdoutFile = Join-Path $logDirectory ("{0}.stdout.log" -f $logName)
  $stderrFile = Join-Path $logDirectory ("{0}.stderr.log" -f $logName)

  # PowerShell pipelines retain excessive memory for some long-running native
  # processes. Let Windows redirect both streams directly to files instead.
  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  $exitCode = $process.ExitCode
  if ($exitCode -ne 0) { throw "$FilePath exited with code $exitCode" }
}

function Invoke-RestartingNativeProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory)][string]$Destination
  )
  $restartDelaySeconds = 5
  while ($true) {
    try {
      Invoke-LoggedNativeProcess -FilePath $FilePath -Destination $Destination `
        -ArgumentList $ArgumentList
      throw "$FilePath exited unexpectedly with code 0"
    } catch {
      "$(Get-Date -Format o) $Component child exited; restarting in $restartDelaySeconds seconds`r`n$($_ | Out-String)" |
        Add-Content -LiteralPath $Destination -Encoding UTF8
      Start-Sleep -Seconds $restartDelaySeconds
      $restartDelaySeconds = [Math]::Min(60, $restartDelaySeconds * 2)
    }
  }
}

try {
  "$(Get-Date -Format o) starting $Component" | Add-Content -LiteralPath $logFile -Encoding UTF8
  switch ($Component) {
    'MinIO' {
      $env:MINIO_ROOT_USER = (Get-Content -LiteralPath $env:S3_ACCESS_KEY_FILE -Raw).Trim()
      $env:MINIO_ROOT_PASSWORD = (Get-Content -LiteralPath $env:S3_SECRET_KEY_FILE -Raw).Trim()
      $minioData = Join-Path $dataRoot 'minio'
      New-Item -ItemType Directory -Force -Path $minioData | Out-Null
      Invoke-RestartingNativeProcess -FilePath $minio -Destination $logFile -ArgumentList @(
        'server', $minioData, '--address', '127.0.0.1:9000',
        '--console-address', '127.0.0.1:9001'
      )
    }
    'ExtensionServer' {
      Invoke-LoggedNativeProcess -FilePath $node -Destination $logFile `
        -ArgumentList @('scripts/native-extension-update-server.mjs')
    }
    'Api' {
      Wait-TcpPort -Port 5432
      Wait-TcpPort -Port 9000
      Invoke-LoggedNativeProcess -FilePath $node -Destination $logFile `
        -ArgumentList @('apps/api/src/main.mjs')
    }
    'Web' {
      Wait-TcpPort -Port 3000
      Invoke-RestartingNativeProcess -FilePath $node -Destination $logFile `
        -ArgumentList @('apps/web/src/server.mjs')
    }
    'Notifier' {
      Wait-TcpPort -Port 5432
      Invoke-RestartingNativeProcess -FilePath $node -Destination $logFile `
        -ArgumentList @('scripts/dingtalk-dispatcher.mjs')
    }
    'Sync' {
      Wait-TcpPort -Port 3000
      Invoke-LoggedNativeProcess -FilePath $node -Destination $logFile `
        -ArgumentList @('scripts/sync-windows-worker-state.mjs')
    }
    'Worker' {
      Stop-NativeLoginBrowserHosts
      Stop-StaleNativeWorkerProcessTrees
      & $node 'scripts\browser-proxy-preflight.mjs'
      if ($LASTEXITCODE -ne 0) {
        throw 'Browser proxy preflight failed; Worker was not started.'
      }
      $serverChrome = & (Join-Path $PSScriptRoot 'resolve-native-windows-chrome.ps1') -PassThru
      Write-Output "Using server Chrome $($serverChrome.Version) at $($serverChrome.Path)"
      Wait-TcpPort -Port 5432
      Wait-TcpPort -Port 9000
      Invoke-LoggedNativeProcess -FilePath $node -Destination $logFile `
        -ArgumentList @('apps/worker/src/main.mjs')
    }
  }
} catch {
  "$(Get-Date -Format o) failed $Component`r`n$($_ | Out-String)" |
    Add-Content -LiteralPath $logFile -Encoding UTF8
  throw
}
exit $LASTEXITCODE
