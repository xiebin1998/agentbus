# AgentBus（分布式 A2A 通信总线）

把本机 AI CLI（qodercli / kilo / claude / codex / opencode）接入 MQTT Agent 总线，实现跨机器、跨 Agent 的实时通信与协作。

> 本仓库是 AgentBus 的**中心节点**（MQTT Broker + Hub + Web 控制台）；完整设计（协议、三层防线、适配器契约）见 `ARCHITECTURE.md`。

> ⚠️ **四期升级（breaking changes，0.2.0）**——从旧版本升级请先阅读本节：
>
> - **Topic 前缀更名**：`/agenthub/ai/...` → `/agentbus/ai/...`；同时**移除 flat topic**（未带 ns 的旧通道不再支持），所有客户端必须带命名空间。
> - **Broker 认证切换为 dynsec**：不再使用 `mosquitto/config/passwd` + `acl` 静态文件，改用 mosquitto **动态安全插件（dynamic-security）**；账号/角色/ACL 由 hub 经 `$CONTROL` 通道运行时下发。`setup-broker-security.ps1` 现只生成 TLS 证书，首次启动由 `mosquitto/bootstrap.sh` 自动初始化 dynsec 管理员。
> - **控制台改为账号 + 会话登录**：不再用 `MCP_API_TOKEN` Bearer 单一令牌；引入三级角色（`super_admin` / `ns_admin` / `user`），登录下发 session cookie。超管由 `.env` 的 `AGENTBUS_ADMIN_USER/PASSWORD` 引导。
> - **团队模型 → 命名空间 + 账号（多对多）**：删除 `/api/console/teams` 等旧 API；一个账号可属于多个命名空间，一个命名空间可有多个成员。
> - **`.env` 新增变量**：`DYNSEC_ADMIN_USER` / `DYNSEC_ADMIN_PASSWORD`（dynsec 管理员，hub 共享连接用）、`AGENTBUS_ADMIN_USER` / `AGENTBUS_ADMIN_PASSWORD`（控制台超管）。

## 架构一览

```
                    ┌──────────────────────── 服务端（本仓库，docker compose）────────────────────────┐
                    │                                                                                  │
  项目 A ─┐         │  ┌──────────────┐        ┌──────────────┐                                        │
          │ MQTT    │  │ mosquitto    │◄──────►│ agentbus-hub │──► /console 管理页（命名空间/权限/指标）│
  项目 B ─┼────────►│  │ (18830/8883) │        │ (:8000)      │──► /sse + MCP（SDK 直连）              │
  项目 C ─┘         │  └──────────────┘        └──────────────┘                                        │
                    └──────────────────────────────────────────────────────────────────────────────────┘
  每个项目 = agentbus CLI + daemon（常驻）+ 本机 AI CLI 适配器；配置全在 .agentbus/config.json，无需 .env
```

---

# 一、服务端部署（hub + MQTT Broker）

服务端配置分两层：

| 层 | 载体 | 说明 |
|---|---|---|
| hub 参数 | `.env`（本目录） | broker 连接凭证、控制台 token、监听端口，经 `docker-compose.yml` 注入 |
| broker 文件 | `mosquitto/config/`、`mosquitto/certs/` | mosquitto **不支持环境变量替换**，passwd/acl/证书由脚本生成，勿手改 |

### 前置条件

- Docker（含 docker compose）
- PowerShell（pwsh）与 openssl（Git for Windows 自带）

### 1. 首次初始化：安全基线（必做，仅一次）

```powershell
pwsh scripts/setup-broker-security.ps1
# 可选：指定 hub 账号与密码（默认账号 agentbus，密码随机生成）
pwsh scripts/setup-broker-security.ps1 -User agentbus -Password <强密码>
```

生成产物：`mosquitto/config/passwd`（密码文件）、`mosquitto/config/acl`（初始 ACL）、`mosquitto/certs/*`（自签 CA + 服务端证书）。
脚本结束会打印需填入 `.env` 的凭证（`MQTT_USERNAME` / `MQTT_PASSWORD` / `MQTT_CA_CERTS`）。

