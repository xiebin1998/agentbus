# AgentBus 一键安装（Windows）—— 架构 6.6 / TASK-28
#
# 用法（干净机器一条命令接入；控制台“接入命令”弹窗会生成带凭证的一行式命令）：
#   iwr https://<host>/install.ps1 | iex
#
# 可选环境变量（均自动透传给 agentbus init，全程无交互）：
#   AGENTBUS_PACKAGE   npm 包来源（默认 @xiebin1998/agentbus@latest；可指本地目录/tarball 供离线安装）
#   AGENTBUS_BROKER    broker host:port（默认 localhost:18830）
#   AGENTBUS_USER      broker 接入用户名（控制台发放，四期强制认证）
#   AGENTBUS_PASSWORD  broker 接入密码
#   AGENTBUS_NS        命名空间（默认 default）
#
# 隔离性保证：BROKER/USER/PASSWORD/NS 仅在本脚本执行期间生效，退出时 finally 自动清理，
# 不残留到终端会话，不影响同机其他项目（项目接入信息只读各自 .agentbus/config.json，与环境变量无关）。
# AGENTBUS_PACKAGE 不在此列（可能是用户预置的镜像源，予以保留）。
#
# 内部流程（架构 6.6）：装 agentbus CLI（npm 全局）→ agentbus init --yes（client_id 默认目录名、
# 自动探测可接入工具）→ agentbus doctor 输出报告。任何一步失败即停并给出提示。

$ErrorActionPreference = "Stop"

function Fail([string]$msg) {
    Write-Host ""
    Write-Host "[install] ✗ $msg" -ForegroundColor Red
    exit 1
}

try {

    Write-Host "[install] AgentBus 一键安装（Windows）"

    # 步骤 0：环境检查 —— Node.js >= 18（架构 6.7）、npm 可用
    try {
        $nodeVersion = (& node --version 2>$null)
    } catch { $nodeVersion = $null }
    if (-not $nodeVersion) {
        Fail "未找到 node。请先安装 Node.js >= 18（https://nodejs.org/），装好后重跑本脚本。"
    }
    $major = [int]($nodeVersion -replace '^v', '').Split('.')[0]
    if ($major -lt 18) {
        Fail "Node.js 版本过低（$nodeVersion），AgentBus 需要 >= 18（推荐 20/22 LTS）。"
    }
    try {
        $npmVersion = (& npm --version 2>$null)
    } catch { $npmVersion = $null }
    if (-not $npmVersion) {
        Fail "未找到 npm。请确认 Node.js 安装完整（npm 随 Node 一起分发）。"
    }
    Write-Host "[install] 环境检查通过：node $nodeVersion / npm $npmVersion"

    # 步骤 1：安装 agentbus CLI（npm 全局）
    $pkg = if ($env:AGENTBUS_PACKAGE) { $env:AGENTBUS_PACKAGE } else { "@xiebin1998/agentbus@latest" }
    Write-Host "[install] npm install -g $pkg"
    & npm install -g $pkg
    if ($LASTEXITCODE -ne 0) {
        Fail "npm install -g 失败。请检查网络与 registry（npm config get registry）；离线环境可用 AGENTBUS_PACKAGE 指向本地包路径后重试。"
    }

    # 步骤 2：非交互初始化（client_id 默认目录名，自动探测可接入工具；凭证经环境变量透传）
    $initArgs = @("init", "--yes")
    if ($env:AGENTBUS_BROKER) { $initArgs += @("--broker", $env:AGENTBUS_BROKER) }
    if ($env:AGENTBUS_USER) { $initArgs += @("--user", $env:AGENTBUS_USER) }
    if ($env:AGENTBUS_PASSWORD) { $initArgs += @("--password", $env:AGENTBUS_PASSWORD) }
    if ($env:AGENTBUS_NS) { $initArgs += @("--ns", $env:AGENTBUS_NS) }
    Write-Host "[install] agentbus $($initArgs -join ' ')"
    & agentbus @initArgs
    if ($LASTEXITCODE -ne 0) {
        Fail "agentbus init --yes 失败：常见原因是本机未安装任何 AI CLI（qodercli/kilo/opencode/claude/codex/hermes），请先安装至少一个后重试。"
    }

    # 步骤 3：体检报告
    Write-Host "[install] agentbus doctor"
    & agentbus doctor
    if ($LASTEXITCODE -ne 0) {
        Fail "agentbus doctor 报告异常，请按上方输出逐项处理（broker/SSE 可达性、MCP 注册、daemon 状态）。"
    }

    Write-Host ""
    Write-Host "[install] ✓ 接入完成：本项目已接入 AgentBus 总线（详见上方 doctor 报告）" -ForegroundColor Green

} finally {
    # 清理一行式命令注入的凭证/broker/命名空间：不残留终端会话（也避免明文密码留在 Env:），
    # 不影响其他项目——项目接入信息只读各自 .agentbus/config.json
    foreach ($k in @("AGENTBUS_BROKER", "AGENTBUS_USER", "AGENTBUS_PASSWORD", "AGENTBUS_NS")) {
        if (Test-Path "env:$k") { Remove-Item "env:$k" }
    }
}
