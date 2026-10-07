param([string]$InstallRoot = 'C:\pdd-native')

$ErrorActionPreference = 'Stop'
$installer = Join-Path $InstallRoot 'downloads\vc_redist.x64.exe'
if (-not (Test-Path -LiteralPath $installer)) {
  Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' `
    -OutFile $installer -UseBasicParsing -TimeoutSec 600
}

$signature = Get-AuthenticodeSignature -FilePath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Microsoft*') {
  throw 'VC++ installer signature validation failed.'
}

$process = Start-Process -FilePath $installer `
  -ArgumentList @('/install', '/quiet', '/norestart') -Wait -PassThru
if ($process.ExitCode -notin 0, 1638, 3010) {
  throw "VC++ installer failed with exit code $($process.ExitCode)"
}

[ordered]@{
  InstallerSHA256 = (Get-FileHash $installer -Algorithm SHA256).Hash
  Signature = $signature.Status.ToString()
  InstallerExitCode = $process.ExitCode
  InitdbVersion = (& (Join-Path $InstallRoot 'runtime\postgres\bin\initdb.exe') --version)
} | ConvertTo-Json -Compress

