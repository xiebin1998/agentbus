## AgentBus 总线约定
本项目已接入 AgentBus 总线（身份见 `.agentbus/config.json`）。收发总线消息时请加载 `agentbus` skill 处理；本工具不支持 skill 时按信封头指令执行：入站默认只读，回复携带 reply_to，仅在用户要求协作时发送。自述：可调 `get_status` 查自身档案，用 `update_agent` 补名称/描述。
