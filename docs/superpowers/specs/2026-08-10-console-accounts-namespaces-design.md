# 四期设计：Web 控制台账号体系与命名空间权限（2026-08-10）

## 背景与目标

三期收官后（main HEAD `2a2b075`），本期五项需求：

1. 结合 UI/UX 技能重构 web 界面及其能力：账号密码登录（无注册），创建命名空间（ns 编号 / 中文名 / 描述），下拉切换 ns，每个 ns 支持账号权限绑定，未授权账号不可见该 ns、也不能用它连 MQTT
2. 全局品牌 `agenthub` → `agentbus`（遗漏修正）
3. 移除旧 flat topic 兼容：`/agenthub/ai/channel/{client_id}/message`
4. 所有接入配置在 web 操作，一键复制一条命令，本地执行即写入配置
5. 指标与命名空间捆绑，按 ns 单独查看

## 已确认的关键决策（brainstorming 结论）

| 决策点 | 结论 |
|---|---|
| 账号 ↔ ns 关系 | 多对多（一账号可授权多个 ns） |
| 注册方式 | 不提供注册；超管创建 ns 时初始化该 ns 的管理员账号 |
| 角色层级 | 三级：`super_admin` / `ns_admin` / `user` |
| 配置下发形态 | 一条 `agentbus init ...` 命令，复制本地执行 |
| 前端形态 | React + Vite + Tailwind + shadcn/ui（引入构建链） |
| 视觉方向 | shadcn 浅色（默认）+ 深色运维台可切换（CSS 变量 + localStorage） |
| 持久化 | SQLite（Python 标准库 sqlite3，零依赖） |
| 超管引导 | `.env` 的 `AGENTBUS_ADMIN_USER/PASSWORD`，users 表为空时启动自动创建 |
| MQTT 权限落地 | mosquitto **dynamic security（dynsec）插件**，运行时管理用户/ACL |
| MQTT 凭证 | 账号用户名 + 同一套密码（web 改密同步写 SQLite 与 dynsec） |

## 架构总览

```
浏览器(React+shadcn/ui) ──HTTP+Cookie──▶ hub(server.py + SQLite)
                                            │ MQTT($CONTROL/dynamic-security/v1)
客户端(daemon) ──MQTT 账号密码──▶ mosquitto(dynsec 插件, dynsec.json 挂卷)
```

- hub 以 dynsec 管理员账号连 broker（凭证来自 `.env`），同一连接兼做消息订阅与 dynsec 管理
- `allow_anonymous false` 安全基线不变；passwd/acl 文件机制退役，由 dynsec.json 取代
- 未授权账号：可连上 broker，但 dynsec ACL 不授予任何 topic，订阅/发布全部被拒

## 数据模型（SQLite，挂卷 `data/agentbus.db`）

```sql
users(username TEXT PK, password_hash TEXT, role TEXT CHECK(role IN ('super_admin','ns_admin','user')), created_at TEXT)
namespaces(id TEXT PK,           -- ns 编号：英文数字，进 topic
           name TEXT NOT NULL,   -- 中文名
           description TEXT DEFAULT '',
           created_at TEXT)
ns_members(ns_id TEXT REFERENCES namespaces(id),
           username TEXT REFERENCES users(username),
           PRIMARY KEY(ns_id, username))
sessions(token TEXT PK, username TEXT, created_at TEXT, expires_at TEXT)
```

密码：bcrypt（passlib 或 bcrypt 包，加入 requirements.txt）。

## MQTT 权限模型（dynsec）

- **一个 ns = 一个 dynsec group**（命名 `ns-<id>`），group 挂两条 ACL：
  - `/agentbus/ai/channel/<id>/#` readwrite
  - `/agentbus/ai/metric/<id>/#` write
- 授权 = 把 dynsec 用户加入 group；解绑 = 移出 group；即时生效无需重载
- hub 的 dynsec 管理模块封装：createClient / deleteClient / setClientPassword / createGroup / addGroupClient / removeGroupClient，经 `$CONTROL/dynamic-security/v1` 发布 JSON 命令并等待响应 topic 校验结果
- broker 容器入口：dynsec.json 不存在时用 `mosquitto_ctrl dynsecinit` 以 `.env` 凭证（`DYNSEC_ADMIN_USER/PASSWORD`）初始化管理员

### 生命周期联动（hub 事务语义）

| Web 操作 | SQLite | dynsec |
|---|---|---|
| 超管建 ns（含初始管理员） | insert ns + user(ns_admin) + ns_member | createClient + createGroup + ACL + addGroupClient |
| ns 管理员建普通账号 | insert user(user) | createClient（暂不入组） |
| 授权账号到 ns | insert ns_member | addGroupClient |
| 解绑 | delete ns_member | removeGroupClient |
| 重置密码 | 更新 password_hash | setClientPassword |
| 删除账号 | delete user + 相关 member | deleteClient |
| 删除 ns | delete ns + 相关 member | deleteGroup |

失败处理：SQLite 先写、dynsec 后写；dynsec 失败则回滚 SQLite 并报错（单一 hub 进程串行操作，无并发冲突）。

## Web 控制台（React + Vite + shadcn/ui）

源码 `web/src`，产物 `web/dist`，hub 静态托管（替换现有单文件 web/index.html）。

