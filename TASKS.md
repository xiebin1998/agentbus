# AgentBus AI 任务卡（TASKS）

> 版本：v1.0 | 日期：2026-08-09 | 依据：PLAN.md v1.0 / ARCHITECTURE.md v1.5
> 用途：供 AI 编码代理逐任务执行。每张卡片自包含、单一职责、可独立验收。

---

## 0. Superpowers 执行协议（每个任务必须遵守）

```
1. using-git-worktrees / 功能分支   每任务一个分支 feat/task-NN，隔离开发
2. test-driven-development          先写失败测试（RED），再最小实现（GREEN），再重构
3. systematic-debugging             测试失败/行为异常时先定位根因，禁止猜测性修补
4. verification-before-completion   完成前必须实际运行验证命令并贴出输出，证据先于结论
5. requesting-code-review           关键任务完成后走 CodeReview 子代理
6. finishing-a-development-branch   阶段任务全部完成后统一合入
```

**通用 DoD（完成定义）**：
- 所有新增/修改逻辑有测试覆盖且通过
- `verification` 命令实际运行通过（不得凭推断声称通过）
- 架构书对应条款无冲突；发现冲突先修文档或停下询问
- 单任务改动聚焦，不顺带改无关代码

---

## 1. 一期任务卡（对应 PLAN T1–T9）

### TASK-01 server.py 纯逻辑可测化重构（T1 前置）【✅ 已完成 2026-08-09：30 单测全绿，分支 feat/task-01】
- **目标**：把路由/寻址/容量逻辑从闭包提取为模块级纯函数，建立 pytest 基座。不改任何运行时行为。
- **涉及**：`server.py`、`tests/test_server_logic.py`（新增）、`requirements-dev.txt`（新增）
- **步骤**：① 建分支 `feat/task-01` ② 提取 `build_sub_topic(client_id, ns=None)` / `resolve_target(t, default_ns)` / `build_pub_topics(to, default_ns)` / `check_text_size(text)` / `can_ack(stored, caller)` 五个纯函数 ③ 写单测覆盖：flat/ns topic、跨 ns、`@tool` 剥离、群发展开、64KB 上限、ack 归属 ④ 原调用点替换为纯函数 ⑤ 运行测试
- **验证**：`python -m pytest tests/ -v` 全绿
- **DoD**：测试全绿；`python -c "import server"` 无副作用错误

### TASK-02 ns 接入与内存治理（T1 主体）【✅ 已完成 2026-08-09：46 单测全绿 + /health 冒烟通过，同分支】
- **目标**：SSE `ns` 参数、会话键改 `<ns>/<client_id>`、`_messages` 上限+TTL、`_agent_info` 断线清理、群发部分送达、`/health` ns 维度、`get_running_loop`。
- **涉及**：`server.py`、`tests/`
- **步骤**：① 建分支 `feat/task-02` ② 为 SSE 解析、会话键、ack 归属、部分送达、TTL 清理先写失败测试 ③ 逐项实现 ④ 兼容回归：不带 ns 的旧行为不变 ⑤ 运行测试 + docker 冒烟
- **验证**：`python -m pytest tests/ -v`；`docker compose up -d` 后 `/health` 正常
- **DoD**：架构 3.1 兼容规则通过；11.8 缺陷 1/2/3/4/5/7 修复有对应测试

### TASK-03 协议类型层（T2，Node）【✅ 已完成 2026-08-09：17 单测全绿 + tsc 类型检查通过，分支 feat/task-03】
- **目标**：`agentbus/` Node 包初始化 + `src/protocol.ts`（BusMessage 类型、normalize/makeAck/makeReply、msg id 生成器）。
- **步骤**：① 建分支 ② `npm init` + tsconfig + vitest ③ 先写协议单测（缺省值/边界）④ 实现 ⑤ 测试
- **验证**：`npm test` 全绿
- **DoD**：非法/缺字段输入不抛异常按缺省处理

### TASK-04 CLI 骨架与配置系统（T3）【✅ 已完成 2026-08-09：33 单测全绿 + CLI 冒烟通过，分支 feat/task-04】
- **目标**：commander 六命令骨架 + config.json 读写校验 + `${ENV_VAR}` 解析。
- **验证**：`node dist/cli.js --version`；config 校验单测全绿；env 缺失报错指明字段
- **DoD**：合法/非法 config 行为正确

### TASK-05 Daemon MQTT 层 + 路由管线（T4 上）
- **目标**：mqtt.js 连接（cleanSession:false/固定 id/重连退避）+ 订阅 + 4.2 步骤 0–8 路由管线（纯逻辑可单测）。
- **验证**：八类异常消息（白名单外/重复/超hop/control/限速溢出…）路由单测全绿
- **DoD**：路由决策全部有日志原因

### TASK-06 注册表 + 队列 + 生命周期（T4 下）
- **目标**：sessions.json 原子写（tmp+rename）、每工具 FIFO 队列、daemon.pid stale 检测、日志轮转、daemon start/stop/status。
- **验证**：kill -9 后文件无损坏单测；stale pid 接管测试；`agentbus daemon start/stop` 实测
- **DoD**：崩溃恢复零数据损坏

