# AgentBus 二期集成验收报告（TASK-22）

- 日期：2026-08-09
- 分支：feat/task-22
- 环境：Windows 25H2 / Node v22.12.0 / Python 3.13.9 / Docker mosquitto 2（18830）
- 测试基线：TypeScript 289 用例 + Python 88 用例全绿，tsc 无错误

## 1. 架构第 10 章二期清单逐项核对

| # | 二期项 | 状态 | 覆盖方式 |
|---|---|---|---|
| 1 | Claude Code 适配器 | ✅（单测+参数实测） | TASK-15：适配器/接线单测全绿；`claude 2.1.220 --help` 参数实测；plan 禁写真实回合待补（代理不可达） |
| 2 | Codex 适配器 | ✅（单测+真机解析） | TASK-16：20 样本单测 100%；真机解析真实 thread_id×2 + 进程树杀净；20 回合实跑待补（后端代理不可达） |
| 3 | OpenCode 适配器 | ✅（单测+spawn 链路） | TASK-17：与 Kilo 共用用例 describe.each 双二进制 24 例全过；真机 spawn 链路（超时杀树/错误透传）验证；真实回合待补 |
| 4 | Hermes 适配器 | ✅（单测+ssh 链路） | TASK-18：12 例含 shell 转义防注入；真机 ssh.exe 链路（BatchMode/ConnectTimeout，不可达主机 10.2s 快速失败退出码 255 透传）；远端真实回合待补（无 hermes 服务器） |
| 5 | `agentbus uninstall` | ✅ | TASK-14：216 TS 全绿 + 真实冒烟 init→uninstall→零残留；本次验收再次复验（见 §3 第 5 步） |
| 6 | 控制台-命名空间管理 | ✅ | TASK-20/21：ns 清单（四路来源合并）/声明创建/`<ns>/<client_id>` 身份清单与检索（ns 过滤+子串）；浏览器实测通过 |
| 7 | 控制台-权限管理 | ✅ | TASK-20/21：allowed_senders/trust_map/inbound_mode 可视化编辑与下发（control 通知 daemon 日志确认收到）；broker ACL 配置衔接三期安全基线（规划留存） |
| 8 | 控制台-通信指标统计 | ✅（核心项） | TASK-19/20/21：daemon 指标上报（注入成败/丢弃/去重/排队/会话数/运行时长）+ hub /health 汇总 + 前端汇总卡片/各 daemon 表/5s 自动刷新；端到端时延与告警记录为后续演进（如实记录） |
| 9 | 数据来源：/health 扩展 + daemon 指标上报 | ✅ | TASK-19：metric MQTT 通道（/agenthub/ai/metric/#）+ /health daemon_metrics；本次验收实测 default/accept 周期上报 report_count 递增 |

## 2. 六工具矩阵回归

### 2.1 单测矩阵（289 TS 全绿）

| 工具 | 适配器用例 | daemon 接线 | 备注 |
|---|---|---|---|
| qodercli | TASK-07 | ✓ | 一期已真机回合 |
| kilo | TASK-08（与 opencode 共用 24 例） | ✓ | 事件流真实格式待补 |
| claude | TASK-15 | ✓ | plan 禁写待补 |
| codex | TASK-16（20 样本） | ✓ | 20 回合实跑待补 |
| opencode | TASK-17（与 kilo 共用 24 例） | ✓ | 真实回合待补 |
| hermes | TASK-18（12 例+转义防注入） | ✓ | 远端回合待补 |

### 2.2 真机 CLI 全链路（干净目录 `.tmp-probe/accept`）

1. `init --yes --tools qoder kilo claude codex opencode hermes`：**exit 0**
   - 探测：qodercli 1.1.9 / kilo 7.4.17 / claude 2.1.220 / codex 0.146.0 / opencode 1.18.8 ✓；hermes 本机无二进制报 ✗（预期：远端工具需配 remote 段）
   - skill 五装 + AGENTS.md 兜底块 + MCP 四注册（qoder/kilo/claude 项目级回写验证通过；codex 回退全局并警告；hermes 注册语法待实测按红线跳过）
2. `doctor`：配置/Broker/SSE/MCP 注册/daemon 五项 ✓；CLI 项仅 hermes ✗（同上，预期行为；配 remote 段后跳过本机探测有单测覆盖）
3. `status`：daemon 运行中 + 身份/订阅摘要 ✓
4. daemon 指标：init 拉起的 daemon 接入 metric 通道，hub /health `daemon_metrics["default/accept"]` report_count 递增至 20 ✓
5. `uninstall --yes`：daemon 停止 + 五工具注册/skill/托管块/.agentbus 全清，**零残留** ✓

## 3. 回归发现并修复的三个缺陷（均 TDD）

1. **.cmd 参数被 cmd.exe 分割（严重）**：sse_url 含 `&`（`?client_id=x&ns=default`），经 `cmd.exe /d /s /c` 执行 npm .cmd shim 时 `&` 被当命令分隔符，导致 `codex mcp add` 恒失败（init 步骤 4 中断）。修复：`base.ts` 增加 `escapeCmdArg`（含 cmd 元字符的参数整体加引号 + 内部引号/尾部反斜杠按 Windows argv 规则转义），cmd 路径配合 `windowsVerbatimArguments` 防 libuv 二次加引号。真机复验 init 六工具全绿。新增 1 真机用例（echo %* 回显含 & 参数原样）。
2. **doctor 默认探测 localhost→::1 脑裂**：Windows 上 localhost 优先解析 ::1，hub 仅监听 IPv4 时 SSE 检查误报不可达（同 TASK-20 hub 连 broker 问题同源）。修复：`defaultCheckTcp/defaultCheckHttp` 对 localhost 失败后回退 127.0.0.1 重试。新增 1 用例（服务仅绑 127.0.0.1 时 localhost 探测仍判可达）。
3. **cli 型 MCP 注册非幂等（防御性）**：重复 init 时 `codex mcp add` 对已注册同名项可能失败。修复：cli 型注册 remove-then-add（remove 失败忽略）。新增 1 用例。备注：实测 codex 0.146.0 重复 add 可直接覆盖，缺陷 1 才是 init 失败真因，本项为跨版本防御。

另记录非缺陷观察：kilo `--version` 偶发挂起（kilo-code 自身行为，真机多次复现后自愈），runCommand 10s 超时已将其收敛为可诊断的探测失败，不影响其余矩阵。

## 4. 待补实测清单（累计，均需特定环境/登录态）

承接一期验收报告 §5 第 1–11 项（qodercli/kilo 登录态回合、只读禁写、skill 人工识别、mcp list 可见性、交互式 init、Qoder↔Kilo 互发、claude plan、codex 20 回合+full 免确认、opencode 事件流、hermes 远端回合），二期新增：

12. hermes 配置 remote 段后的端到端（三期 TASK-29 专卡联调）
13. 控制台端到端时延与白名单/环路告警记录展示（指标页后续演进）
14. broker ACL 与控制台下发的生产化衔接（三期安全基线）
15. 跨机部署（同一期，架构已预留配置位）

## 5. 结论

二期清单 9 项：8 项完全达成，1 项（指标统计）核心项达成、时延/告警展示列后续演进并如实记录。六工具矩阵单测 289 例全绿，真机 init→doctor→status→uninstall 全链路通过（含 daemon 指标上报闭环），回归发现并 TDD 修复三缺陷（其中 .cmd 参数分割为真实阻断级）。**★ 二期里程碑达成（附条件：§4 待补实测清单随后续任务卡消化）。**
