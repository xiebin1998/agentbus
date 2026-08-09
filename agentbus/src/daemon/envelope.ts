/**
 * TASK-09: 注入信封（架构 4.6）
 *
 * daemon 注入工具的不是裸 text，而是包装后的信封：
 * - 首行 [AgentBus] 元数据：机器可识别，agent 据此区分总线消息与用户输入
 * - skill 显式加载指令：确定性触发静态契约（5.6）
 * - mode 指令行与 daemon 实际传递的 CLI 权限参数一致（4.7，提示层不越权）
 * - expect_reply 决定是否要求最终输出代回
 */
import type { InboundMode } from "../config.js";
import type { BusMessage } from "../protocol.js";

export function buildEnvelope(msg: BusMessage, mode: InboundMode): string {
  const header =
    `[AgentBus] id=${msg.id} from=${msg.from} hop=${msg.hop} ` +
    `expect_reply=${msg.expect_reply} mode=${mode}`;

  const lines: string[] = [
    header,
    "本消息来自 AgentBus 总线，请加载 `agentbus` skill 处理（本工具不支持 skill 时按以下指令与项目 AGENTS.md 约定）。",
  ];

  if (mode === "readonly") {
    lines.push("本回合为只读请求：仅允许读取文件/检索/作答，禁止修改任何文件、禁止执行命令。");
  }

  if (msg.expect_reply) {
    lines.push("处理完成后将结论作为最终输出直接给出（daemon 会代你回传），无需调用 send_message 回复。");
  } else {
    lines.push("本条为通知类消息，无需回复。");
  }

  return `${lines.join("\n")}\n\n${msg.text}`;
}