> ⚠️ 不执行此步直接 `docker compose up`，mosquitto 容器会因缺 passwd/certs 启动失败。

### 2. 配置 `.env`

```bash
cp .env.example .env
# 按脚本输出填入 MQTT_USERNAME / MQTT_PASSWORD；建议设置 MCP_API_TOKEN（控制台/SSE 鉴权）
```

### 3. 启动与验证

```bash
docker compose up -d
docker compose logs -f          # 观察日志
curl http://localhost:8000/health   # 健康检查 + 在线 Agent 列表
```

对外端口：

| 宿主机端口 | 服务 | 说明 |
|---|---|---|
| `18830` | MQTT | 明文（强制密码认证；匿名被拒） |
| `8883` | MQTT over TLS | 自签 CA，推荐生产使用 |
| `9001` | MQTT WebSocket | 强制密码认证 |
| `8000` | hub | SSE / MCP / 控制台 / 安装脚本托管 |

### 4. 日常运维

四期后命名空间与账号全部经控制台 UI（或 `/api/console/*` API）管理，broker 侧 dynsec 组/角色/ACL 由 hub 自动编排：

- **建命名空间**：控制台 → 命名空间 → 创建（同时创建 ns 管理员账号与 broker 组/角色）
- **建账号 / 入组**：控制台 → 账号 → 创建；命名空间页管理成员（多对多绑定）
- **接入凭证**：控制台 → 接入命令 → 选 ns → 重输密码 → 一键复制 `agentbus init ...`

### 5. Web 控制台

浏览器打开 `http://<host>:8000/console/`，账号 + 密码登录（session cookie，超管由 `.env` 的 `AGENTBUS_ADMIN_USER/PASSWORD` 引导）：

- **命名空间**：清单、创建（含 ns 管理员）、删除、成员管理
- **账号**：清单、ns 过滤、创建、删除、改密
- **指标**：按 ns 查看 daemon 注入成功/失败/去重/丢弃/积压计数与明细表，5s 自动刷新
- **接入命令**：按 ns 生成 `agentbus init` 模板，重输密码后拼接完整命令一键复制
- **主题**：顶栏支持明/暗模式与蓝/紫强调色双切换（localStorage 持久化）

### 服务端配置参考（`.env` 全集）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MQTT_BROKER_HOST` | `localhost` | broker 地址（compose 内自动为 `mqtt-broker`） |
| `MQTT_BROKER_PORT` | `1883` | broker 端口 |
| `MQTT_USERNAME` | 空 | hub 连接 broker 的账号（setup 脚本生成） |
| `MQTT_PASSWORD` | 空 | 对应密码 |
| `MQTT_USE_TLS` | `false` | hub 是否走 TLS 连接 broker |
| `MQTT_CA_CERTS` | 空 | 自签 CA 路径（TLS + 自签证书时必填） |
| `MCP_HOST` | `0.0.0.0` | hub 监听地址 |
| `MCP_PORT` | `8000` | hub 监听端口 |
| `MCP_API_TOKEN` | 空 | MCP/SSE 通道鉴权 token；**非空启用**，空=全开放（仅调试用；控制台走账号会话登录） |

---

# 二、客户端接入

> **客户端不使用 `.env`**：每个项目的接入配置全部写在项目目录的 `.agentbus/config.json`，通过 CLI 交互生成，或由管理员从控制台/脚本分发凭证后填入。

### 前置：向管理员领取

| 项目 | 说明 |
|---|---|
| broker 地址/端口 | 如 `hub.example.com:8883`（TLS）或 `:18830`（明文） |
| 团队账号 | `team-<团队名>` + 密码（`sync-broker-acl.ps1` 输出） |
| CA 证书 | `ca.crt` 文件（仅 TLS；**是文件不是变量**，放入本机任意路径） |
| 命名空间 | 如 `iot` |

### 方式一：一键安装脚本（推荐，干净机器一条命令）

```powershell
# Windows
iwr https://<hub地址>:8000/install.ps1 | iex
```
```bash
# macOS / Linux
curl -fsSL https://<hub地址>:8000/install.sh | bash
```

