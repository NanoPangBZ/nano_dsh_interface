# =====================================================================
# nano_dsh_interface — 卸载脚本
# 移除注入的 index.html 内容与自定义资源/服务文件（含生成的监控/任务数据）。
# 用法：
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Dist <dsh-web-frontend 包路径>]
# =====================================================================
param(
  [string]$Dist = ""
)
$ErrorActionPreference = 'Stop'

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

Write-Host "== nano_dsh_interface 卸载 ==" -ForegroundColor Yellow

# 1) 恢复 index.html（逐条移除注入项，保留原始行）
$index = Join-Path $Dist 'dist\index.html'
$html = Get-Content $index -Raw
if ($html -match 'custom-background\.js') {
  $patterns = @(
    '\s*<script type="module" src="/assets/custom-background\.js"></script>',
    '\s*<script src="/assets/vendor/xterm\.js"></script>',
    '\s*<script src="/assets/vendor/xterm-addon-fit\.js"></script>',
    '\s*<link rel="stylesheet" crossorigin href="/assets/vendor/xterm\.css">',
    '\s*<link rel="stylesheet" crossorigin href="/assets/custom-background\.css">',
    '(?s)\s*<script>\s*/\* nano_dsh_interface:.*?</script>'
  )
  foreach ($p in $patterns) {
    $html = [regex]::Replace($html, $p, '')
  }
  Set-Content -Path $index -Value $html -Encoding UTF8 -NoNewline
  Write-Host "[1/3] index.html 已还原"
} else {
  Write-Host "[1/3] index.html 无注入内容，跳过"
}

# 2) 删除自定义资源与生成数据
$assets = Join-Path $Dist 'dist\assets'
foreach ($f in @('background.jpg', 'custom-background.css', 'custom-background.js', 'metrics.json', 'gitlab-tasks.json')) {
  Remove-Item -Force (Join-Path $assets $f) -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force (Join-Path $assets 'vendor') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $assets 'modules') -ErrorAction SilentlyContinue
Write-Host "[2/3] 自定义资源与生成数据已删除"

# 3) 删除服务、配置与加密令牌
foreach ($f in @('terminal-bridge.mjs', 'gitlab-bridge.mjs', 'gitlab-tasks.ps1', 'gitlab-fetch.ps1', 'metrics-writer.ps1', 'gitlab-config.json', 'gitlab-token.enc')) {
  Remove-Item -Force (Join-Path $Dist $f) -ErrorAction SilentlyContinue
}
Write-Host "[3/3] 服务与配置已删除"

Write-Host "完成。若后台服务仍在运行，请手动结束（或运行 start-services.ps1 前会自动清理）。" -ForegroundColor Green
