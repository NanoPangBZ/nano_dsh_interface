# =====================================================================
# DSH 系统监控采样器
# 每 IntervalSec 秒采集 CPU / GPU / 内存 / 磁盘读写带宽 / 网络上下行，
# 原子写入 <插件仓库>\data\metrics.json，供 Web 悬浮窗经 gitlab-bridge 的 /metrics 轮询。
# 周期说明：循环会从 IntervalSec 里扣掉本周期的采样耗时，使**有效周期**贴近 IntervalSec。
#           采样本身（Get-Counter）约需 2~3 秒，因此实际周期受它限制（本机实测约 2.7 秒，
#           修复前因为"采样 + 固定 sleep"实测是 4.5 秒，前端 2 秒轮询有一半白轮询）。
# 依赖：Windows 性能计数器（Win10+ 含 GPU Engine 计数器）。
# 用法：pwsh -NoProfile -File metrics-writer.ps1 [-IntervalSec 2]
# 说明：本脚本位于 <插件仓库>\services\，数据目录由 $PSScriptRoot 推导（仓库可整体移动），
#       不再写入 DSH 前端包目录，避免 DSH 升级覆盖 dist 时丢数据。
# =====================================================================
param([int]$IntervalSec = 2)
$ErrorActionPreference = 'SilentlyContinue'

# 数据目录：<仓库>\data（不存在则自动创建）
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot 'data'
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
$out = Join-Path $dataDir 'metrics.json'
if ($IntervalSec -lt 1) { $IntervalSec = 1 }

$counters = @(
    '\Processor(_Total)\% Processor Time',
    '\Memory\Available MBytes',
    '\PhysicalDisk(_Total)\Disk Read Bytes/sec',
    '\PhysicalDisk(_Total)\Disk Write Bytes/sec',
    '\Network Interface(*)\Bytes Received/sec',
    '\Network Interface(*)\Bytes Sent/sec'
)

$ramTotalKB = [double](Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize

while ($true) {
    $cycleStart = Get-Date
    $s = Get-Counter -Counter $counters -ErrorAction SilentlyContinue
    if ($s) {
        $cpu = 0.0; $availMB = 0.0; $diskRead = 0.0; $diskWrite = 0.0; $netDown = 0.0; $netUp = 0.0
        foreach ($cs in $s.CounterSamples) {
            $v = [double]$cs.CookedValue
            $p = [string]$cs.Path
            if ($p -like '*\Processor(_Total)\% Processor Time*') { $cpu = $v }
            elseif ($p -like '*\Memory\Available MBytes*') { $availMB = $v }
            elseif ($p -like '*Disk Read Bytes/sec*') { $diskRead += $v }
            elseif ($p -like '*Disk Write Bytes/sec*') { $diskWrite += $v }
            elseif ($p -like '*Bytes Received/sec*') { $netDown += $v }
            elseif ($p -like '*Bytes Sent/sec*') { $netUp += $v }
        }

        $gpu = -1.0
        $gs = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
        if ($gs) {
            foreach ($c in $gs.CounterSamples) {
                $v = [double]$c.CookedValue
                if ($v -gt $gpu) { $gpu = $v }
            }
        }

        $diskTot = 0.0; $diskFree = 0.0
        Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
            $diskTot += [double]$_.Size
            $diskFree += [double]$_.FreeSpace
        }

        $totalGB = $ramTotalKB / 1MB
        $availGB = $availMB / 1KB
        $ramUsedGB = $totalGB - $availGB
        if ($ramUsedGB -lt 0) { $ramUsedGB = 0 }

        $obj = [pscustomobject]@{
            ts   = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            cpu  = [math]::Round($cpu, 1)
            gpu  = if ($gpu -ge 0) { [math]::Round($gpu, 1) } else { -1 }
            ram  = [pscustomobject]@{ used = [math]::Round($ramUsedGB, 1); total = [math]::Round($totalGB, 1) }
            disk = [pscustomobject]@{
                read  = [math]::Round($diskRead / 1MB, 2)
                write = [math]::Round($diskWrite / 1MB, 2)
                total = [math]::Round($diskTot / 1GB, 0)
                free  = [math]::Round($diskFree / 1GB, 0)
            }
            net  = [pscustomobject]@{ down = [math]::Round($netDown / 1MB, 2); up = [math]::Round($netUp / 1MB, 2) }
        }
        $json = $obj | ConvertTo-Json -Compress -Depth 4
        [System.IO.File]::WriteAllText("$out.tmp", $json)
        Move-Item -Force "$out.tmp" $out
    }
    # 采样本身（Get-Counter / WMI）要花约 2~3 秒。若固定再睡 $IntervalSec，
    # 实际周期会变成"采样耗时 + IntervalSec"（实测约 4.5s），
    # 前端按 2s 轮询就会有一半是白轮询、显示值最多滞后一个多周期。
    # 这里扣掉本周期的耗时，让**有效周期**贴近 $IntervalSec。
    $elapsed = ((Get-Date) - $cycleStart).TotalSeconds
    $wait = [math]::Max(0.2, $IntervalSec - $elapsed)
    Start-Sleep -Seconds $wait
}
