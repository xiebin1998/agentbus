# AgentBus 排期计划

> 版本：v1.0 | 日期：2026-08-09 | 依据：ARCHITECTURE.md v1.5
> 估算假设：**1 名全职开发者**，单位为"人日"；1 冲刺 = 1 周（5 个工作日，含缓冲）
> 阅读约定：每个功能含【内容】【依赖】【详细步骤】【验收标准】【估算】五要素；⚠️ 标记待实测项

---

## 1. 总览

### 1.1 三阶段概览

| 阶段 | 主题 | 功能数 | 工作量 | 里程碑 |
|---|---|---|---|---|
| 一期 MVP | 总线端到端 + Qoder/Kilo 双适配器 + 安全基线机制 | 9 项（T1–T9） | ~21.5 人日（5 周） | Qoder ↔ Kilo 跨工具互发消息、自动建会话、只读应答 |
| 二期 | 补齐四适配器 + Web 管理控制台 | 9 项（T10–T18） | ~17.5 人日（4 周） | 六工具全接入；控制台可视化 ns/权限/指标 |
| 三期 | 体验、规模与账号体系 | 8 项（T19–T26） | ~15 人日（3 周） | 跨公网部署、万级容量、团队权限化 |

合计约 54 人日 ≈ 12 周（单人）；双人并行（中心节点侧 / 客户端侧）可压缩至 7–8 周。

### 1.2 依赖关系总图

```
T1 server.py ns改造 ──┬─> T2 协议字段 ─> T4 daemon核心 ─┬─> T6 信封/只读/代回 ─┐
                     │                                  ├─> T5 适配器框架      ├─> T9 集成验收
T3 CLI骨架 ──────────┴──────────────────────────────────┴─> T7 Skill契约 ─────┤
                                                           └─> T8 init/doctor ─┘
一期完成后 ──> T10~T14 适配器补齐 ──> T15 指标上报 ──> T16/T17 Web控制台
三期：T21 安全基线 ──> T22 账号/团队；T20 扩容独立；T23~T26 独立
```

---

## 2. 一期：MVP（~21.5 人日）

### T1 server.py 命名空间改造与内存治理（3 人日）

**内容**：hub 侧支持 ns 参数与 ns topic（兼容旧 flat topic）、跨 ns 寻址、`@tool` 透传；同步修复 11.8 缺陷清单第 1–7 条。这是全链路的地基，必须最先完成且独立可测。

**依赖**：无（可立即开工）。

**详细步骤**：
1. 全局身份改键：`_sessions` / `_agent_info` 的 key 由 `client_id` 改为 `<ns>/<client_id>`（无 ns 时键为 `default/<client_id>` 但 topic 走 flat，保持兼容）
2. `sse_endpoint` 解析 `ns` query 参数（缺省 `default`）；`AgentSession.__init__` 增加 ns 参数
3. `sub_topic` 计算：未显式传 ns 的连接 → flat topic `/agenthub/ai/channel/{client_id}/message`；显式传 ns → `/agenthub/ai/channel/{ns}/{client_id}/message`（兼容规则见架构 3.1）
4. `send_message` 目标解析：`to` 支持 `<ns>/<client_id>`（跨 ns，publish 到对应 ns topic）与 `<client_id>@<tool>`（topic 仅取 client_id 段，`@tool` 保留在 payload 供 daemon 消费）；数组逐个解析
5. 顺手修缺陷：群发改部分送达 + 返回失败列表（11.8-7）；text 长度上限 64KB（11.8-5）；`ack_message` 校验消息 from/to 与调用者相关（11.8-4）；`get_event_loop()` → `get_running_loop()`（11.8-3）
6. 内存治理：`_messages` 改 `deque(maxlen=10000)` + 每日定时清 TTL 过期项；SSE 断开时清理 `_agent_info`（未 registered 直删，registered 保留但标记离线，`list_agents` 区分在线/离线）
7. `/health` 输出增加 ns 维度分组
8. 回归测试：旧 flat 客户端（不带 ns）收发不受影响

**验收标准**：
- 不带 ns 的旧客户端行为零变化（兼容回归通过）
- 同 ns 互通、跨 ns `to=iot/be-svc` 送达、`@tool` 不破坏 topic
- 连续发送 2 万条消息后内存平稳（deque 上限生效）；SSE 断开后 `list_agents` 不再残留离线会话

