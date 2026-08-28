# =====================================================================
# GitLab 任务查询 CLI（一次性）
# 用法：pwsh -File gitlab-tasks.ps1
# 配置：gitlab-config.json（url + token），或环境变量 GITLAB_TOKEN 优先
# 输出：指派给当前用户的开放 Issue 清单
# =====================================================================
$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'gitlab-config.json'
if (-not (Test-Path $configPath)) {
    Write-Error "缺少配置文件: $configPath"; exit 1
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$base = ([string]$config.url).TrimEnd('/')
$token = if ($env:GITLAB_TOKEN) { $env:GITLAB_TOKEN } else { [string]$config.token }
if ([string]::IsNullOrWhiteSpace($token) -or $token -eq 'PASTE_YOUR_TOKEN_HERE') {
    Write-Error '未配置令牌：请在 gitlab-config.json 填入 token，或设置环境变量 GITLAB_TOKEN'; exit 1
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
