# =====================================================================
# nano_dsh_interface — 后台服务登录自启管理
# =====================================================================
# 解决的问题：三个后台服务（terminal-bridge / gitlab-bridge / metrics-writer）
# 不会随电脑重启自动回来。忘了跑 start-services.ps1 时，表现为
# **终端连不上（一直"连接中…"）、监控与 GitLab 任务没有数据**。
#
# 本脚本注册一个"用户登录时"触发的计划任务来运行 start-services.ps1。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 -Enable     # 安装/更新自启
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 -Disable    # 取消自启
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 -Status     # 查看状态（默认）
# =====================================================================
param(
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Status
)
$ErrorActionPreference = 'Stop'

$Repo = $PSScriptRoot
$TaskName = 'nano_dsh_interface-services'
$StartScript = Join-Path $Repo 'start-services.ps1'

function Resolve-Pwsh {
  $c = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
}

function Show-Status {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) {
    Write-Host "自启任务：未安装" -ForegroundColor Yellow
    Write-Host "  （注意：未安装时，电脑重启后终端/监控/GitLab 任务都不会工作，需手动跑 start-services.ps1）"
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "自启任务：已安装" -ForegroundColor Green
  Write-Host "  名称     : $TaskName"
  Write-Host "  状态     : $($t.State)"
  Write-Host "  触发     : 用户登录时"
  Write-Host "  执行     : $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
  if ($info) {
    Write-Host "  上次运行 : $($info.LastRunTime)  结果=0x$('{0:X}' -f $info.LastTaskResult)"
    Write-Host "  下次运行 : $($info.NextRunTime)"
  }
}

if ($Disable) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已取消自启任务：$TaskName" -ForegroundColor Green
  } else {
    Write-Host "自启任务本来就不存在，无需取消" -ForegroundColor Yellow
  }
  return
}

if ($Enable) {
  if (-not (Test-Path -LiteralPath $StartScript)) { throw "未找到 $StartScript" }
  $pwsh = Resolve-Pwsh
  $action = New-ScheduledTaskAction -Execute $pwsh `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`"" `
    -WorkingDirectory $Repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # StartWhenAvailable：错过触发时间（例如登录后才开机完成）也补跑
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "已安装自启任务：$TaskName" -ForegroundColor Green
  Write-Host "  登录时执行：$StartScript"
  Show-Status
  return
}

Show-Status
