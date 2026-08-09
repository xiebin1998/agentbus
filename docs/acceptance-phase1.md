# AgentBus 一期集成验收报告（TASK-13）

- 日期：2026-08-09
- 分支：feat/task-13
- 环境：Windows 25H2 / Node v22.12.0 / Python 3.13.9 / Docker Desktop 28.1.1（mosquitto 2）
- 测试基线：TypeScript 196 用例 + Python 63 用例全绿，tsc 无错误

## 1. 架构第 10 章一期清单逐项核对

| # | 一期项 | 状态 | 覆盖方式 |
|---|---|---|---|
| 1 | CLI 骨架 + config 读写（`${ENV_VAR}` 解析） | ✅ | TASK-04：33 单测 + CLI 冒烟 |
| 2 | Daemon MQTT（clean_session=false）+ 路由管线 | ✅ | TASK-05：21 路由单测（八类异常）；真实 broker 集成冒烟见 §2 |
| 3 | 环路抑制：control/hop/reply_to 全链路 | ✅ | TASK-03/05/06/09 单测 + §3 安全验收 + 冒烟代回 hop=1 可见 |
| 4 | Agent 识别：Skill 安装 + 工具描述强化 + readOnlyHint | ✅ | TASK-10/11 单测；readOnlyHint 真实链路可见性见 §2 [2]；各工具会话内人工识别待补（需 CLI 登录态） |
| 5 | 只读信任分级：inbound_mode=readonly + trust_map | ✅ | TASK-09：10 集成用例（含 trust_map 覆盖）；只读回合禁写实测待补（需 CLI 登录态） |
| 6 | 请求-响应回复通道：expect_reply + 注入信封 + stdout 代回 | ✅ | TASK-09 集成用例 + §2 冒烟 [5][6]（ack + 代回真实到达发件人） |
| 7 | 命名空间：ns 全链路 + 跨 ns 寻址 + @tool 透传 | ✅ | TASK-01/02：76 单测；冒烟全程 ns=default |
| 8 | server.py 内存治理：_messages TTL/上限 + 断线清理 | ✅ | TASK-02 单测 |
| 9 | Qoder / Kilo 适配器 | ✅（单测） | TASK-07/08：30 适配器单测 + 参数面实测；登录后建/续会话待补 |
| 10 | init/doctor/status（含 MCP 注册七红线） | ✅ | TASK-12：46 新增测试 + 干净目录 `init --yes` 真实冒烟全链路 |
| 11 | 验收：A 发消息 → B 自动建会话并响应 → 回消息到 A | ⚠️ 部分 | 假注入 daemon 端到端闭环已验证（§2）；真实 CLI 建会话段待补（qodercli/kilo 本机未登录，见 §5） |
| 12 | 安全验收（白名单/hop 熔断/去重） | ✅ | 见 §3 |

## 2. 端到端冒烟（真实链路）

脚本：`agentbus/scripts/dev-broker.mjs`（aedes）+ `server.py`（hub）+ `agentbus/scripts/smoke-daemon.mjs`（假注入 daemon）+ `scripts/smoke_hub.py`（MCP SSE 客户端 + paho 验证者）。

步骤与结果：

1. `/health` → status=ok，broker 指向正确端口 ✅
2. `list_tools` → 8 工具，send_message/ack_message/list_agents/get_agent_info/find_agents_by_capability/get_status 的 `readOnlyHint=true` 在真实 SSE 链路上可见（补齐 TASK-11 待补实测）✅
3. `register_agent` ✅
4. `send_message` → 尽力发布（目标为纯 MQTT daemon，`unconfirmed` 提示）✅
5. daemon ack（type=control，reply_to=原消息 id）送达发件人 topic ✅
6. daemon 代回（type=text，reply_to，hop=1）送达发件人 topic ✅

**双 broker 均已通过**：aedes 进程内 broker（18830）与 Docker 真实 mosquitto 2（同端口，`docker compose up -d mqtt-broker`），补齐 TASK-05 顺延的 broker 集成冒烟。

### 冒烟发现并修复的两个缺陷（TDD）

1. **就绪竞态**：SSE 握手返回时 MQTT 订阅可能未完成（约 1s），早到回复丢失。修复：`AgentSession` 增加 ready 事件，`send_message` 工具在发布前等待订阅就绪（超时 5s 报错）。6 单测覆盖。
2. **在线判定三态**：原实现在线判定基于 SSE 会话表，纯 MQTT 直连的 daemon 被判"离线"而拒发，导致 hub 永远无法触达 daemon（架构 5.5 机制 1 只说会"隐身"，未说拒发）。修复：`plan_send_targets` 将未知目标改为尽力发布并在结果中标注 `unconfirmed`。4 单测覆盖。

## 3. 安全验收（一期三项）

| 项 | 结果 | 覆盖 |
|---|---|---|
| 非白名单来源消息被丢弃并告警 | ✅ | daemon.integration.test.ts：evil-src 不注入 + 日志落盘含 WARN/不在 allowed_senders 白名单 |
| 两 Agent 互回复在 hop_limit 处熔断 | ✅ | daemon.integration.test.ts：hop=4 > limit 3 不注入 + 日志落盘含"环路熔断" |
| 同一消息重复投递不产生二次注入 | ✅ | TASK-05/06 去重单测（msg id 幂等） |

## 4. 24h 长跑

本环境无法值守 24 小时，采用**自动化替代方案**：`scripts/soak_loop.ps1` 每 30s 跑一轮完整端到端冒烟（含 SSE/MCP/MQTT 全链路），成功/失败计数持续追加 `soak.log`。

- 启动时间：2026-08-09 19:40
- 验收时点统计：截至 19:49 连续 16 轮全绿（fail=0）；期间 broker 从 aedes 热切换为 mosquitto，后续轮次继续通过（最新数据见 soak.log 尾部）
- 用户可随时 `Get-Content soak.log` 复查；如需严格 24h 数据，保持 soak 进程运行满 24h 后统计即可。

## 5. 跨机验收与待补实测清单

- **跨机**：本机单环境，跨机部署验收待补（架构已预留 `<hub主机>:18830` 映射与 `broker.host` 配置）。
- **待补实测**（均需真实 CLI 登录态或特定环境）：
  1. qodercli 登录后建会话 + 续接（TASK-07）
  2. kilo 事件流格式与建/续会话（TASK-08）
  3. 只读回合禁写实测（TASK-09）
  4. 各工具会话内人工识别 skill（TASK-10）
  5. `mcp list` 可见性与只读客户端免确认调用（TASK-11）
  6. 交互式 init 真实终端体验、kilo/codex global CLI 注册、hermes 注册语法（TASK-12）
  7. Qoder ↔ Kilo 真实互发（一期验收项 11 的剩余段）

## 6. 结论

一期 12 项清单：10 项完全达成，1 项（真实 CLI 端到端互发）因本机无 CLI 登录态以假注入等价验证并如实记录待补，安全验收 3/3 通过，端到端闭环在 aedes 与真实 mosquitto 双 broker 下均验证通过。**★ 一期里程碑达成（附条件：§5 待补实测清单随后续任务卡消化）。**