### TASK-07 Adapter 框架 + Qoder 适配器（T5 上）
- **目标**：base.ts spawn 执行器（超时 kill/stdout 收集）+ qoder.ts（建会话/注入/json 输出提取/fullArgs/readonlyArgs）。
- **验证**：本机 qodercli 建会话+续接实测；超时 kill 测试
- **DoD**：实测通过并记录输出样例

### TASK-08 Kilo 适配器（T5 下）
- **目标**：opencode-kilo.ts（二进制名参数化），先落 kilo。
- **验证**：本机 kilo 建会话+续接实测；`--format json` 末条事件提取单测
- **DoD**：与 Qoder 同用例矩阵通过

### TASK-09 信封 + 信任分级 + 代回通道（T6）
- **目标**：envelope.ts、trust 判定器（inbound_mode/trust_map）、inject output 捕获 → makeReply → publish、失败 control 通知。
- **验证**：入站→只读回合→代回全链路实测；readonly 回合禁写实测；expect_reply=false 不回传测试
- **DoD**：代回消息三字段（reply_to/hop+1/expect_reply=false）正确

### TASK-10 Skill 契约 + AGENTS.md 兜底（T7 上）
- **目标**：SKILL.md 模板 + skill 安装器 + AGENTS.md 托管块工具库（插入/更新/删除幂等）。
- **验证**：托管块对已有 AGENTS.md 无损测试；Qoder/Kilo 会话识别 skill 人工验证
- **DoD**：uninstall 可整块移除

### TASK-11 server.py 描述强化 + readOnlyHint（T7 下）
- **目标**：工具 description 写使用边界；查询/回复类工具 ToolAnnotations(readOnlyHint=true)（先验证 mcp 1.2.0 兼容性）。
- **验证**：`mcp list` 可见；只读模式客户端免确认调用实测
- **DoD**：mcp 1.2.0 下无异常

### TASK-12 init/doctor/status + MCP 注册器（T8）
- **目标**：inquirer 交互流 + CLI 探测 + MCP 注册器（6.5-D 七红线）+ doctor/status + `init --yes`。
- **验证**：干净项目一条 init 全绿；doctor 故障注入测试（断 broker/缺 CLI）
- **DoD**：七红线逐条有对应实现注释与测试

### TASK-13 一期集成验收（T9）
- **目标**：执行架构第 10 章一期全部验收项 + 24h 长跑 + 验收报告 + README 快速上手。
- **验证**：验收清单逐项勾选（端到端/安全/只读/跨机）
- **DoD**：★ 一期里程碑达成，finishing-a-development-branch 合入

## 2. 二期任务卡（T10–T18）

| 卡号 | 任务 | 对应 | 关键验证 |
|---|---|---|---|
| TASK-14 | uninstall 全链路 | T10 | 卸载后 doctor 零残留 |
| TASK-15 | Claude 适配器（含 plan 只读实测） | T11 | plan 禁写实测 |
| TASK-16 | Codex 适配器（JSONL 解析会话 id） | T12 | 20 次解析正确率 100% |
| TASK-17 | OpenCode 适配器 | T13 | 与 Kilo 共用用例全过 |
| TASK-18 | Hermes SSH 适配器 | T14 | 远端建/续/代回全链路 |
| TASK-19 | Daemon 指标上报 | T15 | hub 可查各 daemon 指标 |
| TASK-20 | Web 控制台后端 API | T16 | API 覆盖前端所需 |
| TASK-21 | Web 控制台前端三页 | T17 | ns/权限/指标页可用 |
| TASK-22 | 二期集成验收 | T18 | 六工具矩阵回归 |

## 3. 三期任务卡（T19–T26）

| 卡号 | 任务 | 对应 | 关键验证 |
|---|---|---|---|
| TASK-23 | 开机自启 | T19 | 重启后自动在线 |
| TASK-24 | 共享 MQTT 连接扩容 | T20 | 500 会话压测内存增量<20% |
| TASK-25 | 安全基线（鉴权/TLS/SSE） | T21 | 匿名被拒、TLS 端到端 |
| TASK-26 | 账号/团队管理 | T22 | 跨团队 publish 被 ACL 拒 |
| TASK-27 | 进阶通道（serve/SDK） | T23 | 注入亚秒级 |
| TASK-28 | 一键安装脚本 | T24 | 干净机器一条命令接入 |
| TASK-29 | hermes 端到端联调 | T25 | 并发不串话、重连自愈 |
| TASK-30 | OS 级隔离（可选） | T26 | OS 层物理禁写 |

## 4. 执行顺序与依赖

```
TASK-01 → TASK-02 ─┐
TASK-03 → TASK-04 ─┼→ TASK-05 → TASK-06 ─┬→ TASK-07 → TASK-08 ─┐
TASK-10/11 可并行   │                      └→ TASK-09 ───────────┼→ TASK-12 → TASK-13 ★一期
                                                              │
二期：TASK-14~18（适配器可并行）→ TASK-19 → TASK-20 → TASK-21 → TASK-22
三期：TASK-25 → TASK-26；TASK-23/24/27/28/29/30 独立
```

## 5. 变更记录

- v1.0（2026-08-09）：初版，PLAN T1–T26 拆为 TASK-01~30，附 Superpowers 执行协议
