# AgentBus Hub（MCP ↔ MQTT 中枢服务）

Agent 实时通信桥接服务，支持多个 Agent (qwenpaw, hermes, codex...) 互相实时通信。

> 本仓库是 AgentBus 分布式 A2A 方案的**中心节点**；完整方案（agentbus CLI、守护进程、多工具适配器、团队命名空间、分布式部署）见 `ARCHITECTURE.md`。

## 功能特性

- ✅ **强制注册**：Agent 必须先注册才能发送消息
- ✅ **能力管理**：注册时声明 capabilities，其他 Agent 可查询
- ✅ **实时推送**：MQTT 消息到达后立即通过 SSE 推送，毫秒级感知
- ✅ **多人推送**：支持同时向多个 Agent 发送消息
- ✅ **按能力查找**：根据 capability 查找对应的 Agent

## 技术栈

- **语言**: Python 3.11+
- **框架**: Starlette (ASGI)
- **协议**: MCP (Model Context Protocol) + MQTT
- **服务器**: Uvicorn

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 复制环境变量配置
cp .env.example .env

# 启动服务（包含 MQTT Broker）
docker-compose up -d

# 查看日志
docker-compose logs -f
```

### 方式二：本地运行

```bash
# 安装依赖
pip install -r requirements.txt

# 配置环境变量
export MQTT_BROKER_HOST=localhost
export MQTT_BROKER_PORT=1883

# 启动服务
python server.py
```

## AgentBus CLI 快速上手（一期，本地项目接入总线）

前置：hub 与 broker 已按上面任一方式运行；本机装有至少一个受支持 CLI（qodercli/kilo/claude/codex/opencode）。

```bash
cd agentbus          # Node 包目录
npm install
npm run build

# 在你的项目目录里一条命令接入（非交互）：
# 探测已装 CLI → 生成 .agentbus/config.json → 安装 Skill/AGENTS.md 兜底块
# → 注册 MCP（回写验证）→ 拉起 daemon
node <agentbus包路径>/dist/cli.js init --yes

# 体检（配置/broker/SSE/CLI/MCP 注册/daemon 六项）
node <agentbus包路径>/dist/cli.js doctor

# 查看 daemon 状态与会话摘要
node <agentbus包路径>/dist/cli.js status
```

接入后，支持 MCP 的 CLI 会话即可通过 `agentbus` MCP 服务器使用总线：`list_agents` 查在线同伴、`send_message` 跨 Agent 发消息，收到的 `[AgentBus]` 信封消息按 Skill 约定回复。完整设计见 `ARCHITECTURE.md`，一期验收见 `docs/acceptance-phase1.md`。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MQTT_BROKER_HOST` | `localhost` | MQTT Broker 地址 |
| `MQTT_BROKER_PORT` | `1883` | MQTT Broker 端口 |
| `MQTT_USERNAME` | 空 | MQTT 认证用户名 |
| `MQTT_PASSWORD` | 空 | MQTT 认证密码 |
| `MQTT_USE_TLS` | `false` | 是否启用 TLS |
| `MCP_HOST` | `0.0.0.0` | MCP 服务监听地址 |
| `MCP_PORT` | `8000` | MCP 服务监听端口 |

## 连接方式

Agent 通过 SSE 连接：

```bash
# Query 参数
GET /sse?client_id=qwenpaw

# 或 Header
GET /sse
Header: x-client-id: qwenpaw
```

## MCP 工具列表

### 注册相关

| 工具 | 参数 | 说明 |
|------|------|------|
| `register_agent` | `name`, `description`, `capabilities`, `metadata?` | 注册 Agent（必须先调用） |
| `update_agent` | `capabilities?`, `metadata?` | 更新能力信息 |

### 消息相关

| 工具 | 参数 | 说明 |
|------|------|------|
| `send_message` | `text`, `to`, `type?` | 发送消息（需先注册） |
| `ack_message` | `id` | 确认收到消息 |

### 查询相关

| 工具 | 参数 | 说明 |
|------|------|------|
| `list_agents` | - | 列出所有 Agent 及能力 |
| `get_agent_info` | `client_id` | 查询 Agent 详细信息 |
| `find_agents_by_capability` | `capability` | 按能力查找 Agent |
| `get_status` | - | 获取当前状态 |

## 使用流程

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Agent 连接 SSE                                               │
│     GET /sse?client_id=qwenpaw                                  │
│                                                                  │
│  2. 调用 register_agent 注册                                     │
│     register_agent(                                             │
│         name="QwenPAW Agent",                                   │
│         description="智能助手",                                  │
│         capabilities=["text_analysis", "data_query"]            │
│     )                                                            │
│                                                                  │
│  3. 发送消息                                                     │
│     send_message(text="你好", to="hermes")                      │
│                                                                  │
│  4. 按能力查找 Agent                                             │
│     find_agents_by_capability(capability="data_query")          │
└─────────────────────────────────────────────────────────────────┘
```

## Topic 规则

```
# 带命名空间（ns 参数显式传入）
/phnix/ai/channel/{ns}/{client_id}/message

# 兼容旧 flat（未传 ns）
/phnix/ai/channel/{client_id}/message
```

- **订阅**: Agent 订阅自己的 topic
- **发布**: 发送到目标的 topic

## 消息格式

```json
{
    "id": "msg-abc123",
    "from": "qwenpaw",
    "to": "hermes",
    "text": "消息内容",
    "type": "text",
    "timestamp": "2025-01-15T10:30:00Z"
}
```

### 多人发送

```json
{
    "to": ["hermes", "codex", "claude"],
    "text": "大家好"
}
```

## Agent 信息结构

```json
{
    "client_id": "qwenpaw",
    "name": "QwenPAW Agent",
    "description": "智能助手",
    "capabilities": ["text_analysis", "data_query"],
    "registered": true,
    "connected_at": "2025-01-15T10:00:00Z",
    "registered_at": "2025-01-15T10:01:00Z"
}
```

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 + 在线 Agent 列表 |
| `/sse` | GET | SSE 连接入口 |
| `/messages/` | POST | MCP 消息处理 |

## 目录结构

```
agentbus/
├── server.py              # 主服务代码（hub）
├── requirements.txt       # Python 依赖
├── Dockerfile             # Docker 构建文件
├── docker-compose.yml     # Docker Compose 编排
├── .env.example           # 环境变量示例
├── mosquitto/             # MQTT Broker 配置
│   └── config/
│       └── mosquitto.conf
├── agentbus/              # Node CLI + daemon（一期）
│   ├── src/               # cli/config/protocol/daemon/adapters/init/doctor…
│   ├── tests/             # vitest 单测与集成测试
│   └── scripts/           # dev-broker / smoke-daemon 冒烟脚本
├── scripts/               # hub 冒烟与长跑脚本（smoke_hub.py / soak_loop.ps1）
├── tests/                 # server.py pytest 单测
├── docs/                  # 验收报告等
└── README.md              # 项目文档
```

## 许可证

MIT
