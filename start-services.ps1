# =====================================================================
# nano_dsh_interface — 启动后台服务（电脑重启后运行）
# 启动/重启三个后台服务：
#   terminal-bridge (ws://127.0.0.1:3082)  PowerShell 终端
#   gitlab-bridge   (http://127.0.0.1:3081)  GitLab 任务
#   metrics-writer  (dist/assets/metrics.json) 系统监控
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-services.ps1 [-Dist <dsh-web-frontend 包路径>]
# =====================================================================
param(
  [string]$Dist = "C:\Users\30964\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-frontend"
)
$ErrorActionPreference = 'SilentlyContinue'
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

Start-Process node -ArgumentList "`"$Dist\terminal-bridge.mjs`"" -WindowStyle Hidden
Start-Process node -ArgumentList "`"$Dist\gitlab-bridge.mjs`"" -WindowStyle Hidden
Start-Process pwsh -ArgumentList "-NoProfile -File `"$Dist\metrics-writer.ps1`"" -WindowStyle Hidden

Start-Sleep -Seconds 3
Write-Host "已启动:" -ForegroundColor Green
Write-Host "  - terminal-bridge  ws://127.0.0.1:3082 (PowerShell 终端)"
Write-Host "  - gitlab-bridge    http://127.0.0.1:3081 (GitLab 任务)"
Write-Host "  - metrics-writer   dist/assets/metrics.json (系统监控)"
