# =====================================================================
# nano_dsh_interface — 启动后台服务（电脑重启后运行）
# 启动/重启三个后台服务：
#   terminal-bridge (ws://127.0.0.1:3082)  PowerShell 终端
#   gitlab-bridge   (http://127.0.0.1:3081)  GitLab 任务 + 默认背景写盘
#   metrics-writer  (dist/assets/metrics.json) 系统监控
# gitlab-bridge 会收到 NANO_BG_SYNC_PATH 环境变量（本插件仓库 assets 目录），
# 使"设为默认背景"同时更新插件仓库里的 background.jpg。
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-services.ps1 [-Dist <dsh-web-frontend 包路径>]
# =====================================================================
param(
  [string]$Dist = ""
)
$ErrorActionPreference = 'SilentlyContinue'

function Find-DshWebFrontend {
  if ($env:DSH_WEB_FRONTEND -and (Test-Path $env:DSH_WEB_FRONTEND)) { return $env:DSH_WEB_FRONTEND }
  $npxRoots = @()
  if ($env:LOCALAPPDATA) { $npxRoots += (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx') }
  if ($env:USERPROFILE) { $npxRoots += (Join-Path $env:USERPROFILE 'AppData\Local\npm-cache\_npx') }
  foreach ($root in $npxRoots) {
    if (-not (Test-Path $root)) { continue }
    $hits = @(Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh-web-frontend'
      if (Test-Path $p) { $p }
    })
    if ($hits.Count -gt 0) { return $hits[0] }
  }
  return $null
}

if (-not $Dist) {
  $Dist = Find-DshWebFrontend
  if (-not $Dist) { Write-Error "未找到 dsh-web-frontend 包，请用 -Dist 指定路径" }
}
$Dist = (Resolve-Path $Dist).Path

Write-Host "== 启动 nano_dsh_interface 后台服务 ==" -ForegroundColor Cyan

# 停止旧实例（按命令行匹配）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'terminal-bridge|gitlab-bridge' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'metrics-writer' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
Start-Sleep -Milliseconds 800

# 插件仓库 assets 目录：设为默认背景时同步写回（start-services.ps1 位于插件仓库内）
$env:NANO_BG_SYNC_PATH = Join-Path $PSScriptRoot 'assets'

Start-Process node -ArgumentList "`"$Dist\terminal-bridge.mjs`"" -WindowStyle Hidden
Start-Process node -ArgumentList "`"$Dist\gitlab-bridge.mjs`"" -WindowStyle Hidden
Start-Process pwsh -ArgumentList "-NoProfile -File `"$Dist\metrics-writer.ps1`"" -WindowStyle Hidden

Start-Sleep -Seconds 3
Write-Host "已启动:" -ForegroundColor Green
Write-Host "  - terminal-bridge  ws://127.0.0.1:3082 (PowerShell 终端)"
Write-Host "  - gitlab-bridge    http://127.0.0.1:3081 (GitLab 任务 + 默认背景)"
Write-Host "  - metrics-writer   dist/assets/metrics.json (系统监控)"
Write-Host "  - 背景同步目录: $env:NANO_BG_SYNC_PATH"

# 健康检查
try {
  $gl = Invoke-RestMethod "http://127.0.0.1:3081/health" -TimeoutSec 3
  Write-Host ("  ✓ gitlab-bridge 健康 (tokenConfigured={0})" -f $gl.tokenConfigured) -ForegroundColor Green
} catch {
  Write-Host "  ✗ gitlab-bridge 健康检查失败" -ForegroundColor Yellow
}
try {
  $tb = Invoke-RestMethod "http://127.0.0.1:3082/health" -TimeoutSec 3
  Write-Host ("  ✓ terminal-bridge 健康 (pty={0}, pwsh={1})" -f $tb.pty, $tb.pwsh) -ForegroundColor Green
} catch {
  Write-Host "  ✗ terminal-bridge 健康检查失败" -ForegroundColor Yellow
}
