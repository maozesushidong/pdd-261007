param(
  [switch]$Test
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $root '.codex'
$logPath = Join-Path $logDirectory 'desktop-notifier.log'
$apiUrl = 'http://127.0.0.1:3000/api/v1/verifications?active=true'
$settingsApiUrl = 'http://127.0.0.1:3000/api/v1/settings'
$activeStatuses = @('detected', 'waiting-human', 'verification-required')
$remoteDesktopFallbackUrl = 'http://127.0.0.1:4173/remote-desktop/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=1000&resize=scale&path=remote-desktop%2Fwebsockify%3Ftoken%3Dshop-0'
$pollIntervalMs = 500
$reminderSeconds = 60
$settingsRefreshMs = 10000
$cachedAlertsEnabled = $true
$nextSettingsRefreshAt = [datetime]::MinValue

function Write-NotifierLog {
  param([string]$Message)
  try {
    if (-not (Test-Path -LiteralPath $logDirectory)) {
      New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    }
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  } catch { }
}

function Get-ActiveVerifications {
  if ((Get-Date) -ge $script:nextSettingsRefreshAt) {
    $settingsResponse = Invoke-RestMethod -Uri $settingsApiUrl -Method Get -TimeoutSec 5
    $script:cachedAlertsEnabled = $settingsResponse.data.verificationAlertsEnabled -eq $true
    $script:nextSettingsRefreshAt = (Get-Date).AddMilliseconds($settingsRefreshMs)
  }
  if (-not $script:cachedAlertsEnabled) {
    return @()
  }

  $response = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 5
  return @($response.data | Where-Object {
    $activeStatuses -contains [string]$_.status -and -not $_.resolvedAt
  })
}

function New-VerificationAlertWindow {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = '拼多多工单需要人工验证'
  $form.ClientSize = New-Object System.Drawing.Size(620, 268)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.BackColor = [System.Drawing.Color]::FromArgb(255, 248, 248)

  $title = New-Object System.Windows.Forms.Label
  $title.Location = New-Object System.Drawing.Point(24, 20)
  $title.Size = New-Object System.Drawing.Size(570, 36)
  $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 18, [System.Drawing.FontStyle]::Bold)
  $title.ForeColor = [System.Drawing.Color]::FromArgb(156, 34, 34)
  $title.Text = '需要立即完成验证码'
  $form.Controls.Add($title)

  $shopLabel = New-Object System.Windows.Forms.Label
  $shopLabel.Location = New-Object System.Drawing.Point(27, 68)
  $shopLabel.Size = New-Object System.Drawing.Size(560, 28)
  $shopLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($shopLabel)

  $detail = New-Object System.Windows.Forms.Label
  $detail.Location = New-Object System.Drawing.Point(27, 105)
  $detail.Size = New-Object System.Drawing.Size(560, 58)
  $detail.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
  $detail.ForeColor = [System.Drawing.Color]::FromArgb(70, 70, 70)
  $form.Controls.Add($detail)

  $openButton = New-Object System.Windows.Forms.Button
  $openButton.Location = New-Object System.Drawing.Point(28, 188)
  $openButton.Size = New-Object System.Drawing.Size(270, 48)
  $openButton.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $openButton.Text = '打开对应店铺远程窗口'
  $openButton.BackColor = [System.Drawing.Color]::FromArgb(26, 108, 68)
  $openButton.ForeColor = [System.Drawing.Color]::White
  $openButton.FlatStyle = 'Flat'
  $form.Controls.Add($openButton)

  $dismissButton = New-Object System.Windows.Forms.Button
  $dismissButton.Location = New-Object System.Drawing.Point(322, 188)
  $dismissButton.Size = New-Object System.Drawing.Size(270, 48)
  $dismissButton.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
  $dismissButton.Text = '我知道了，稍后再提醒'
  $form.Controls.Add($dismissButton)

  $form.Add_Shown({
    $form.Activate()
    $form.BringToFront()
  })
  return [pscustomobject]@{
    Form = $form
    Title = $title
    ShopLabel = $shopLabel
    Detail = $detail
    OpenButton = $openButton
    DismissButton = $dismissButton
  }
}

function Get-VerificationItemId {
  param([Parameter(Mandatory)]$Item)
  if ($Item.id) { return [string]$Item.id }
  return @($Item.shopId, $Item.system, $Item.stage, $Item.detectedAt, $Item.url) -join ':'
}

function Update-VerificationAlertWindow {
  param(
    [Parameter(Mandatory)]$Window,
    [Parameter(Mandatory)]$Item,
    [int]$ActiveCount = 1,
    [switch]$Sample
  )
  $shopId = [string]$Item.shopId
  $shopName = if ($Item.shopName) { [string]$Item.shopName } else { $shopId }
  $systemName = ([string]$Item.system).ToUpperInvariant()
  if (-not $systemName) { $systemName = 'PDD' }
  $stage = if ($Item.stage) { [string]$Item.stage } else { '安全验证' }
  $detectedAtValue = if ($Item.detectedAt) { [datetime]$Item.detectedAt } else { Get-Date }
  $detectedAt = $detectedAtValue.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
  $script:currentVncUrl = if ($Item.remoteDesktopPath) {
    "http://127.0.0.1:4173$([string]$Item.remoteDesktopPath)"
  } else {
    $remoteDesktopFallbackUrl
  }
  $script:currentItemId = Get-VerificationItemId -Item $Item
  $Window.Title.Text = if ($Sample) { '桌面提醒测试成功' } else { '需要立即完成验证码' }
  $Window.ShopLabel.Text = "$shopName  |  $systemName  |  $stage"
  $Window.Detail.Text = "检测时间：$detectedAt`r`n当前共有 $ActiveCount 个待验证项目。完成后不要重复点击，程序会自动继续。"
  $latencyMs = [math]::Max(0, [math]::Round(((Get-Date) - $detectedAtValue.ToLocalTime()).TotalMilliseconds))
  Write-NotifierLog "show alert shop=$shopId system=$systemName stage=$stage count=$ActiveCount latencyMs=$latencyMs"
}

