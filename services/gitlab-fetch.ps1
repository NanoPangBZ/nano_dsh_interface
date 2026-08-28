# =====================================================================
# GitLab 任务后台抓取器（供 Web 悬浮窗轮询）
# 每 30 秒抓取一次"指派给我的开放 Issue"，原子写入 dist/assets/gitlab-tasks.json
# 配置：gitlab-config.json（url + token），或环境变量 GITLAB_TOKEN 优先
# =====================================================================
$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path $PSScriptRoot 'dist\assets\gitlab-tasks.json'

$configPath = Join-Path $PSScriptRoot 'gitlab-config.json'
$config = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { $null }
$base = if ($config) { ([string]$config.url).TrimEnd('/') } else { 'http://192.168.1.12' }
$token = if ($env:GITLAB_TOKEN) { $env:GITLAB_TOKEN } elseif ($config) { [string]$config.token } else { '' }

function Write-Json([object]$obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    [System.IO.File]::WriteAllText("$out.tmp", $json)
    Move-Item -Force "$out.tmp" $out
}

if ([string]::IsNullOrWhiteSpace($token) -or $token -eq 'PASTE_YOUR_TOKEN_HERE') {
    $obj = [pscustomobject]@{ ts = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); error = '未配置令牌：请在 gitlab-config.json 填入 token'; user = $null; count = 0; issues = @() }
    Write-Json $obj
    Write-Output 'gitlab-fetch: 未配置令牌，退出。请在 gitlab-config.json 填入 token 后重启。'
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
