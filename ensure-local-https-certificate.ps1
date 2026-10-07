param(
  [string]$CertificateDirectory = (Join-Path $PSScriptRoot 'https\self-signed'),
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$mutex = [Threading.Mutex]::new($false, 'Local\PddNativeHttpsCertificate')
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw 'Certificate generation is already running.' }
  New-Item -ItemType Directory -Force -Path $CertificateDirectory | Out-Null
  $acl = Get-Acl -LiteralPath $CertificateDirectory
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) | Select-Object -Unique) {
    $identity = [Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
  }
  Set-Acl -LiteralPath $CertificateDirectory -AclObject $acl
  $bundlePath = Join-Path $CertificateDirectory 'server.pem'
  if ((Test-Path -LiteralPath $bundlePath) -and -not $Force) {
    $pem = [IO.File]::ReadAllText($bundlePath)
    $match = [regex]::Match($pem, '(?s)-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----')
    if ($match.Success) {
      $existing = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($match.Groups[1].Value))
      try {
        if ($existing.NotAfter.ToUniversalTime() -gt [DateTime]::UtcNow.AddDays(30)) {
          Write-Output "Temporary HTTPS certificate is current until $($existing.NotAfter.ToString('yyyy-MM-dd'))."
          return
        }
      } finally { $existing.Dispose() }
    }
  }
  $rsa = [Security.Cryptography.RSACng]::new(2048)
  try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      'CN=183.214.198.74', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    foreach ($ip in @('183.214.198.74', '10.10.12.188', '127.0.0.1', '::1')) { $san.AddIpAddress([Net.IPAddress]::Parse($ip)) }
    $san.AddDnsName('localhost')
    $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $usage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $true))
    $eku = [Security.Cryptography.OidCollection]::new()
    [void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false))
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(90))
    try {
      $certBase64 = [Convert]::ToBase64String($certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert), [Base64FormattingOptions]::InsertLineBreaks)
      $keyBase64 = [Convert]::ToBase64String($rsa.Key.Export([Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob), [Base64FormattingOptions]::InsertLineBreaks)
      $contents = "-----BEGIN CERTIFICATE-----`n$certBase64`n-----END CERTIFICATE-----`n-----BEGIN PRIVATE KEY-----`n$keyBase64`n-----END PRIVATE KEY-----`n"
      $temporaryPath = Join-Path $CertificateDirectory ('server-'+[Guid]::NewGuid().ToString('N')+'.tmp')
      try {
        [IO.File]::WriteAllText($temporaryPath, $contents, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $bundlePath) { [IO.File]::Replace($temporaryPath, $bundlePath, [NullString]::Value) }
        else { [IO.File]::Move($temporaryPath, $bundlePath) }
      } finally { if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force } }
      Write-Output "Temporary HTTPS certificate generated; expires $($certificate.NotAfter.ToString('yyyy-MM-dd')); SHA1 $($certificate.Thumbprint)."
    } finally { $certificate.Dispose() }
  } finally { $rsa.Dispose() }
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
