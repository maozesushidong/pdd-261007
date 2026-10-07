$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$obsoleteShortcuts = @(
  'PDD-Start.lnk', 'PDD-Stop.lnk',
  'PDD-Two-Shops-Start.lnk', 'PDD-Two-Shops-Stop.lnk'
)
$shortcuts = @(
  @{ Name = 'PDD-Start.lnk'; Target = 'START-PDD-NATIVE.cmd'; Description = 'Start the local console and all enabled PDD shop workers' },
  @{ Name = 'PDD-Stop.lnk'; Target = 'STOP-PDD-NATIVE.cmd'; Description = 'Stop all PDD workers, managed browsers and local services' },
  @{ Name = 'PDD-Shop-Login.lnk'; Target = 'OPEN-PDD-LOGIN-WINDOWS.cmd'; Description = 'Open enabled shop login windows while workers are stopped' }
)

foreach ($name in $obsoleteShortcuts) {
  Remove-Item -LiteralPath (Join-Path $desktop $name) -Force -ErrorAction SilentlyContinue
}

foreach ($item in $shortcuts) {
  $shortcut = $shell.CreateShortcut((Join-Path $desktop $item.Name))
  $shortcut.TargetPath = Join-Path $projectRoot $item.Target
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.Description = $item.Description
  $shortcut.IconLocation = 'C:\Windows\System32\shell32.dll,167'
  $shortcut.Save()
}

Write-Output "Installed $($shortcuts.Count) PDD desktop shortcuts."
