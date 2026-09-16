# =====================================================================
# nano_dsh_interface — 启动后台服务（电脑重启后运行）
# 三个服务一律从本插件仓库的 services\ 目录启动，不涉及 DSH 安装目录：
#   terminal-bridge (ws://127.0.0.1:3082)   PowerShell 终端
#   gitlab-bridge   (http://127.0.0.1:3081) GitLab 任务 + 默认背景 + /metrics、/tasks、/default-background
#   metrics-writer  (<仓库>\data\metrics.json) 系统监控
# 数据落盘位置（都在插件仓库内，DSH 升级覆盖前端包也不会丢）：
#   <仓库>\data\metrics.json         系统指标（metrics-writer 每 2 秒）
#   <仓库>\data\gitlab-tasks.json    GitLab 任务（gitlab-bridge 每 30 秒）
#   <仓库>\assets\background.jpg     默认背景图
# 环境变量 NANO_BG_SYNC_PATH 仍指向 <仓库>\assets（兼容旧逻辑的兜底同步）。
#
# 依赖：ws / node-pty 是本仓库的**正式 dependencies**（node-pty 自带预编译产物，
# 无需本地构建）。它们随 npm install 一起维护，不再依赖 DSH 安装目录里的副本。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-services.ps1
# 注意：-Dist 参数已废弃，仅为兼容旧调用而保留，传入会被忽略。
# =====================================================================
param(
  # 已废弃：服务不再从 DSH 前端包目录启动，此参数被忽略
  [string]$Dist = ""
)
$ErrorActionPreference = 'SilentlyContinue'

$Repo = $PSScriptRoot
$Services = Join-Path $Repo 'services'
$DataDir = Join-Path $Repo 'data'

if (-not (Test-Path -LiteralPath $Services)) {
  Write-Host "✗ 未找到服务目录: $Services" -ForegroundColor Red
  return
}

Write-Host "== 启动 nano_dsh_interface 后台服务 ==" -ForegroundColor Cyan
Write-Host "插件仓库: $Repo" -ForegroundColor DarkGray

# ---------- 依赖就绪（ws / node-pty 缺失时自动补装） ----------
function Test-RepoDep {
  param([string]$Name)
  return (Test-Path -LiteralPath (Join-Path $Repo "node_modules\$Name\package.json"))
}
$missing = @()
foreach ($dep in @('ws', 'node-pty')) { if (-not (Test-RepoDep $dep)) { $missing += $dep } }
if ($missing.Count -gt 0) {
  Write-Host "依赖缺失（$($missing -join ', ')），执行 npm install --omit=dev …" -ForegroundColor Yellow
  $logFile = Join-Path $Repo 'npm-install.log'
  $null = cmd /c "npm install --omit=dev --no-audit --no-fund > `"$logFile`" 2>&1"
  if ($LASTEXITCODE -ne 0) {
    Get-Content $logFile -Tail 15 | ForEach-Object { Write-Host "    $_" }
  }
}
$depsOk = (Test-RepoDep 'ws') -and (Test-RepoDep 'node-pty')
if ($depsOk) {
  Write-Host "依赖已就绪: ws / node-pty（仓库内 node_modules）" -ForegroundColor DarkGray
} else {
  Write-Host "⚠ ws / node-pty 未就绪，terminal-bridge 的 PTY 将不可用（健康检查里 pty 会报错）" -ForegroundColor Yellow
  Write-Host "   修复：在插件仓库执行  npm install" -ForegroundColor Yellow
}

# 停旧实例（按命令行匹配，兼容旧版从 DSH 前端包目录启动的实例）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'terminal-bridge|gitlab-bridge' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'metrics-writer' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
Start-Sleep -Milliseconds 800

# 数据目录预创建（两个服务也会自建，这里提前建好便于紧接的探测）
if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

# 兼容兜底：默认背景仍会额外同步到插件仓库 assets（现与 gitlab-bridge 的写入目标是同一处）
$env:NANO_BG_SYNC_PATH = Join-Path $Repo 'assets'

# 启动三个服务（一律从插件仓库 services\ 启动）
Start-Process node -ArgumentList "`"$Services\terminal-bridge.mjs`"" -WindowStyle Hidden
Start-Process node -ArgumentList "`"$Services\gitlab-bridge.mjs`"" -WindowStyle Hidden
Start-Process pwsh -ArgumentList "-NoProfile -File `"$Services\metrics-writer.ps1`"" -WindowStyle Hidden

Start-Sleep -Seconds 3
Write-Host "已启动:" -ForegroundColor Green
Write-Host "  - terminal-bridge  ws://127.0.0.1:3082 (PowerShell 终端)"
Write-Host "  - gitlab-bridge    http://127.0.0.1:3081 (GitLab 任务 / 默认背景 / metrics / tasks)"
Write-Host "  - metrics-writer   data\metrics.json (系统监控)"
Write-Host "  - 数据目录: $DataDir"
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
  if ($tb.pty -eq 'ok') {
    Write-Host ("  ✓ terminal-bridge 健康 (pty=ok, pwsh={0})" -f $tb.pwsh) -ForegroundColor Green
  } else {
    Write-Host ("  ⚠ terminal-bridge 已启动但 PTY 不可用 (pty={0}, err={1})" -f $tb.pty, $tb.ptyError) -ForegroundColor Yellow
  }
} catch {
  Write-Host "  ✗ terminal-bridge 健康检查失败" -ForegroundColor Yellow
}

# 数据路由探测：健康检查通过后各探一次，只看能不能拿到 200
foreach ($ep in @('/metrics', '/tasks')) {
  try {
    $r = Invoke-WebRequest ("http://127.0.0.1:3081" + $ep) -TimeoutSec 3 -UseBasicParsing
    Write-Host ("  ✓ {0} -> HTTP {1} ({2} bytes)" -f $ep, $r.StatusCode, $r.RawContentLength) -ForegroundColor Green
  } catch {
    Write-Host ("  ✗ {0} 探测失败" -f $ep) -ForegroundColor Yellow
  }
}
