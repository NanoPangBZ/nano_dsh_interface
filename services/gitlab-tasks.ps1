# =====================================================================
# GitLab 任务查询 CLI（一次性）
# 用法：pwsh -File gitlab-tasks.ps1
# 配置：gitlab-config.json（url）+ gitlab-token.enc（DPAPI 加密令牌），
#       或环境变量 GITLAB_TOKEN 优先（旧版明文 json token 字段兼容读取）
# 输出：指派给当前用户的开放 Issue 清单
# =====================================================================
$ErrorActionPreference = 'Stop'

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
if (-not (Test-Path $configPath)) {
    Write-Error "缺少配置文件: $configPath"; exit 1
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$base = ([string]$config.url).TrimEnd('/')
$token = Read-Token
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error '未配置令牌：请在 设置 → 主题设置 → GitLab 配置 中填写，或设置环境变量 GITLAB_TOKEN'; exit 1
}

$headers = @{ 'PRIVATE-TOKEN' = $token }

# 解析当前用户 ID；失败则退回 assignee_id=me
$assignee = 'assignee_id=me'
try {
    $me = Invoke-RestMethod -Uri "$base/api/v4/user" -Headers $headers -TimeoutSec 15
    $assignee = "assignee_id=$($me.id)"
} catch {
    Write-Warning "无法获取用户信息（$($_.Exception.Message)），尝试 assignee_id=me"
}

# 注意：Invoke-RestMethod 将 JSON 数组作为单个对象输出，先捕获再 @() 展开
$resp = Invoke-RestMethod -Uri "$base/api/v4/issues?$assignee&state=opened&scope=assigned_to_me&per_page=100" -Headers $headers -TimeoutSec 15
$issues = @($resp)

$meName = if ($me) { $me.username } else { '' }
Write-Output "=== $meName 的开放 Issue（共 $($issues.Count) 个）==="
if ($issues.Count -eq 0) {
    Write-Output '（无）'
}
foreach ($i in $issues) {
    $ref = $i.references.full
    $labels = if ($i.labels) { "[$($i.labels -join ',')]" } else { '' }
    $due = if ($i.due_date) { " 截止 $($i.due_date)" } else { '' }
    $w = if ($i.weight) { " 权重 $($i.weight)" } else { '' }
    Write-Output ("[{0}] {1}{2}{3} {4}" -f $ref, $i.title, $due, $w, $labels)
}
