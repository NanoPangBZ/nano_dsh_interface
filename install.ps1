# =====================================================================
# nano_dsh_interface — 安装脚本
# 将自定义资源复制到 DSH 前端 dist，并幂等修补 index.html。
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Dist <dsh-web-frontend 包路径>] [-StartServices]
# =====================================================================
param(
  [string]$Dist = "C:\Users\30964\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-frontend",
  [switch]$StartServices
)
$ErrorActionPreference = 'Stop'
$Plugin = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = (Resolve-Path $Dist).Path
$assetsDest = Join-Path $Dist 'dist\assets'

Write-Host "== nano_dsh_interface 安装 ==" -ForegroundColor Cyan
Write-Host "目标: $Dist"

# 1) 资源（-Recurse 确保 vendor 子目录完整复制）
New-Item -ItemType Directory -Force -Path "$assetsDest\vendor" | Out-Null
Copy-Item -Force -Recurse (Join-Path $Plugin 'assets\*') $assetsDest
Write-Host "[1/3] 资源已复制 (background.jpg / custom-background.css / custom-background.js / vendor/xterm)"

# 2) 服务与配置
Copy-Item -Force (Join-Path $Plugin 'services\*') $Dist
Write-Host "[2/3] 服务与配置已复制 (terminal-bridge / gitlab-bridge / metrics-writer / gitlab-config)"

# 3) index.html 幂等修补（已包含则跳过）
$index = Join-Path $Dist 'dist\index.html'
$html = Get-Content $index -Raw
if ($html -notmatch 'custom-background\.js') {
  $block = @'

    <script type="module" src="/assets/custom-background.js"></script>
    <script src="/assets/vendor/xterm.js"></script>
    <script src="/assets/vendor/xterm-addon-fit.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/vendor/xterm.css">
    <link rel="stylesheet" crossorigin href="/assets/custom-background.css">
    <script>
      /* nano_dsh_interface: 首帧前恢复已保存配置 */
      (function () {
        try {
          var raw = localStorage.getItem("dsh.bgConfig");
          var cfg = raw ? JSON.parse(raw) : {};
          var s = document.documentElement.style;
          if (cfg.image) s.setProperty("--dsh-bg-image", 'url("' + cfg.image + '")');
          var t = Number(cfg.transparency);
          if (Number.isFinite(t)) {
            var a = 1 - Math.min(70, Math.max(0, t)) / 100;
            s.setProperty("--dsh-panel-alpha", String(Math.max(0.25, Math.min(1, a))));
          }
          var glassOn = cfg.glass !== false;
          var g = Number(cfg.glassStrength);
          var px = Number.isFinite(g) ? Math.min(40, Math.max(0, g)) : 24;
          s.setProperty("--dsh-glass-filter", glassOn ? "blur(" + px + "px) saturate(1.15)" : "none");
          if (cfg.maskColor) s.setProperty("--dsh-mask-color", cfg.maskColor);
          window.__DSH_NANO__ = true;
        } catch (e) { /* 忽略 */ }
      })();
    </script>
'@
  $html = $html.Replace('</head>', $block + "`n  </head>")
  Set-Content -Path $index -Value $html -Encoding UTF8 -NoNewline
  Write-Host "[3/3] index.html 已修补"
} else {
  Write-Host "[3/3] index.html 已包含 nano_dsh_interface，跳过"
}

if ($StartServices) {
  & (Join-Path $Plugin 'start-services.ps1') -Dist $Dist
}
Write-Host "完成。刷新 DSH Web 页面 (Ctrl+F5) 生效。" -ForegroundColor Green