可选环境变量：`AGENTBUS_PACKAGE`（npm 包来源，可指本地 tarball 离线安装）、`AGENTBUS_BROKER`（broker host:port）、`AGENTBUS_NS`（命名空间）。
脚本流程：Node>=18 检查 → npm 全局装 CLI → `agentbus init --yes`（自动探测已装 AI CLI）→ `agentbus doctor` 体检，任一步失败即停并给提示。

### 方式二：npm 手动安装

```bash
npm i -g @xiebin1998/agentbus        # 或本地包目录
cd 你的项目目录
agentbus init                    # 交互式：broker 地址/凭证/命名空间/工具选择 → 写配置、注册 MCP、装 skill、拉起 daemon
# 四期非交互形式（控制台“接入命令”页复制）：
agentbus init --yes --broker <host:port> --user <账号> --password <密码> --ns <命名空间>
agentbus doctor                  # 体检：配置/broker/SSE/CLI/MCP 注册/daemon/隔离 逐项检查
agentbus status                  # daemon 连接状态与会话摘要
```

> 凭证落盘于 `.agentbus/config.json`（含密码）：init 会自动保障 `.agentbus/` 入项目 `.gitignore`，勿手动移除。

### 方式三：MCP SDK 直连（不经 CLI/daemon）

自建 Agent 可直连 hub 的 SSE 通道，用 MCP 工具收发：

```bash
# SSE 连接（token 鉴权时带 query 或 Header）
GET /sse?client_id=qwenpaw&token=<MCP_API_TOKEN>
GET /sse    （Header: x-client-id: qwenpaw, Authorization: Bearer <token>）
```

流程：连接 SSE → `register_agent`（必须先注册）→ `send_message` 发送 / 收 SSE 推送。

### 客户端更新

在已接入的项目目录执行一条命令即可：

```bash
agentbus update        # npm 升级最新版 → 停旧 daemon；随后 agentbus daemon start 拉起新版
agentbus doctor        # 更新后体检确认
```

> ⚠️ **不要重跑 `iwr …/install.ps1 | iex` 来更新**：安装脚本内的 `init --yes` 会用默认值覆盖既有
> `.agentbus/config.json`（broker 地址/团队凭证/命名空间）。update 只动 npm 包与 daemon 进程，
> 配置、MCP 注册、skill 均不受影响；离线环境同样支持 `AGENTBUS_PACKAGE` 指本地包。

### CLI 命令参考

| 命令 | 说明 |
|---|---|
| `agentbus init [--yes] [--tools …] [--ns …] [--broker host:port] [--user …] [--password …]` | 初始化接入（写配置、注册 MCP、装 skill、拉起 daemon；四期起 broker 强制认证，凭证由控制台“接入命令”页一键复制） |
| `agentbus update` | 一键更新（npm 升级 → 停旧 daemon；配置/MCP/skill 不动） |
| `agentbus doctor` | 环境体检（配置/broker/SSE/CLI/MCP/daemon/隔离） |
| `agentbus status` | daemon 状态与会话摘要 |
| `agentbus uninstall [--yes]` | 完整卸载（停 daemon、移除注册/skill/配置，零残留） |
| `agentbus daemon start\|stop\|status` | daemon 生命周期（start 为前台运行） |
| `agentbus autostart install\|uninstall\|status` | 开机自启（Windows HKCU Run / Linux systemd --user，幂等） |
| `agentbus isolate apply\|remove\|status` | 工作目录 OS 级只读隔离（手动锁/解锁；daemon 残留时的恢复出口） |

### 客户端配置参考（`.agentbus/config.json`）

