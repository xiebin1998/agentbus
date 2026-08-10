# TASK-26：一团队一账号 —— 从 hub 团队登记同步 broker 账号与 ACL
# -----------------------------------------------------------------
# 流程：GET hub /api/console/teams → 每团队建 broker 账号 team-<名>（幂等）
#       → 渲染 ACL（复用 server.render_broker_acl，与单测同源）→ SIGHUP 热加载
# 产物：mosquitto/config/acl（覆盖）、mosquitto/team-accounts.json（凭证，已 gitignore）
#
# 用法：
#   pwsh scripts/sync-broker-acl.ps1                                # hub 未开 token 鉴权
#   pwsh scripts/sync-broker-acl.ps1 -Token <MCP_API_TOKEN>
#   pwsh scripts/sync-broker-acl.ps1 -HubUrl http://中心节点:8000 -Token xxx

param(
    [string]$HubUrl = "http://127.0.0.1:8000",
    [string]$Token = "",
    [string]$HubUser = "agentbus",
    [string]$Container = "mqtt-broker"
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cfgDir = Join-Path $root "mosquitto\config"
$aclFile = Join-Path $cfgDir "acl"
$accountsFile = Join-Path $root "mosquitto\team-accounts.json"

# ── 1) 拉取团队清单 ───────────────────────────────────────────────────────
$uri = "$HubUrl/api/console/teams"
if ($Token) { $uri += "?token=$Token" }
try {
    $resp = Invoke-RestMethod -Uri $uri
} catch {
    Write-Error "无法访问 hub 团队 API（$uri）：$($_.Exception.Message)"
    exit 1
}
$teams = @($resp.teams)
Write-Host "[1/4] hub 团队数: $($teams.Count)"

# ── 2) 渲染 ACL（复用 server.render_broker_acl，保证与单测一致） ─────────
# 手工拼接防 ConvertTo-Json 单元素数组解包/双包裹的枚举陷阱
$teamsJson = "[" + (($teams | ForEach-Object { ConvertTo-Json $_ -Compress -Depth 5 }) -join ",") + "]"
$env:AGENTBUS_TEAMS_JSON = $teamsJson
$env:AGENTBUS_HUB_USER = $HubUser
$env:AGENTBUS_ACL_OUT = $aclFile
py -3 -c @"
import json, os, sys
sys.path.insert(0, r'$root')
import server
teams = json.loads(os.environ['AGENTBUS_TEAMS_JSON'])
acl = server.render_broker_acl(os.environ['AGENTBUS_HUB_USER'], teams)
with open(os.environ['AGENTBUS_ACL_OUT'], 'w', encoding='utf-8', newline='\n') as f:
    f.write(acl)
print(f"[2/4] ACL 已写入 {os.environ['AGENTBUS_ACL_OUT']}（{len(teams)} 个团队）")
"@
if ($LASTEXITCODE -ne 0) { throw "ACL 渲染失败" }

# ── 3) 团队 broker 账号（幂等：已有凭证不重置） ──────────────────────────
$accounts = @{}
if (Test-Path $accountsFile) {
    $accounts = Get-Content $accountsFile -Raw | ConvertFrom-Json -AsHashtable
}
foreach ($t in $teams) {
    $user = "team-$($t.name)"
    if (-not $accounts.ContainsKey($user)) {
        $pw = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
        docker run --rm -v "${cfgDir}:/mosquitto/config" eclipse-mosquitto:2 `
            mosquitto_passwd -b /mosquitto/config/passwd $user $pw
        if ($LASTEXITCODE -ne 0) { throw "mosquitto_passwd 建账号失败: $user" }
        $accounts[$user] = $pw
        Write-Host "    新建账号 $user"
    }
}
docker run --rm -v "${cfgDir}:/mosquitto/config" eclipse-mosquitto:2 `
    chmod 644 /mosquitto/config/passwd
ConvertTo-Json $accounts | Set-Content $accountsFile -Encoding utf8
Write-Host "[3/4] 账号凭证已记录: $accountsFile"

# ── 4) SIGHUP 热加载（mosquitto 重读 password_file / acl_file） ──────────
docker kill -s HUP $Container
if ($LASTEXITCODE -ne 0) { throw "SIGHUP 重载失败（容器 $Container 在运行吗？）" }
Write-Host "[4/4] broker 已热加载（SIGHUP）"

Write-Host ""
Write-Host "团队 daemon 接入凭证见 $accountsFile，写入 config.json broker.username/password：" -ForegroundColor Green
foreach ($k in $accounts.Keys) {
    Write-Host "  $k : $($accounts[$k])"
}
Write-Host "跨团队 publish 将被 broker ACL 拒绝（一团队一账号，架构 3.1.1）"
