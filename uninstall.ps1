# =====================================================================
# nano_dsh_interface — 卸载脚本（客户端插件版）
# =====================================================================
# 默认只做一件事：从 profile 的 cordis.patch.yml 里移除本插件的 loader 条目。
# **不删除**插件仓库里的任何文件（构建产物、服务、GitLab 令牌都保留），
# 这样重新 install 即可恢复，不必重配 GitLab。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -CleanLegacy
#
#   -CleanLegacy 额外清理**旧版**（补丁 dsh-web-frontend/dist 时代）留在
#   DSH 安装目录里的 index.html 注入与拷贝资源。⚠️ 会删除这些拷贝文件，
#   但**保留** gitlab-token.enc / gitlab-config.json（你的令牌与配置）。
# =====================================================================
param(
  [string]$Profile = "",
  [switch]$CleanLegacy
)
$ErrorActionPreference = 'Stop'
$Plugin = Split-Path -Parent $MyInvocation.MyCommand.Path
$Marker = 'nano-dsh-interface'
$begin = "# >>> $Marker (managed block - do not edit by hand) >>>"
$end   = "# <<< $Marker <<<"

function Resolve-ProfileDir {
  param([string]$Explicit)
  if ($Explicit) { return (Resolve-Path $Explicit).Path }
  $home_dir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $p = Join-Path $home_dir 'profiles\web'
  if (-not (Test-Path $p)) { throw "未找到 web profile：$p（用 -Profile 指定）" }
  return (Resolve-Path $p).Path
}

$ProfileDir = Resolve-ProfileDir -Explicit $Profile
$PatchFile  = Join-Path $ProfileDir 'cordis.patch.yml'
Write-Host "== nano_dsh_interface 卸载 ==" -ForegroundColor Yellow
Write-Host "Profile: $ProfileDir"

# ---------- 1) 移除注册块 ----------
if (-not (Test-Path $PatchFile)) {
  Write-Host "[1/2] 补丁文件不存在，跳过"
} else {
  # 显式 -Encoding UTF8：PowerShell 5.1 默认按 ANSI 读取会把中文注释读坏。
  $raw = Get-Content $PatchFile -Raw -Encoding UTF8
  if ($raw -match [regex]::Escape($begin)) {
    $pattern = '(?s)\s*' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
    $next = [regex]::Replace($raw, $pattern, '')
    # 若已无任何有效条目，补回空数组占位符：
    # 纯注释/空文件会让 dsh 启动直接失败（"must be a top-level YAML array"）。
    $effective = ($next -split "`r?`n" | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' }) -join "`n"
    if (-not $effective.Trim()) { $next = $next.TrimEnd() + "`n`n[]`n" }

    $tmp = "$PatchFile.tmp"
    [System.IO.File]::WriteAllText($tmp, $next, [System.Text.UTF8Encoding]::new($false))
    $profilesRoot = Split-Path -Parent $ProfileDir
    $env:NODE_PATH = Join-Path $profilesRoot 'node_modules'
    # node 的 warning 走 stderr，不能被 EAP=Stop 当成终止性错误；只认退出码。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $check = node -e "const fs=require('fs');const yaml=require('yaml');let s=fs.readFileSync(process.argv[1],'utf8').replace(/^\uFEFF/,'').replace(/!!js\s+/g,'');const v=yaml.parse(s);if(!Array.isArray(v))throw new Error('顶层不是 YAML 数组');console.log('ok entries='+v.length)" $tmp 2>&1 | Out-String
    $nodeExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($nodeExit -ne 0) {
      Remove-Item -Force $tmp -ErrorAction SilentlyContinue
      throw "补丁文件校验失败，已放弃写入（原文件未改动）：`n$check"
    }
    Move-Item -Force $tmp $PatchFile
    Write-Host "[1/2] 已移除注册块，校验通过：$($check.Trim())"
  } else {
    Write-Host "[1/2] 补丁文件里没有本插件的注册块，跳过"
  }
}

# ---------- 2) 可选：清理旧版残留 ----------
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

if (-not $CleanLegacy) {
  Write-Host "[2/2] 跳过旧版 dist 残留清理（需要时加 -CleanLegacy）"
} else {
  $Dist = Find-DshWebFrontend
  if (-not $Dist) {
    Write-Host "[2/2] 未找到 dsh-web-frontend，跳过" -ForegroundColor Yellow
  } else {
    $Dist = (Resolve-Path $Dist).Path
    $index = Join-Path $Dist 'dist\index.html'
    if (Test-Path $index) {
      $html = Get-Content $index -Raw
      if ($html -match 'custom-background\.js') {
        foreach ($p in @(
          '\s*<script type="module" src="/assets/custom-background\.js"></script>',
          '\s*<script src="/assets/vendor/xterm\.js"></script>',
          '\s*<script src="/assets/vendor/xterm-addon-fit\.js"></script>',
          '\s*<link rel="stylesheet" crossorigin href="/assets/vendor/xterm\.css">',
          '\s*<link rel="stylesheet" crossorigin href="/assets/custom-background\.css">',
          '(?s)\s*<script>\s*/\* nano_dsh_interface:.*?</script>'
        )) { $html = [regex]::Replace($html, $p, '') }
        [System.IO.File]::WriteAllText($index, $html, [System.Text.UTF8Encoding]::new($false))
        Write-Host "[2/2] 已还原旧版注入的 dist\index.html" -ForegroundColor Green
      } else {
        Write-Host "[2/2] dist\index.html 无旧版注入，跳过"
      }
    }
    $assets = Join-Path $Dist 'dist\assets'
    foreach ($f in @('background.jpg', 'custom-background.css', 'custom-background.js', 'metrics.json', 'gitlab-tasks.json')) {
      Remove-Item -Force (Join-Path $assets $f) -ErrorAction SilentlyContinue
    }
    Remove-Item -Recurse -Force (Join-Path $assets 'vendor') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $assets 'modules') -ErrorAction SilentlyContinue
    # 旧版把服务也拷进去了；这些已不再需要（服务现在从插件仓库运行）。
    # 但**保留** gitlab-token.enc / gitlab-config.json，避免丢失 GitLab 令牌。
    foreach ($f in @('terminal-bridge.mjs', 'gitlab-bridge.mjs', 'gitlab-tasks.ps1', 'gitlab-fetch.ps1', 'metrics-writer.ps1')) {
      Remove-Item -Force (Join-Path $Dist $f) -ErrorAction SilentlyContinue
    }
    Write-Host "      已清理旧版拷贝的服务与前端资源（保留 gitlab-token.enc / gitlab-config.json）"
  }
}

Write-Host ""
Write-Host "完成。插件仓库内容未被删除；需要恢复时重新运行 install.ps1。" -ForegroundColor Green
