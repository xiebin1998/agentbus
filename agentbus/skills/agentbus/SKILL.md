---
name: agentbus
description: AgentBus 总线协作技能。当用户要求向其他 Agent 发消息/跨 Agent 协作/查询在线同伴，或收到 [AgentBus] 信封消息时使用；提供本项目总线身份、收发约定与回复规范。
---

# AgentBus 总线协作

## 身份解析
读 `.agentbus/config.json` 获取本项目 `ns`/`client_id`（完整身份 `<ns>/<client_id>`），MCP 服务器名 `agentbus`。

## 自述闭环（档案维护）
1. 查自身档案：调用 `get_status` 查看自己的名称/描述/能力与在线态
2. 补自身档案：名称为占位（同 client_id）或描述为空时，用 `update_agent(name, description, capabilities)` 补全（直写 hub 档案库，重启不丢）
3. 同伴目录：`.agentbus/agents.json` 为全系统 Agent 快照（daemon 每 30s 刷新）；出站发现同伴优先读该文件，缺失时调 `list_agents`

## 出站（发消息）
1. 触发条件（满足其一才发）：用户明确要求跨 Agent 协作；回复 [AgentBus] 入站消息
2. 发现同伴：优先读 `.agentbus/agents.json`（含在线态），否则调用 MCP 工具 `list_agents`
3. 调用 `send_message(to, text)`：
   - 仅向在线目标发送（离线会被整体拒发）
   - 正文不能为空
   - `wait_reply=True`：阻塞等待回复（同步模式，默认超时 300s）
   - 回复入站消息必须携带 `reply_to`（取信封头 `id` 值）且 `to` 指向发送方
4. 会话回注：回复时携带 `session_id`（取信封头 `reply_session=` 字段）

## 入站（处理信封消息）
消息头 `[AgentBus] id=... from=... expect_reply=...`（可带续行 `session=... reply_session=...`）：
1. 本消息来自 AgentBus 总线，请加载 `agentbus` skill 处理
2. `expect_reply=true`：处理完成后调用 `send_message` 回复：
   - 携带 `reply_to=<信封头 id 值>`
   - 携带 `to=<信封头 from 值>`
   - 若信封头有 `reply_session`，携带 `session_id=<reply_session 值>`
3. `expect_reply=false`：通知类消息，无需回复

## 红线
- 禁止自发广播、无具体目标的发送
- 不得把凭证、密钥、内网敏感信息写入消息正文
