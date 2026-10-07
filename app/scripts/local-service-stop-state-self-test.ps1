$ErrorActionPreference = 'Stop'
. 'D:\pdd-native\local-service-state.ps1'
$fixtureDirectory = Join-Path ([IO.Path]::GetTempPath()) ('pdd-stop-state-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
$fullStop = Join-Path $fixtureDirectory 'full.json'
$workerStop = Join-Path $fixtureDirectory 'worker.json'
$heartbeat = Join-Path $fixtureDirectory 'heartbeat.json'
function Assert-State([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
try {
  [IO.File]::WriteAllText($heartbeat, '{"state":"stopped"}')
  Assert-State (-not (Test-PddStopMarker -Paths @($fullStop,$workerStop) -BootTime 'boot1')) 'Unexpected Worker exit must allow recovery despite stopped heartbeat.'
  [IO.File]::WriteAllText($workerStop, '{"bootTime":"boot1","source":"local-worker-stop"}')
  Assert-State (Test-PddStopMarker -Paths @($fullStop,$workerStop) -BootTime 'boot1') 'An intentional Worker stop must remain stopped.'
  Assert-State (-not (Test-PddStopMarker -Paths @($fullStop) -BootTime 'boot1')) 'Stopping the Worker must not suppress frontend recovery.'
  Assert-State (-not (Test-PddStopMarker -Paths @($fullStop,$workerStop) -BootTime 'boot2')) 'A previous boot stop must not suppress restart after reboot.'
  [IO.File]::WriteAllText($fullStop, '{"bootTime":"boot2"}')
  Assert-State (Test-PddStopMarker -Paths @($fullStop) -BootTime 'boot2') 'An intentional full stop must remain stopped.'
  [IO.File]::WriteAllText($workerStop, '{invalid')
  Assert-State (Test-PddStopMarker -Paths @($workerStop) -BootTime 'boot2') 'An unreadable stop request must fail closed.'
  Write-Host 'Local service stop-state regression passed.'
} finally {
  foreach ($file in @($fullStop,$workerStop,$heartbeat)) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $fixtureDirectory -ErrorAction SilentlyContinue
}