---

### T2 协议字段与类型层（1.5 人日）

**内容**：在 Node 侧定义总线消息的完整 TypeScript 类型与缺省值兼容逻辑，为 daemon/adapter 提供单一事实来源（协议字段：`type=control` / `hop` / `reply_to` / `expect_reply`，见架构 3.2）。

**依赖**：T1（需确认 hub 透传行为）。

**详细步骤**：
1. 新建 `src/protocol.ts`：`BusMessage` 接口（id/from/redirect_client_id/to/text/type/reply_to/hop/expect_reply/timestamp）
2. `normalize()`：入站消息补缺省值（`type→text`、`hop→0`、`reply_to→null`、`expect_reply→true`），兼容旧客户端
3. `makeAck()`：统一 ack 组装（`type=control`、`expect_reply=false`、`hop+1`）
4. `makeReply()`：代回复组装（`reply_to`=原 id、`hop+1`、`expect_reply=false`）
5. msg id 生成器（`msg-` + 12 位 hex）
6. 单元测试覆盖所有缺省/边界分支

**验收标准**：协议单测全绿；非法 JSON / 缺字段消息不抛异常、按缺省值处理。

---

### T3 agentbus CLI 骨架与配置系统（2 人日）

**内容**：npm 包工程化 + commander 命令注册 + `.agentbus/config.json` 读写与校验（含 `${ENV_VAR}` 凭证解析，见架构 4.4 / 8.3）。

**依赖**：无（可与 T1 并行）。

**详细步骤**：
1. 初始化 `agentbus/` 子包：package.json（`bin: agentbus`、`engines.node>=18`）、tsconfig、构建脚本（tsc → dist）
2. commander 注册六个命令骨架：`init [--yes]` / `uninstall` / `doctor` / `status` / `daemon start|stop|status`
3. `config.ts`：config.json 读写 + 字段校验（client_id/ns/broker/sse/default_tool/allowed_senders/hop_limit/rate_limit/inbound_mode/trust_map/tools/ack）；校验失败输出人类可读错误
4. `${ENV_VAR}` 解析器：启动时替换 broker.username/password；未设置 → 明确报配置错误（不带病运行）
5. 统一日志与退出码约定（供 doctor/status 复用）

**验收标准**：`agentbus --version` 可用；合法/非法 config 各有正确行为；环境变量缺失时报错指明字段名。

---

### T4 Daemon 核心：MQTT + 路由 + 注册表（4 人日）

**内容**：一期最大块。实现架构 4.1/4.2 全部路由规则（0–8 步）、sessions.json 注册表（4.3）、MQTT 连接语义（5.3）、日志与 pid 管理。

**依赖**：T1、T2、T3。

**详细步骤**：
1. **MQTT 层**（listener.ts）：mqtt.js 连接（`cleanSession:false`、固定 clientId `agentbus-<ns>-<client_id>`、自动重连退避）；订阅 `/agenthub/ai/channel/<ns>/<client_id>/message`
2. **路由管线**：按 4.2 步骤 0–8 顺序实现——白名单 → 去重 LRU(1000) → hop 熔断 → control 短路 → 工具判定（`@tool` / default_tool）→ 速率限制（60s/5 条，队列>20 丢最旧）→ 会话查询 → ack
3. **注册表**（registry.ts）：sessions.json 原子写（tmp + rename）；读失败回退空表重建；sender 为主键的增删改查
4. **队列**：每工具独立 FIFO 队列，串行消费（注入动作在 T5/T6 落地，此处先留注入回调接口）
5. **日志**：daemon.log（运行）+ messages.log（收发明细，含路由决策原因），按大小轮转
6. **pid 管理**：daemon.pid 写入；start 时 stale 检测（pid 存在但进程已死 → 接管）
7. `daemon start/stop/status` 子命令接真实逻辑（stop 优雅断开 MQTT）
8. 集成自测：脚本模拟 publish 各类消息（正常/白名单外/超 hop/重复 id/control/限速溢出），验证路由决策与日志

**验收标准**：
- 八类异常消息各有正确处置且日志可查
- kill -9 daemon 后 sessions.json 无损坏；stale pid 可接管
- 断网重连后订阅自动恢复

---

### T5 适配器框架 + Qoder/Kilo 适配器（3 人日）

