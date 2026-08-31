# =====================================================================
# GitLab 任务后台抓取器（备用，主用 gitlab-bridge.mjs）
# 每 30 秒抓取一次"指派给我的开放 Issue"，原子写入 dist/assets/gitlab-tasks.json
# 配置：gitlab-config.json（url）+ gitlab-token.enc（DPAPI 加密令牌），
#       或环境变量 GITLAB_TOKEN 优先（旧版明文 json token 字段兼容读取）
# =====================================================================
$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path $PSScriptRoot 'dist\assets\gitlab-tasks.json'

# 读取令牌：环境变量 > gitlab-token.enc（DPAPI）> 旧版 json 明文
function Read-Token {
    if ($env:GITLAB_TOKEN) { return $env:GITLAB_TOKEN }
    $encPath = Join-Path $PSScriptRoot 'gitlab-token.enc'
    if (Test-Path $encPath) {
        Add-Type -AssemblyName System.Security
        $s = (Get-Content $encPath -Raw).Trim()
        if ($s) {
            $b = [Convert]::FromBase64String($s)
            $d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            $t = [System.Text.Encoding]::UTF8.GetString($d)
            if ($t) { return $t }
        }
    }
    $configPath = Join-Path $PSScriptRoot 'gitlab-config.json'
    if (Test-Path $configPath) {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($cfg.token -and $cfg.token -ne 'PASTE_YOUR_TOKEN_HERE') { return [string]$cfg.token }
    }
    return $null
}

$configPath = Join-Path $PSScriptRoot 'gitlab-config.json'
$config = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { $null }
$base = if ($config) { ([string]$config.url).TrimEnd('/') } else { 'http://192.168.1.12' }
$token = Read-Token

function Write-Json([object]$obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    [System.IO.File]::WriteAllText("$out.tmp", $json)
    Move-Item -Force "$out.tmp" $out
}

if ([string]::IsNullOrWhiteSpace($token)) {
    $obj = [pscustomobject]@{ ts = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); error = '未配置令牌：请在 设置 → 主题设置 → GitLab 配置 中填写'; user = $null; count = 0; issues = @() }
    Write-Json $obj
    Write-Output 'gitlab-fetch: 未配置令牌，退出。请在 设置 → 主题设置 → GitLab 配置 中填写后重启。'
    exit 1
}

$headers = @{ 'PRIVATE-TOKEN' = $token }

while ($true) {
    try {
        $me = Invoke-RestMethod -Uri "$base/api/v4/user" -Headers $headers -TimeoutSec 15
        $assignee = "assignee_id=$($me.id)"
        # 注意：Invoke-RestMethod 将 JSON 数组作为单个对象输出，先捕获再 @() 展开
        $resp = Invoke-RestMethod -Uri "$base/api/v4/issues?$assignee&state=opened&scope=assigned_to_me&per_page=100" -Headers $headers -TimeoutSec 15
        $issues = @($resp)
        $obj = [pscustomobject]@{
            ts     = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            error  = $null
            user   = $me.username
            count  = $issues.Count
            issues = @($issues | ForEach-Object {
                # web_url 主机名可能是内网机器名，浏览器解析不了 → 重写为配置的 base 主机
                $issueUrl = [string]$_.web_url
                if ($issueUrl -match '^https?://[^/]+') {
                    $issueUrl = $base + $issueUrl.Substring($issueUrl.IndexOf('/', 8))
                }
                [pscustomobject]@{
                    iid     = $_.iid
                    ref     = $_.references.full
                    title   = $_.title
                    labels  = @($_.labels)
                    due     = $_.due_date
                    url     = $issueUrl
                    updated = $_.updated_at
                }
            })
        }
        Write-Json $obj
    } catch {
        $obj = [pscustomobject]@{ ts = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); error = $_.Exception.Message; user = $null; count = 0; issues = @() }
        Write-Json $obj
    }
    Start-Sleep -Seconds 30
}