| 字段 | 说明 |
|---|---|
| `client_id` | 本机总线身份（默认取目录名） |
| `ns` | 命名空间（缺省 `default`） |
| `broker.host` / `broker.port` | broker 地址与端口 |
| `broker.username` / `broker.password` | 团队账号凭证 |
| `broker.tls` / `broker.ca` | TLS 开关与自签 CA 证书路径（支持 `${ENV}` 引用） |
| `sse_url` | hub SSE 地址（doctor 检查项） |
| `default_tool` | 入站默认承接工具 |
| `allowed_senders` | 白名单（空=全放行） |
| `inbound_mode` | 入站默认权限：`readonly`（注入只读禁令）/ `full` |
| `trust_map` | 按发件人提权/降权：`{ "ci-bot": "full" }` |
| `tools.<名>` | 各工具适配器参数（binary/workspace/remote…） |
| `ack` | 是否回 ack 回执 |
| `isolation` | OS 级只读隔离开关（可选，默认关；开启后 readonly 回合在 OS 层物理禁写，`agentbus doctor` 检查工具链） |

---

# 三、协议与 API 参考

### Topic 规则

```
/agentbus/ai/channel/{ns}/{client_id}/message   # 带命名空间（唯一形态）
/agentbus/ai/metric/{ns}/{client_id}            # daemon 指标上报
```

账号受 dynsec ACL 约束：仅能读写所属命名空间的 topic 前缀，跨命名空间 publish 会被 broker 丢弃（订阅者收不到）。

### 消息格式

```json
{
  "id": "msg-abc123",
  "from": "qwenpaw",
  "to": "hermes",            // 或数组多人发送
  "text": "消息内容",
  "type": "text",            // text / control
  "hop": 0,
  "expect_reply": true,
  "timestamp": "2026-08-10T10:30:00Z"
}
```

### MCP 工具（SDK 直连用）

| 工具 | 参数 | 说明 |
|------|------|------|
| `register_agent` | `name`, `description`, `capabilities`, `metadata?` | 注册 Agent（必须先调用） |
| `update_agent` | `capabilities?`, `metadata?` | 更新能力信息 |
| `send_message` | `text`, `to`, `type?` | 发送消息（需先注册） |
| `ack_message` | `id` | 确认收到消息 |
| `list_agents` | - | 列出所有 Agent 及能力 |
| `get_agent_info` | `client_id` | 查询 Agent 详细信息 |
| `find_agents_by_capability` | `capability` | 按能力查找 Agent |
| `get_status` | - | 获取当前状态 |

### HTTP 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查（始终开放，不受 token 约束） |
| `/sse` | GET | SSE 连接入口（token 鉴权） |
| `/messages/` | POST | MCP 消息处理 |
| `/console` | GET | Web 控制台单页应用 |
| `/api/console/namespaces` | GET/POST | 命名空间清单/声明 |
| `/api/console/identities` | GET | 身份检索 |
| `/api/console/permissions[/{identity}]` | GET/PUT | 权限查看/编辑下发 |
| `/api/console/metrics[/summary]` | GET | 指标/汇总 |
| `/api/console/teams` | GET/POST/DELETE | 团队管理 |
| `/install.ps1`、`/install.sh` | GET | 客户端一键安装脚本托管 |

---

## 开发与测试

```bash
# hub（Python）
py -m pytest -q                    # 119+ 用例
# 客户端（TypeScript）
cd agentbus && npm install && npm run build && npx vitest run   # 392 用例
```

## 目录结构

```
agentbus/
├── server.py              # hub 主服务（SSE/MCP/控制台/共享 MQTT 连接）
├── requirements.txt       # Python 依赖
├── Dockerfile / docker-compose.yml   # 服务端编排（broker + hub）
├── .env.example           # 服务端环境变量全集（hub 参数）
├── mosquitto/
│   ├── config/            # mosquitto.conf + passwd/acl（脚本生成）
│   └── certs/             # 自签 CA 与服务端证书（脚本生成）
├── scripts/               # setup-broker-security / sync-broker-acl / install / loadtest …
├── tests/                 # hub pytest 单测
├── agentbus/              # Node CLI + daemon + 适配器（客户端，npm 包）
│   ├── src/               # cli/config/protocol/daemon/adapters/init/doctor/isolate…
│   └── tests/             # vitest 单测与集成测试
├── docs/                  # 验收报告
├── README.md
└── LICENSE                # Apache License 2.0
```

## 许可证

[Apache License 2.0](LICENSE)
