# Plan 3：控制台与对话体验修复五件套（2026-08-11）

## 背景
用户实测暴露 5 个问题（编号沿用会话约定）：

| # | 问题 | 根因 |
|---|---|---|
| 0 | 空正文消息照发 | hub `send_message` 只校验上限不校验空串 |
| 1 | kilo 会话标题是 Agent ID | daemon 直接拿 client_id 当 `--title` |
| 2 | 回复落进新会话 | 协议无会话维度，daemon 路由只按发件人身份 |
| 3 | 控制台"最近上报"显示 UTC | 前端 `formatTime` 字符串截取不转时区 |
| 4 | 测试数据无法移除 | Agent/Daemon 明细无删除能力 |

## 设计定案（已与用户确认）
- **问题 2 协议**：BusMessage 增 `session: string | null`（发送方本地会话 ID）；回复（代回 makeReply）协议层自动回显；发起方 daemon 收到 `reply_to` 非空且带 `session` 的消息 → 直接 `-s <session>` 注回该会话（不查注册表，kilo 按 ID 续接）；注入失败回退现状"按发件人建/续会话"。信封头携带 `session=<本会话ID>` 与 `reply_session=<对方会话ID>`（有才显示）；SKILL 约定出站传 `session_id`；hub `send_message` 增可选 `session_id` 参数透传。
- **问题 4 收窄**：只做 Agent 明细删除，连带清内存指标条目与 `_agent_info`；Daemon 明细保持只读。UI 顺序调整为 Agent 明细在前、Daemon 明细在后。删除按钮 + 确认弹窗（ui-ux-pro-max：破坏性操作需确认、danger 语义色、busy 态、弹窗可取消）。提示"在线身份下次上报将自动重建占位行，建议先停 daemon"。
- **问题 3**：`formatTime` 解析 ISO 转浏览器本地时区（`toLocaleString("sv-SE")`），解析失败回退原截取逻辑。

## 任务排期（TDD，逐任务 RED→GREEN→回归）
- **T1 问题 3**（前端最小）：`web/src/lib/utils.ts` formatTime；验证 tsc + vite build。
- **T2 问题 0**：`server.py` send_message 空/纯空白正文拒发（error JSON）；pytest `tests/test_server_mcp_gate.py`（或 logic）新增用例。
- **T3 问题 4**：`DELETE /api/console/agents/{cid}`（session_guard + `_can_manage_ns`，复用 `hub_store.delete_agent` + `MetricsStore.remove` 新增 + `_agent_info` 清理；DB 未初始化/无行 404）；前端删除按钮 + 确认弹窗 + 卡片顺序对调；pytest + tsc。
- **T4 问题 1**：`snapshot.ts` 增 `agentNameFromSnapshot(workDir, clientId)`（防御解析）；`daemon.ts` injectAndDrain 的 senderName 改为 名称→client_id 回退；vitest。
- **T5 问题 2**：protocol（session 字段/normalize/makeReply 回显）→ envelope（session/reply_session 行）→ daemon（回复按 session 注回 + 失败回退）→ hub（send_message session_id 透传）→ SKILL.md 出站约定；vitest + pytest。
- **T6 全量回归**：vitest 全绿 + pytest 全绿 + tsc（agentbus + web）零错误。
- **T7 发布**：npm version patch（0.2.3，git-tag-version=false）→ 版本提交（风格 `chore(client): v0.2.3 版本号同步（package.json/package-lock）`）→ web build（dist 随 hub 镜像）→ docker compose up -d --build → publish.ps1 等价流程发布 npm（沙箱外）→ git push + tag v0.2.3（代理 127.0.0.1:7897 临时环境变量）→ 更新记忆。

## 红线
- 兼容性：旧客户端不带 session → normalize 补 null → 行为不变；新发旧收 → 多余字段被忽略。
- `session` 仅用于回复路由（reply_to 非空），不得用于首条入站消息的会话选择。
- 删除 API 权限与 PATCH 同口径（`_can_manage_ns`）。
- 不改 broker/hub MQTT 投递路径。

## 验收
- 控制台"最近上报"显示北京时间；Agent 明细可删除且 Daemon 指标同清；列表 Agent 在前。
- e2e 双项目实测：提问方原会话收到回复（发版后用户明天自测）。
