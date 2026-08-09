# TASK-13: 24h 长跑替代方案 —— 循环端到端冒烟（每 30s 一轮，持续记录成功/失败）
# 前置：dev-broker + server.py + smoke-daemon 已在运行
# 用法：pwsh scripts/soak_loop.ps1 [间隔秒数，默认 30]
param([int]$Interval = 30)

$round = 0
$ok = 0
$fail = 0
$log = Join-Path $PSScriptRoot "..\soak.log"

while ($true) {
    $round++
    py (Join-Path $PSScriptRoot "smoke_hub.py") > $null 2>&1
    if ($LASTEXITCODE -eq 0) { $ok++ } else { $fail++ }
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') round=$round ok=$ok fail=$fail"
    $line | Tee-Object -Append $log
    Start-Sleep $Interval
}