if ($Test) {
  $testWindow = New-VerificationAlertWindow
  $testItem = [pscustomobject]@{
    id = 'desktop-alert-test'
    shopId = 'panapopo-healthcare'
    system = 'pdd'
    stage = '滑块验证测试'
    detectedAt = (Get-Date).ToString('o')
  }
  Update-VerificationAlertWindow -Window $testWindow -Item $testItem -ActiveCount 1 -Sample
  $testWindow.DismissButton.Text = '关闭测试窗口'
  $testWindow.DismissButton.Add_Click({ $testWindow.Form.Close() })
  $testWindow.OpenButton.Add_Click({ $testWindow.Form.Close() })
  [System.Media.SystemSounds]::Exclamation.Play()
  [void]$testWindow.Form.ShowDialog()
  $testWindow.Form.Dispose()
  exit 0
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\PddVerificationDesktopNotifier', [ref]$createdNew)
if (-not $createdNew) {
  Write-NotifierLog 'duplicate notifier process exited'
  $mutex.Dispose()
  exit 0
}
$stopEvent = [System.Threading.EventWaitHandle]::new(
  $false,
  [System.Threading.EventResetMode]::ManualReset,
  'Local\PddVerificationDesktopNotifierStop'
)

try {
  Write-NotifierLog "notifier started pid=$PID"
  $window = New-VerificationAlertWindow
  $knownActive = @{}
  $script:currentItemId = ''
  $script:currentVncUrl = $remoteDesktopFallbackUrl
  $script:dismissedUntil = [datetime]::MinValue
  $script:notifierStopping = $false
  $window.OpenButton.Add_Click({
    Start-Process $script:currentVncUrl
    $script:dismissedUntil = (Get-Date).AddSeconds($reminderSeconds)
    $window.Form.Hide()
  })
  $window.DismissButton.Add_Click({
    $script:dismissedUntil = (Get-Date).AddSeconds($reminderSeconds)
    $window.Form.Hide()
  })
  $window.Form.Add_FormClosing({
    param($sender, $eventArgs)
    if (-not $script:notifierStopping) {
      $eventArgs.Cancel = $true
      $script:dismissedUntil = (Get-Date).AddSeconds($reminderSeconds)
      $sender.Hide()
    }
  })
  $lastErrorLogAt = [datetime]::MinValue
  $nextPollAt = [datetime]::MinValue
  while (-not $stopEvent.WaitOne(0)) {
    [System.Windows.Forms.Application]::DoEvents()
    if ((Get-Date) -ge $nextPollAt) {
      try {
        $active = @(Get-ActiveVerifications)
        $nextKnown = @{}
        foreach ($item in $active) {
          $nextKnown[(Get-VerificationItemId -Item $item)] = $item
        }
        $newItems = @($active | Where-Object {
          -not $knownActive.ContainsKey((Get-VerificationItemId -Item $_))
        })
        if ($active.Count -eq 0) {
          $window.Form.Hide()
          $script:currentItemId = ''
          $script:dismissedUntil = [datetime]::MinValue
        } else {
          $selected = if ($newItems.Count -gt 0) {
            $newItems | Sort-Object { [datetime]$_.detectedAt } -Descending | Select-Object -First 1
          } elseif ($nextKnown.ContainsKey($script:currentItemId)) {
            $nextKnown[$script:currentItemId]
          } else {
            $active | Sort-Object { [datetime]$_.detectedAt } -Descending | Select-Object -First 1
          }
          $selectedId = Get-VerificationItemId -Item $selected
          $shouldShow = $newItems.Count -gt 0 -or -not $window.Form.Visible -and (Get-Date) -ge $script:dismissedUntil
          $shouldUpdate = $shouldShow -or $selectedId -ne $script:currentItemId -or $newItems.Count -gt 0
          if ($shouldUpdate) {
            Update-VerificationAlertWindow -Window $window -Item $selected -ActiveCount $active.Count
          }
          if ($shouldShow) {
            [System.Media.SystemSounds]::Exclamation.Play()
            $window.Form.Show()
            $window.Form.Activate()
            $window.Form.BringToFront()
          }
        }
        $knownActive = $nextKnown
      } catch {
        if (((Get-Date) - $lastErrorLogAt).TotalMinutes -ge 5) {
          Write-NotifierLog "poll failed: $($_.Exception.Message)"
          $lastErrorLogAt = Get-Date
        }
      }
      $nextPollAt = (Get-Date).AddMilliseconds($pollIntervalMs)
    }
    if ($stopEvent.WaitOne(100)) { break }
  }
} finally {
  if ($window) {
    $script:notifierStopping = $true
    $window.Form.Close()
    $window.Form.Dispose()
  }
  Write-NotifierLog "notifier stopped pid=$PID"
  $stopEvent.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
