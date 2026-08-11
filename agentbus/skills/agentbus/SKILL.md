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
3. 调用 `send_message(to, text)`；仅向在线目标发送（离线会被整体拒发）；正文不能为空；回复入站消息必须携带 `reply_to` 且 `hop+1`
4. 会话回注（携带 `session_id`）：发起新消息时带上本会话 ID（取入站信封头 `session=` 字段；用户主动发起的会话可跑 `kilo session list` 取当前会话 ID），对方回复将自动落回本会话而非新建；手动回复入站消息时，`session_id` 取信封头 `reply_session=` 字段回传

## 入站（处理信封消息）
消息头 `[AgentBus] id=... from=... mode=... expect_reply=...`（可带续行 `session=... reply_session=...`）：
1. `mode=readonly`：本回合只读——仅读取/检索/作答，禁止修改与执行；将结论作为最终输出（daemon 代回），勿调 send_message 回复
2. `expect_reply=false`：仅处理，不回复
3. `mode=full`：完整权限执行，回复按消息要求

## 红线
- 禁止自发广播、无具体目标的发送
- 不得把凭证、密钥、内网敏感信息写入消息正文
