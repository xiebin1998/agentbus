/**
 * TASK-09: 注入信封（架构 4.6）
 *
 * daemon 注入工具的不是裸 text，而是包装后的信封：
 * - 首行 [AgentBus] 元数据：机器可识别，agent 据此区分总线消息与用户输入
 * - skill 显式加载指令：确定性触发静态契约（5.6）
 * - expect_reply 决定是否需要回复
 */
import type { BusMessage } from "../protocol.js";

export function buildEnvelope(msg: BusMessage, sessionId?: string): string {
  const header =
    `[AgentBus] id=${msg.id} from=${msg.from} hop=${msg.hop} ` +
    `expect_reply=${msg.expect_reply}`;

  const lines: string[] = [header];

  // Plan 3 问题 2：会话路由上下文（续行，与首行键值对齐）
  // session=本次注入的本地会话（发新消息时用作 session_id）；
  // reply_session=发起方会话（手动回复时用作 session_id 回传，使回复落回原会话）
  if (sessionId || msg.session) {
    const parts: string[] = [];
    if (sessionId) parts.push(`session=${sessionId}`);
    if (msg.session) parts.push(`reply_session=${msg.session}`);
    lines.push(`           ${parts.join(" ")}`);
  }

  lines.push(
    "本消息来自 AgentBus 总线，请加载 `agentbus` skill 处理。",
  );

  if (msg.expect_reply) {
    lines.push("收到 expect_reply=true 的消息，处理完成后请调用 send_message 回复：");
    lines.push(`- 携带 reply_to=${msg.id}（原消息 ID）`);
    lines.push(`- 携带 to=${msg.from}（回复发送方）`);
    if (msg.session) {
      lines.push(`- 携带 session_id=${msg.session}（回传发起方会话 ID）`);
    }
  } else {
    lines.push("本条为通知类消息（expect_reply=false），无需回复。");
  }

  return `${lines.join("\n")}\n\n${msg.text}`;
}
