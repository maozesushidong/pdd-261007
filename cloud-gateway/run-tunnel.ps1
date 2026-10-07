$ErrorActionPreference = 'Stop'
$tunnelRoot = $PSScriptRoot
$mutex = [Threading.Mutex]::new($false, 'Global\PddPublicGatewayTunnel')
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    $tunnelLog = Join-Path $tunnelRoot 'supervisor.log'
    while ($true) {
        if ((Test-Path -LiteralPath $tunnelLog) -and (Get-Item -LiteralPath $tunnelLog).Length -gt 1MB) {
            Copy-Item -LiteralPath $tunnelLog -Destination (Join-Path $tunnelRoot 'supervisor.previous.log') -Force
            Clear-Content -LiteralPath $tunnelLog
        }
        Add-Content -LiteralPath $tunnelLog -Value "$(Get-Date -Format o) Connecting public gateway tunnel"
        try {
            $sshProcess = Start-Process -FilePath "$env:WINDIR\System32\OpenSSH\ssh.exe" `
                -ArgumentList '-F', (Join-Path $tunnelRoot 'ssh_config'), '-N', '-T', 'pdd-public-gateway' `
                -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $tunnelRoot 'ssh.out.log') `
                -RedirectStandardError (Join-Path $tunnelRoot 'ssh.err.log')
            $sshProcess.WaitForExit()
            Add-Content -LiteralPath $tunnelLog -Value "$(Get-Date -Format o) Tunnel exited: $($sshProcess.ExitCode); reconnecting in 10 seconds"
        } catch {
            Add-Content -LiteralPath $tunnelLog -Value "$(Get-Date -Format o) Tunnel failed: $($_.Exception.Message); reconnecting in 10 seconds"
        }
        Start-Sleep -Seconds 10
    }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