**内容**：Adapter 统一接口（架构 5.1）+ 子进程执行器 + 首批两个实测过的适配器（5.2 表）。

**依赖**：T3、T4（注入回调接入）。

**详细步骤**：
1. `base.ts`：Adapter 接口 + 通用 spawn 执行器（超时 10 分钟 kill、stdout/stderr 收集、退出码处理）
2. `qoder.ts`：createSession = `qodercli --session-id <uuid> -n <来源> -p <msg>`（uuid 由 daemon 生成）；inject = `qodercli --resume <id> -p <msg>`；输出提取 `--output-format json`；available() 探测 `qodercli`
3. `opencode-kilo.ts`（二进制名参数化）：createSession = `kilo run --title <来源> <msg>`；inject = `kilo run -s <id> <msg>`；输出提取 `--format json` 末条文本事件
4. 免确认/只读参数表：每个适配器内置 `fullArgs()` / `readonlyArgs()` 两个参数集（一期 Qoder/Kilo 只读档 ⚠️ 待实测，先按 `dont_ask`/`--auto` + 信封约束回退）
5. 失败兜底：注入失败重试 1 次（重试前查去重 LRU）→ 落 `.agentbus/inbox/<tool>/`
6. 与 T4 队列对接：队列消费器调用 adapter.createSession/inject

**验收标准**：
- 本机 qodercli / kilo 各自完成"建会话 + 续接注入"实测
- 注入超时能 kill 且不阻塞队列后续消息
- 失败消息在 inbox 可见

---

### T6 注入信封 + 只读信任分级 + 代回通道（2.5 人日）

**内容**：一期安全与请求-响应核心。落地架构 4.6（信封 + stdout 代回）与 4.7（inbound_mode/trust_map → CLI 参数）。

**依赖**：T4、T5。

**详细步骤**：
1. `envelope.ts`：信封模板组装（`[AgentBus]` 元数据行 + 只读/回复指令 + 原文），字段取自消息与 trust 判定结果
2. 信任判定器：`inbound_mode` + `trust_map` → readonly/full（仅 allowed_senders 内生效；发送方声明无效）
3. 注入链路改造：队列消费 → 包信封 → 按信任级别选参数 → adapter.inject
4. **代回通道**：`expect_reply=true` 时捕获 inject().output → `makeReply()` → 经既有 MQTT 连接 publish 到发件人 topic
5. `expect_reply=false` 不捕获不回传；control 消息仅记日志
6. 失败通知：注入超时/非零退出 → 向发件人发 `type=control` 失败通知
7. 实测验证（Claude plan / Codex read-only 属二期适配器，一期先验信封与代回骨架）

**验收标准**：
- 一次"入站 → 只读回合 → 代回"全链路在 Qoder/Kilo 上跑通
- readonly 回合实测无法修改工作区文件（以可用工具的只读档验证）
- 代回消息 `reply_to`/`hop`/`expect_reply=false` 三字段正确，对方不再回

---

### T7 Skill 契约 + 工具描述强化（1.5 人日）

**内容**：Agent 识别与精准控制（架构 5.6）：init 安装 agentbus Skill、AGENTS.md 兜底块、server.py 工具描述强化 + `readOnlyHint` 注解。

**依赖**：T1（server.py 描述改造）、T3。

**详细步骤**：
1. SKILL.md 模板（正文不硬编码身份，运行时读 `.agentbus/config.json`；含出站触发条件/入站信封处理/红线）
2. skill 安装器：按支持矩阵写入各工具 skill 目录（Claude `.claude/skills/agentbus/` ⚠️ 其余工具路径逐个实测确认）；幂等（存在则更新）
3. AGENTS.md 托管块工具库：`<!-- AGENTBUS:BEGIN/END -->` 插入/更新/删除，绝不覆盖已有内容
4. server.py：`send_message` 等工具 description 写明使用边界；`list_agents`/`get_agent_info`/`send_message` 声明 `ToolAnnotations(readOnlyHint=true)`（mcp 1.2.0 兼容性验证）
5. `uninstall` 时 skill 与托管块整块移除（命令本体在 T10，此处提供删除函数）

**验收标准**：
- Qoder/Kilo 会话中能识别并按 skill 约定使用 agentbus 工具（人工对话验证）
- 只读模式下 `send_message`/`list_agents` 免确认可调（readOnlyHint 生效）
- 托管块插入/删除不损伤已有 AGENTS.md 内容

