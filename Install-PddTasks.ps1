$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install-local-service-tasks.ps1'
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$script = Get-Content -LiteralPath $installer -Raw -Encoding UTF8
$quotedAccount = $account.Replace("'", "''")
$script = [regex]::Replace($script, '(?m)^\$operatorAccount\s*=.*$', ('$operatorAccount = ' + "'" + $quotedAccount + "'"))
$script | Set-Content -LiteralPath $installer -Encoding UTF8
& $installer
$tasksRoot = Join-Path $PSScriptRoot 'snapshot\windows-tasks'
$index = Get-Content -LiteralPath (Join-Path $tasksRoot 'index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($entry in $index) {
  $xmlText = Get-Content -LiteralPath (Join-Path $tasksRoot $entry.file) -Raw -Encoding UTF8
  $xmlText = $xmlText.Replace('D:\pdd-native', $PSScriptRoot)
  [xml]$taskXml = $xmlText
  $manager = [Xml.XmlNamespaceManager]::new($taskXml.NameTable)
  $manager.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
  foreach ($userNode in $taskXml.SelectNodes('//t:UserId',$manager)) {
    if ($userNode.InnerText -notin @('S-1-5-18','SYSTEM','NT AUTHORITY\SYSTEM')) { $userNode.InnerText = $currentSid }
  }
  Register-ScheduledTask -TaskName $entry.name -TaskPath $entry.path -Xml $taskXml.OuterXml -Force | Out-Null
}
Write-Host ('Restored ' + @($index).Count + ' PDD scheduled tasks for this machine.')
