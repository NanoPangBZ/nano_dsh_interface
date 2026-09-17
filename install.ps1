# =====================================================================
# nano_dsh_interface — 安装脚本（客户端插件版）
# =====================================================================
# 与旧版（补丁 dsh-web-frontend/dist）完全不同：本版**不碰 DSH 安装目录**。
# 一条命令装完即可用，做三件事：
#   1) 构建浏览器半边产物 lib/client.js（esbuild；产物已入库，缺构建工具也能装）
#   2) 在目标 profile 的 cordis.patch.yml 里登记一行 loader 条目
#      宿主据此把浏览器半边服务到 /plugins/nano-dsh-interface/client.js，
#      因此 DSH 升级覆盖 dist 也不会再清空本插件
#   3) 立刻启动三个后台服务（终端/监控/GitLab 任务的数据来源），并安装**登录自启**，
#      使用户以后重启电脑不必再手动启动任何东西
#
# 用法（默认即完成 1+2+3）：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipBuild        # 只用已入库的产物
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NoAutostart      # 不装登录自启
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NoStartServices  # 不启动服务
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile <profile 目录>
# =====================================================================
param(
  [string]$Profile = "",
  [switch]$SkipBuild,
  # 以下两项默认**开启**：装完即用，不需要用户再手动启动任何东西。
  [switch]$NoStartServices,   # 跳过"立即启动三个后台服务"
  [switch]$NoAutostart,       # 跳过"安装登录自启任务"
  # 兼容旧调用：启动服务现在已默认执行，此开关保留但无额外作用
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
  Write-Host "[1/3] 跳过构建（-SkipBuild）"
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
Write-Host "[1/3] 浏览器半边就绪：lib\client.js（$kb KB）"

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
  Write-Host "[2/3] 更新已有的注册块"
} else {
  # 去掉空数组占位符（纯 `[]`，允许周围有注释）
  $next = [regex]::Replace($raw, '(?m)^\s*\[\s*\]\s*$', '')
  $next = $next.TrimEnd() + "`n`n" + $block + "`n"
  Write-Host "[2/3] 新增注册块"
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
$yamlRoot = Join-Path $profilesRoot 'node_modules'
$haveValidator = ($null -ne (Get-Command node -ErrorAction SilentlyContinue)) -and (Test-Path (Join-Path $yamlRoot 'yaml'))
$validated = $false
if ($haveValidator) {
  $env:NODE_PATH = $yamlRoot
  # node 若有 warning 会写 stderr，同样不能被 EAP=Stop 当成终止性错误；只认退出码。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $check = node -e "const fs=require('fs');const yaml=require('yaml');let s=fs.readFileSync(process.argv[1],'utf8').replace(/^\uFEFF/,'').replace(/!!js\s+/g,'');const v=yaml.parse(s);if(!Array.isArray(v))throw new Error('顶层不是 YAML 数组');console.log('ok entries='+v.length)" $tmp 2>&1 | Out-String
  $nodeExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($nodeExit -ne 0) {
    # 有校验器却校验不过 = 真的写坏了，必须中止
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    throw "补丁文件校验失败，已放弃写入（原文件未改动）：`n$check"
  }
  $validated = $true
} else {
  # 找不到校验器（node 缺失，或该 profile 的 node_modules 里没有 yaml）时，
  # 不因此让安装失败——退化成结构自检。真实用户环境通常都有 yaml 校验器。
  Write-Host "  ⚠ 未找到 YAML 校验器（node 或 profile 下 yaml 包），退化为结构自检" -ForegroundColor Yellow
  $body = ($next -split "`r?`n" | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' }) -join "`n"
  $body = $body.Trim()
  if ($body -eq '[]' -or $body.StartsWith('-')) {
    $validated = $true
    $check = "structural-ok"
  } else {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    throw "补丁文件结构自检失败（顶层必须是 YAML 数组）：
$body"
  }
}
if (-not $validated) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue; throw "补丁文件校验未通过，已放弃写入。" }
Move-Item -Force $tmp $PatchFile
Write-Host "  校验通过：$($check.Trim())"

# ---------- 3) 后台服务：立即启动 + 装登录自启 ----------
# 三个服务（terminal-bridge / gitlab-bridge / metrics-writer）是终端、系统监控、
# GitLab 任务的数据来源，且不会随电脑重启自动回来。所以安装时：
#   立即启动一次 —— 装完刷新页面即可用；
#   装登录自启   —— 以后重启电脑不必再记得跑任何脚本。
# 用 6>&1 捕获子脚本的 Write-Host，安装输出保持清爽，失败时再回放。
if ($NoStartServices) {
  Write-Host "[3/3] 跳过启动后台服务（-NoStartServices）"
} else {
  Write-Host "[3/3] 启动后台服务…"
  $svcOut = ''
  try { $svcOut = (& (Join-Path $Plugin 'start-services.ps1') 6>&1 | Out-String) } catch { $svcOut = "$($_.Exception.Message)" }
  $ptyOk = $false; $glOk = $false
  try { $ptyOk = ((Invoke-RestMethod 'http://127.0.0.1:3082/health' -TimeoutSec 5).pty -eq 'ok') } catch { }
  try { $glOk = [bool](Invoke-RestMethod 'http://127.0.0.1:3081/health' -TimeoutSec 5).ok } catch { }
  if ($ptyOk -and $glOk) {
    Write-Host "     ✓ 终端桥 / GitLab 桥均已就绪（pty=ok）" -ForegroundColor Green
  } else {
    Write-Host "     ⚠ 后台服务未完全就绪（pty=$ptyOk, gitlab=$glOk），下面是对应输出：" -ForegroundColor Yellow
    $svcOut.Trim() -split "`n" | ForEach-Object { Write-Host "       $_" }
  }
}

if ($NoAutostart) {
  Write-Host "     跳过登录自启（-NoAutostart）：重启电脑后需手动运行 start-services.ps1"
} else {
  $autoOut = ''
  try {
    $autoOut = (& (Join-Path $Plugin 'autostart.ps1') -Enable 6>&1 | Out-String)
    Write-Host "     ✓ 已安装登录自启任务：重启电脑后自动拉起后台服务" -ForegroundColor Green
  } catch {
    Write-Host "     ⚠ 登录自启安装失败：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "       可稍后手动执行 autostart.ps1 -Enable" -ForegroundColor Yellow
  }
}

Write-Host ""
if ($NoStartServices -or $NoAutostart) {
  Write-Host "完成（已按要求跳过部分步骤）。" -ForegroundColor Green
  if ($NoStartServices) { Write-Host "  · 后台服务未启动：需要时运行 start-services.ps1" }
  if ($NoAutostart) { Write-Host "  · 未装登录自启：重启电脑后需手动运行 start-services.ps1" }
} else {
  Write-Host "完成 —— 安装已一步到位，不需要再手动启动任何东西。" -ForegroundColor Green
}
Write-Host "  · 现在：刷新 DSH 页面（Ctrl+F5）。若插件没出现，重启一次 dsh web。"
if (-not $NoAutostart) { Write-Host "  · 以后：重启电脑会自动拉起后台服务（autostart.ps1 -Status 可查状态）。" }
Write-Host "  · 自检：npm run diagnose ／ curl http://127.0.0.1:3081/health"