---

### T8 agentbus init / doctor / status（2.5 人日）

**内容**：用户体验主入口（架构 6.1–6.5）：交互式初始化、MCP 注册、环境体检、状态查看。

**依赖**：T3、T4、T7。

**详细步骤**：
1. `@inquirer/prompts` 交互流：ns（默认 default）→ client_id（默认目录名）→ 工具多选（实时探测 ✓/✗，未装默认不选）→ scope（project 置顶默认）→ broker 地址 → SSE URL；勾选多工具时强制指定 default_tool；引导填 allowed_senders
2. CLI 探测：qodercli/kilo/claude/codex/opencode 逐个 which/where
3. 写 `.agentbus/` 骨架（config.json + logs/ + inbox/）+ 安装 skill + AGENTS.md 托管块
4. **MCP 注册器**（installers/，严格执行 6.5-D 七条红线）：Claude/Qoder 走 CLI `-s project`；Kilo 直写 `.kilo/kilo.json`（mcp 键、type=remote、UTF-8 无 BOM）；OpenCode 直写 `opencode.json`；Codex 回退全局并明确告知；`.mcp.json` 读-合并-写（禁整文件覆盖）
5. init 收尾：拉起 daemon（已在跑则跳过），输出初始化报告
6. `init --yes [--client-id ...] [--tools ...] [--scope ...]` 非交互等价实现
7. `doctor`：docker 服务 / broker 连通 / SSE 连通 / 各 CLI / MCP 注册回写验证（`<工具> mcp list`）/ daemon 状态，逐项输出报告
8. `status`：daemon 连接状态 + 订阅 topic + sessions.json 摘要 + 各工具连通性

**验收标准**：
- 干净项目一条 `agentbus init` 到 daemon 在线全绿
- `init --yes` 与交互式结果一致（CI 可用）
- doctor 能准确定位每一类故障（断 broker / 缺 CLI / 注册失败）

---

### T9 集成联调与验收（1.5 人日）

**内容**：一期收尾，执行架构第 10 章全部验收项，产出验收报告与 README 快速上手。

**依赖**：T1–T8 全部完成。

**详细步骤**：
1. 端到端主链路：Qoder 会话给 Kilo 发消息 → Kilo 自动建会话（名=来源）并响应 → 回消息到 Qoder 会话
2. 安全验收：非白名单来源被丢弃并告警；两 agent 互回复在 hop_limit 熔断；同一 msg id 重复投递不产生二次注入
3. 只读验收：readonly 入站回合无法写文件；代回内容正确
4. 跨机验收（条件允许）：两台机器接同一 broker 互通
5. 长跑稳定性：daemon 挂机 24h，内存/日志/重连观察
6. 撰写 README 快速上手 + 验收报告归档

**验收标准**：架构第 10 章一期验收清单逐项勾选通过。

---

## 3. 二期：补齐适配器 + Web 管理控制台（~17.5 人日）

### T10 agentbus uninstall（1 人日）

**内容**：完整卸载本项目接入（架构 6.1）。
**依赖**：一期完成。
**步骤**：停 daemon → 删 daemon.pid → 按 scope 移除各工具 MCP 注册（`.mcp.json` 只删 agentbus 键、Kilo/OpenCode 删键、Codex 全局条目删除）→ 移除 skill 目录与 AGENTS.md 托管块 → 询问是否保留 `.agentbus/`（logs/inbox 可能有人工数据）。
**验收**：卸载后 doctor 显示零残留；用户文件（除 agentbus 键/块）无损。

### T11 Claude Code 适配器（1.5 人日）

**内容**：claude.ts（架构 5.2 / 11.3）。
**依赖**：T5 框架。
**步骤**：createSession = `claude --session-id <uuid> -n <名> -p <msg>`；inject = `claude -r <uuid> -p <msg>`；输出提取 `--output-format json`；readonly = `--permission-mode plan`（实测验证 plan 下只读行为与 MCP 调用拦截边界）；full = `dontAsk`。
**验收**：建/续会话实测通过；plan 模式实测确认禁写禁执行。

### T12 Codex 适配器（2 人日）

