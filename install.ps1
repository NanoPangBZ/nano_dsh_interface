# =====================================================================
# nano_dsh_interface — 安装脚本（客户端插件版）
# =====================================================================
# 与旧版（补丁 dsh-web-frontend/dist）完全不同：本版**不碰 DSH 安装目录**，
# 只做两件事：
#   1) 构建浏览器半边产物 lib/client.js（esbuild，依赖已打入 bundle）
#   2) 在目标 profile 的 cordis.patch.yml 里登记一行 loader 条目
# 宿主据此把浏览器半边服务到 /plugins/nano-dsh-interface/client.js，
# 因此 DSH 升级覆盖 dist 也不会再清空本插件。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -StartServices
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile <profile 目录>
# =====================================================================
param(
  [string]$Profile = "",
  [switch]$SkipBuild,
  [switch]$StartServices
)
$ErrorActionPreference = 'Stop'
$Plugin = Split-Path -Parent $MyInvocation.MyCommand.Path
$Marker = 'nano-dsh-interface'

# ---------- 定位 profile ----------
function Resolve-ProfileDir {
  param([string]$Explicit)
  if ($Explicit) { return (Resolve-Path $Explicit).Path }
  $home_dir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $p = Join-Path $home_dir 'profiles\web'
  if (-not (Test-Path $p)) {
    throw "未找到 web profile：$p（用 -Profile 指定，或先运行一次 dsh web 生成）"
  }
  return (Resolve-Path $p).Path
}

$ProfileDir = Resolve-ProfileDir -Explicit $Profile
$PatchFile  = Join-Path $ProfileDir 'cordis.patch.yml'
Write-Host "== nano_dsh_interface 安装（客户端插件）==" -ForegroundColor Cyan
Write-Host "插件: $Plugin"
Write-Host "Profile: $ProfileDir"

# ---------- 1) 构建浏览器半边 ----------
$clientBundle = Join-Path $Plugin 'lib\client.js'
if ($SkipBuild) {
  Write-Host "[1/2] 跳过构建（-SkipBuild）"
} else {
  Push-Location $Plugin
  try {
    # 原生程序（npm/esbuild）的进度与摘要是写到 stderr 的，而 $ErrorActionPreference='Stop'
    # 会把 stderr 当成终止性错误。因此统一用 cmd 重定向到日志文件，只按退出码判断成败。
    $logFile = Join-Path $Plugin 'build.log'
    if (-not (Test-Path (Join-Path $Plugin 'node_modules\esbuild'))) {
      Write-Host "  安装构建依赖（esbuild）…"
      $null = cmd /c "npm install --no-audit --no-fund > `"$logFile`" 2>&1"
      if ($LASTEXITCODE -ne 0) {
        Get-Content $logFile -Tail 15 | ForEach-Object { Write-Host "    $_" }
        throw "npm install 失败（exit $LASTEXITCODE）"
      }
    }
    Write-Host "  构建 lib/client.js …"
    $null = cmd /c "npm run build > `"$logFile`" 2>&1"
    Get-Content $logFile -Tail 3 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm run build 失败（exit $LASTEXITCODE），详见 $logFile" }
  } finally { Pop-Location }
}
if (-not (Test-Path $clientBundle)) {
  throw "构建失败：缺少 $clientBundle（宿主会在激活时报 'client bundle not found'）"
}
$kb = [math]::Round((Get-Item $clientBundle).Length / 1KB, 1)
Write-Host "[1/2] 浏览器半边就绪：lib\client.js（$kb KB）"

# ---------- 2) 登记 loader 条目（幂等，哨兵块管理） ----------
$absIndex = (Join-Path $Plugin 'lib\index.js').Replace('\', '/')
$begin = "# >>> $Marker (managed block - do not edit by hand) >>>"
$end   = "# <<< $Marker <<<"
$block = @(
  $begin
  "# 宿主半边：路径会被 dsh 转成 file URL，并向上找到本插件 package.json（name=$Marker）。"
  "# 浏览器半边由 package.json 的 dsh.client 声明，经 /plugins/$Marker/client.js 提供。"
  "- insert:"
  "    - id: $Marker"
  "      name: '$absIndex'"
  $end
) -join "`n"

# 注意：必须显式 -Encoding UTF8。PowerShell 5.1 的 Get-Content 默认按 ANSI 读取，
# 会把补丁文件里的中文注释读坏再写回去。
$raw = if (Test-Path $PatchFile) { Get-Content $PatchFile -Raw -Encoding UTF8 } else { "[]`n" }
if ($raw -match [regex]::Escape($begin)) {
  # 已存在：整块替换（顺带修正插件被移动后的路径）
  $pattern = '(?s)' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
  # 替换串里转义 $，避免被当成反向引用
  $next = [regex]::Replace($raw, $pattern, $block.Replace('$', '$$'))
  Write-Host "[2/2] 更新已有的注册块"
} else {
  # 去掉空数组占位符（纯 `[]`，允许周围有注释）
  $next = [regex]::Replace($raw, '(?m)^\s*\[\s*\]\s*$', '')
  $next = $next.TrimEnd() + "`n`n" + $block + "`n"
  Write-Host "[2/2] 新增注册块"
}

# 写盘前校验：必须是顶层 YAML 数组，否则 dsh 启动会直接失败
$count = ([regex]::Matches($next, [regex]::Escape("id: $Marker"))).Count
if ($count -ne 1) {
  throw "补丁文件里 'id: $Marker' 出现 $count 次（应为 1 次）。请手动清理 $PatchFile 后重试。"
}
$tmp = "$PatchFile.tmp"
# 用 .NET 写盘且**不带 BOM**：PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
# 而 YAML 解析器遇到 BOM 会报 "Unexpected scalar at node end"。
[System.IO.File]::WriteAllText($tmp, $next, [System.Text.UTF8Encoding]::new($false))
$profilesRoot = Split-Path -Parent $ProfileDir
$env:NODE_PATH = Join-Path $profilesRoot 'node_modules'
# node 若有 warning 会写 stderr，同样不能被 EAP=Stop 当成终止性错误；只认退出码。
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
Write-Host "  校验通过：$($check.Trim())"

if ($StartServices) {
  & (Join-Path $Plugin 'start-services.ps1')
}

Write-Host ""
Write-Host "完成。后续：" -ForegroundColor Green
Write-Host "  · 刷新 DSH 页面（Ctrl+F5）。若插件没出现，重启一次 dsh web 让新的 loader 条目生效。"
Write-Host "  · 电脑重启后运行 start-services.ps1 启动三个后台服务。"
