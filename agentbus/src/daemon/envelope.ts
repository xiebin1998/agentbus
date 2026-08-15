/**
 * TASK-09: 注入信封（架构 4.6）
 *
 * daemon 注入工具的不是裸 text，而是包装后的信封：
 * - 首行 [AgentBus] 元数据：机器可识别，agent 据此区分总线消息与用户输入
 * - skill 显式加载指令：确定性触发静态契约（5.6）
 * - expect_reply 决定是否需要回复
 *
 * 通道方案：daemon 维护与每个对应方的通道，通道绑定双方 session ID
 * - 接收方 daemon 创建通道 + 本地 session，通过信封告知 AI 工具
 * - 代回时把本地 session ID 放进消息的 session 字段
 * - 发送方 daemon 收到回复后，提取 session 字段存储到通道
 */
import type { BusMessage } from "../protocol.js";

export interface EnvelopeContext {
  /** 本次注入的本地会话 ID */
  sessionId: string;
  /** 通道 ID（可选，供调试） */
  channelId?: string;
  /** 对应方的会话 ID（如果已知，供发送方参考） */
  remoteSessionId?: string;
}

export function buildEnvelope(msg: BusMessage, ctx: EnvelopeContext): string {
  const header =
    `[AgentBus] id=${msg.id} from=${msg.from} hop=${msg.hop} ` +
    `expect_reply=${msg.expect_reply}`;

  const lines: string[] = [header];

  // 通道上下文
  lines.push(`           session=${ctx.sessionId}`);
  if (ctx.channelId) {
    lines.push(`           channel=${ctx.channelId}`);
  }
  if (ctx.remoteSessionId) {
    lines.push(`           peer_session=${ctx.remoteSessionId}`);
  }

  lines.push(
    "本消息来自 AgentBus 总线。请直接输出你的回复内容（文本即可），",
    "系统会自动将你的回复发送给对方。无需调用任何工具或 send_message。",
  );

  if (!msg.expect_reply) {
    lines.push("本条为通知类消息（expect_reply=false），无需回复。");
  }

  return `${lines.join("\n")}\n\n${msg.text}`;
}