**内容**：codex.ts，六适配器中解析最复杂（架构 5.3 / 11.4）。
**依赖**：T5 框架。
**步骤**：createSession = `codex exec <msg> --json`，从 JSONL 事件流解析新会话 id；inject = `codex exec resume <id> <msg>`；输出提取用 `-o, --output-last-message <file>` 写文件后读回；readonly = `-s read-only -a never`；full = `-s workspace-write -a never`；JSONL 解析写单测（会话 id 缺失时回退注册表重建）。
**验收**：会话 id 解析正确率 100%（20 次实测）；read-only 沙箱实测禁写。

### T13 OpenCode 适配器（1 人日）

**内容**：复用 opencode-kilo.ts，二进制名切换 + 差异点回归（架构 5.3 / 11.5）。
**依赖**：T5 框架。
**步骤**：二进制名参数化验证（`opencode run` / `session list`）；只读档 ⚠️ 实测（无则信封回退）；skill 路径 `.opencode/skills/` 实测确认。
**验收**：与 Kilo 共用适配器全部用例通过。

### T14 Hermes 适配器（SSH 远端注入）（2.5 人日）

**内容**：hermes.ts，经 SSH 注入远端 Linux（架构 4.4 remote 段 / 5.5 / 11.6）。
**依赖**：T5 框架、远端 hermes 服务器可达。
**步骤**：SSH 执行器（ssh_key 认证、非交互）；首条 `hermes -z "<信封>" -c "<来源>"`，后续按名续接；⚠️ 先实测 `-c` 对不存在会话名的行为（报错则回退 `--resume <id>`，id 经 `sessions list` 解析）；输出提取 = `-z` stdout；出站 MCP 注册用独立身份 `<client_id>-hermes`（5.5-B 红线）；⚠️ `hermes mcp add` 语法回填 6.3/6.5 表。
**验收**：远端建会话/续接/代回全链路；`-c` 行为实测结论回填文档。

### T15 Daemon 指标上报（1.5 人日）

**内容**：为 Web 控制台供数（架构 10 二期"数据来源"）。
**依赖**：T4。
**步骤**：指标项定义（在线状态、收/发/注入计数、注入成功率、队列深度、白名单拦截数、hop 熔断数、代回延迟分位数）；上报通道选型落地（推荐：周期性 MQTT publish 到 `/agenthub/ai/metrics/<ns>/<client_id>`，hub 侧聚合；备选 HTTP POST /metrics）；server.py 增加指标内存聚合与查询接口。
**验收**：控制台后端能取到每个 daemon 的实时指标；断线期间指标缺失可识别。

### T16 Web 控制台后端（3 人日）

**内容**：中心节点管理 API（架构 10 二期控制台条目）。
**依赖**：T1、T15。
**步骤**：技术选型（建议 Python FastAPI 与 server.py 同栈，或独立 Node 服务读 hub 数据）；数据模型：ns、身份 `<ns>/<client_id>`、daemon 心跳、指标时序（内存环形缓冲起步，不落库）；REST API：ns 清单/创建、身份检索、在线状态、指标查询、权限配置（allowed_senders/trust_map/inbound_mode）编辑与下发协议（先做"生成配置片段 + 复制下发"，自动推送三期）；鉴权先做简单 token。
**验收**：API 全覆盖控制台前端所需；权限编辑产物可直接粘贴进项目 config.json。

### T17 Web 控制台前端（4 人日）

**内容**：三个页面（架构 10 二期控制台条目）。
**依赖**：T16。
**步骤**：技术选型（轻量 SPA，Vite + React/Vue 任选）；页面一「命名空间」：ns 列表/创建、身份清单与检索、在线状态徽标；页面二「权限」：按项目编辑 allowed_senders/trust_map/inbound_mode，生成配置片段；页面三「指标」：在线 Agent 数、消息吞吐、链路时延、注入成功率/队列积压、环路熔断与白名单拦截告警时间线；轮询刷新（5s）起步。
**验收**：三页面功能完整；断网/无数据有兜底展示。

### T18 二期集成验收（1 人日）

**步骤**：六工具适配器矩阵回归（建会话/注入/只读/代回 × 6）；控制台数据与真实总线一致；uninstall 全工具回归；hermes 远端链路复测。
**验收**：二期验收清单逐项通过，文档回填所有 ⚠️ 实测结论。

---

## 4. 三期：体验、规模与账号体系（~15 人日）

### T19 开机自启（1 人日）

