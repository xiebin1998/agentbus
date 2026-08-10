#!/usr/bin/env bash
# AgentBus 一键安装（macOS / Linux）—— 架构 6.6 / TASK-28
#
# 用法（干净机器一条命令接入）：
#   curl -fsSL https://<host>/install.sh | bash
#
# 可选环境变量：
#   AGENTBUS_PACKAGE  npm 包来源（默认 @xiebin1998/agentbus@latest；可指本地目录/tarball 供离线安装）
#   AGENTBUS_BROKER   broker host:port（默认 localhost:18830）
#   AGENTBUS_NS       命名空间（默认 default）
#
# 内部流程（架构 6.6）：装 agentbus CLI（npm 全局）→ agentbus init --yes（client_id 默认目录名、
# 自动探测可接入工具）→ agentbus doctor 输出报告。任何一步失败即停并给出提示。

set -euo pipefail

fail() {
  echo ""
  echo "[install] ✗ $1" >&2
  exit 1
}

echo "[install] AgentBus 一键安装（macOS/Linux）"

# 步骤 0：环境检查 —— Node.js >= 18（架构 6.7）、npm 可用
command -v node >/dev/null 2>&1 || fail "未找到 node。请先安装 Node.js >= 18（https://nodejs.org/ 或发行版包管理器），装好后重跑本脚本。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js 版本过低（$(node --version)），AgentBus 需要 >= 18（推荐 20/22 LTS）。"
fi
command -v npm >/dev/null 2>&1 || fail "未找到 npm。请确认 Node.js 安装完整（npm 随 Node 一起分发）。"
echo "[install] 环境检查通过：node $(node --version) / npm $(npm --version)"

# 步骤 1：安装 agentbus CLI（npm 全局）
PKG="${AGENTBUS_PACKAGE:-@xiebin1998/agentbus@latest}"
echo "[install] npm install -g $PKG"
npm install -g "$PKG" || fail "npm install -g 失败。请检查网络与 registry（npm config get registry）；离线环境可用 AGENTBUS_PACKAGE 指向本地包路径后重试。"

# 步骤 2：非交互初始化（client_id 默认目录名，自动探测可接入工具）
INIT_ARGS=(init --yes)
[ -n "${AGENTBUS_BROKER:-}" ] && INIT_ARGS+=(--broker "$AGENTBUS_BROKER")
[ -n "${AGENTBUS_NS:-}" ] && INIT_ARGS+=(--ns "$AGENTBUS_NS")
echo "[install] agentbus ${INIT_ARGS[*]}"
agentbus "${INIT_ARGS[@]}" || fail "agentbus init --yes 失败：常见原因是本机未安装任何 AI CLI（qodercli/kilo/opencode/claude/codex/hermes），请先安装至少一个后重试。"

# 步骤 3：体检报告
echo "[install] agentbus doctor"
agentbus doctor || fail "agentbus doctor 报告异常，请按上方输出逐项处理（broker/SSE 可达性、MCP 注册、daemon 状态）。"

echo ""
echo "[install] ✓ 接入完成：本项目已接入 AgentBus 总线（详见上方 doctor 报告）"