### 页面与角色可见性

| 页面 | user | ns_admin | super_admin | 内容 |
|---|---|---|---|---|
| 登录 /login | — | — | — | 用户名 + 密码；无注册入口 |
| 概览 | ✓ | ✓ | ✓ | 当前 ns：在线客户端 / 消息量 / 授权账号数 |
| 账号管理 | — | ✓ 本 ns | ✓ 全部 | 建账号、授权绑定/解绑、重置密码、删除 |
| 指标 | ✓ | ✓ | ✓ | 当前 ns 客户端指标列表 |
| 接入配置 | ✓ | ✓ | ✓ | 按当前账号+当前 ns 生成 init 命令，一键复制 |
| 命名空间管理 | — | — | ✓ | 建 ns（编号/中文名/描述 + 初始管理员）、删 ns |

### 框架行为

- 顶栏：Logo、ns 下拉切换（**仅列当前账号被授权的 ns**）、主题切换（浅色默认/深色，localStorage 记忆）、用户菜单（退出登录）
- 会话：服务端不透明 token + HttpOnly cookie；`GET /api/me` 返回用户、角色、授权 ns 列表
- **UI 美化要求（验收项）**：实现阶段使用 ui-ux-pro-max 设计技能逐页打磨——设计 token、间距层级、状态色、图表配色、深浅主题完整适配

### 主要 API（session cookie 鉴权，全部按角色过滤）

- `POST /api/auth/login` / `POST /api/auth/logout` / `GET /api/me`
- `GET/POST /api/console/namespaces`、`DELETE /api/console/namespaces/{id}`（GET 按授权过滤；POST/DELETE 仅超管，POST body 含初始管理员账号名+密码）
- `GET/POST /api/console/accounts`、`DELETE /api/console/accounts/{u}`、`POST /api/console/accounts/{u}/password`（ns_admin 限本 ns；超管全局）
- `PUT/DELETE /api/console/namespaces/{id}/members/{username}`（绑定/解绑）
- `GET /api/console/metrics?ns=<id>`、`GET /api/console/metrics/summary?ns=<id>`
- `GET /api/console/connect-command?ns=<id>` → 返回 init 命令字符串
- 保留 `/health`；`/sse` 保留且继续由 `MCP_API_TOKEN` 鉴权（MCP 通道与控制台登录态互不影响；token 为空时维持现状免鉴权）
- 旧 console_page（单文件 HTML）与 `/api/console/identities`、`/api/console/permissions*`、`/api/console/teams*` 等旧 API 随本期删除；`/install.ps1`、`/install.sh` 托管保留不变

## topic 迁移与品牌统一（破坏性变更）

- 前缀 `/agenthub/ai/` → `/agentbus/ai/`（channel、metric、dynsec ACL 全量）
- **删除全部 flat 兼容**：server.py `parse_channel_topic`/`parse_metric_topic` 的 flat 分支、TS `protocol.ts` normalize 兼容、broker 侧 flat 通配订阅；老格式消息丢弃并记 warning
- broker 内部账号 `agenthub` → `agentbus`（dynsec/.env 同步）；仓库残留文案清理
- 客户端发 `@xiebin1998/agentbus@0.2.0`（新前缀），老客户端经 `agentbus update` 升级；README 标注 breaking change

## 接入配置下发（需求 4）

- 接入配置页按「当前账号 + 当前 ns」生成：
  `agentbus init --broker <host:18830> --user <账号> --password <密码> --ns <ns编号>`
- 客户端 CLI `init` 新增参数 `--broker / --user / --password / --ns`：提供则非交互直写 config.json（client_id 默认主机名），与现有交互式 init 并存
- 页面提示"命令含密码，注意 shell 历史"

## 指标与 ns 捆绑（需求 5）

- 移除 flat 后 metric 身份恒为 `ns/cid`；metrics/summary API 增加 ns 过滤；指标页仅展示当前选中 ns

## 工程落地

- Dockerfile 多阶段构建：node 阶段 build 前端 → python 阶段 COPY dist；`scripts/` 安装脚本托管保留
- compose 变更：broker 改 dynsec 配置 + `dynsec.json` 挂卷；hub 挂 `data/` 卷（SQLite）；新增 `DYNSEC_ADMIN_USER/PASSWORD` 环境变量（.env.example 同步）
- mosquitto.conf：移除 password_file/acl_file，加 `plugin dynamic-security.so` + `plugin_opt_db_file`
- 不做旧数据迁移：原团队数据本在内存（重启即失），新版由超管重建 ns；文档写明升级步骤

## 测试策略

- Python pytest：鉴权中间件、角色过滤、SQLite store、dynsec 管理模块（mock MQTT 收发）、init 命令生成
- TS vitest：CLI init 新参数、install 脚本契约（更新断言）
- compose 真机冒烟：登录 → 建 ns → 建账号 → 授权 → 客户端用账号连 MQTT 收发成功；未授权账号订阅被拒
- 现有 flat/agenthub 相关契约测试同步改写为新前缀、新语义（RED 先行）

## 非目标（本期不做）

- 自助注册、注册审批流
- ns 内再分级（管理员/成员之外的角色）
- 指标历史曲线图表（保持表格 + 汇总卡片形态）
- 旧数据迁移工具