**内容**：daemon 随系统启动（架构 4.5 / 10 三期）。
**依赖**：一期完成。
**步骤**：Windows 注册计划任务（登录时触发，工作目录=项目根）或可选服务注册；Linux systemd user service 模板；`agentbus daemon autostart on|off` 子命令；doctor 检查自启配置。
**验收**：重启机器后 daemon 自动在线；卸载时自启一并清除。

### T20 server.py 扩容改造：共享 MQTT 连接（2.5 人日）

**内容**：线程数 N→1，容量千级→万级（架构 11.8 演进方案 2）。
**依赖**：T1。
**步骤**：hub 改为单条 MQTT 连接，通配订阅 `/agenthub/ai/channel/+/message`（flat）与 `/agenthub/ai/channel/+/+/message`（ns）；按 topic 解析目标身份 → 路由到对应 AgentSession（内存路由表）；publish 统一走共享连接；删除每 Agent 的 paho 客户端与 loop_start 线程；压测：模拟 2000 在线会话下的内存/延迟基线。
**验收**：500 并发会话内存增量 < 原方案 20%；单事件循环吞吐 > 1000 条/秒。

### T21 安全基线：broker 鉴权 + TLS + SSE 鉴权（2.5 人日）

**内容**：支持跨公网部署（架构 2.4-6 / 10 三期）。
**依赖**：一期完成。
**步骤**：mosquitto password_file 生成工具与配置模板；TLS 证书配置（8883）；ACL 文件模板（按 ns topic 前缀授权）；server.py SSE 接入鉴权（token query/header 校验）；daemon/agentbus 支持 TLS 与凭证连接（config 已预留 tls/`${ENV_VAR}` 字段）；doctor 增加 TLS/鉴权检查。
**验收**：匿名连接被拒；跨公网 TLS 链路端到端收发消息；无 token 无法建 SSE。

### T22 账号/团队管理（Web 控制台权限化演进）（3.5 人日）

**内容**：规划留存项（架构 10 三期），命名空间权限化。
**依赖**：T21（broker 鉴权前置）、T16/T17（控制台骨架）。
**步骤**：控制台账号体系（注册/登录/团队 CRUD）；团队 ↔ ns 绑定与命名空间权限（谁能建 ns、成员归属）；落地 3.1.1“一团队一账号”：按团队生成 broker 账号、下发 topic 前缀 ACL（`topic readwrite /agenthub/ai/channel/<ns>/#`）；SSE/MQTT 接入身份与团队归属校验（hub 侧对账）；审计日志（谁改了哪个 ns 的权限）。
**验收**：A 团队账号无法向 B 团队 ns publish（broker ACL 强制）；控制台权限变更 5 分钟内生效。

### T23 进阶通道（2 人日）

**内容**：免冷启动的近实时注入（架构 5.4）。
**依赖**：T5 框架。
**步骤**：OpenCode/Kilo `serve` 无头服务器 + `run --attach <url>` 接入（daemon 管理 serve 生命周期）；Qoder 官方 Agent SDK（resume/sessionId）或 `--input-format stream-json` 长活进程，替换 CLI 解析；对比测试冷启动 vs 进阶通道延迟。
**验收**：注入延迟从秒级冷启动降至亚秒；长活进程崩溃可自动重建。

### T24 一键安装脚本（1 人日）

**内容**：install.ps1 / install.sh（架构 6.6）。
**依赖**：T8。
**步骤**：脚本安装 agentbus CLI（npm 全局）→ `agentbus init --yes` → `agentbus doctor`；错误处理与离线提示；托管到中心节点静态服务。
**验收**：干净 Windows/Linux 机器一条命令完成接入。

### T25 hermes 端到端联调（1.5 人日）

**内容**：注入 + MCP 出站全链路（架构 10 三期）。
**依赖**：T14。
**步骤**：多消息并发注入 hermes（会话竞争验证）；hermes 出站经 `<client_id>-hermes` 身份回发；断线重连（SSH 中断/broker 抖动）；长跑 24h。
**验收**：并发不串话；出站身份独立无互踢；重连自愈。

### T26 OS 级隔离（可选，1 人日）

**内容**：4.7 三层防线的隔离层。
**依赖**：T6。
**步骤**：Linux 低权限账号运行注入进程；Windows 工作目录只读 ACL 模板（可选）；doctor 检查隔离配置。
**验收**：readonly 回合在 OS 层物理禁写（参数层被绕过时仍安全）。

---

## 5. 周排期总表（单人）

| 周 | 任务 | 交付 |
|---|---|---|
| W1 | T1（3）+ T2（1.5） | hub ns 改造完成、协议层定稿 |
| W2 | T3（2）+ T4 前半（3） | CLI 骨架、daemon MQTT/路由主体 |
| W3 | T4 后半（1）+ T5（3） | daemon 收尾、Qoder/Kilo 适配器实测通过 |
| W4 | T6（2.5）+ T7（1.5） | 信封/只读/代回全链路、Skill 契约 |
| W5 | T8（2.5）+ T9 启动（1.5，跨周） | init/doctor/status、联调启动 |
| W6 | T9 收尾 + 缓冲 | **★ 一期里程碑：MVP 验收** |
| W7 | T10（1）+ T11（1.5）+ T12 启动（1.5，跨周） | uninstall、Claude/Codex 适配器 |
| W8 | T12 收尾（0.5）+ T13（1）+ T14（2.5） | 全适配器就位 |
| W9 | T15（1.5）+ T16（3，跨周） | 指标上报、控制台后端 |
| W10 | T16 收尾（0.5）+ T17（3.5，跨周） | 控制台前端主体 |
| W11 | T17 收尾（0.5）+ T18（1）+ 缓冲 | **★ 二期里程碑：六工具 + 控制台** |
| W12 | T21（2.5）+ T19（1） | 安全基线、开机自启 |
| W13 | T20（2.5）+ T24（1） | 扩容改造、一键安装 |
| W14 | T22（3.5，跨周） | 账号/团队管理主体 |
| W15 | T22 收尾 + T23（2，跨周） | 团队权限化上线 |
| W16 | T25（1.5）+ T26（1）+ 缓冲 | **★ 三期里程碑：跨公网交付** |

并行提示：若有第二人，T1/T15/T16/T17/T20/T21/T22（中心节点侧）与 T3–T9/T10–T14（客户端侧）天然分轨，总工期可压至 7–8 周。

---

## 6. 待实测清单（阻塞项前置）

| # | 事项 | 影响任务 | 建议时点 |
|---|---|---|---|
| 1 | Qoder `--permission-mode` 有无只读等价档 | T5/T6 | W3 开工首日 |
| 2 | Kilo/OpenCode 有无只读参数 | T5/T13 | W3 开工首日 |
| 3 | hermes `-c` 对不存在会话名是新建还是报错 | T14 | W7 前 |
| 4 | `hermes mcp add` 语法（SSE URL/scope） | T14 | W7 前 |
| 5 | 各工具项目级 skill 目录确切路径（Codex/OpenCode/Kilo/Qoder） | T7 | W4 前 |
| 6 | Kilo/hermes 对 AGENTS.md 的识别 | T7 兜底 | W4 前 |
| 7 | mcp 1.2.0 ToolAnnotations 兼容性 | T7 | W4 |
| 8 | Claude plan 模式下 MCP 工具调用边界 | T11 | W7 |
| 9 | Codex skills 最低 CLI 版本 | T7 矩阵 | W4 前 |

---

## 7. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 工具 CLI 参数行为随版本变化 | 中 | 适配器失效 | 附录参数基线 + doctor 版本检查 + 适配器集中封装便于一处修复 |
| 只读档在部分工具缺失 | 高 | 只读强制降级为软约束 | 信封 + 三期 OS 隔离补位；文档如实标注回退方案 |
| 长回合阻塞队列（10 分钟超时） | 中 | 消息延迟积压 | 队列语义已定（丢最旧 + 告警）；二期控制台可视化积压 |
| hermes 远端 SSH 不稳定 | 中 | T14 延期 | 回退方案：远端直接部署 daemon（架构 2.4-5 允许） |
| mcp SDK 版本地雷（历史返工 4 次） | 低 | hub 破坏 | 1.2.0 严格锁定（requirements.txt 红线） |
| 单人进度偏差 | 中 | 里程碑顺延 | 每周五对照周排期盘点；缓冲已含在 W6/W11/W16 |

---

## 8. 变更记录

- v1.0（2026-08-09）：初版，覆盖 ARCHITECTURE.md v1.5 全部功能项（T1–T26）
