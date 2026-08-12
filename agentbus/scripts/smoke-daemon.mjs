#!/usr/bin/env node
/**
 * TASK-13: 端到端冒烟用 daemon（假注入，不依赖真实 CLI）
 * 用法：node scripts/smoke-daemon.mjs [brokerPort] [client_id]
 * 收到入站即回固定输出，验证 daemon→hub→发件人 的代回链路。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../dist/daemon/daemon.js";

const port = Number(process.argv[2] ?? 18830);
const clientId = process.argv[3] ?? "smoke-demo";

const daemon = new Daemon({
  config: {
    client_id: clientId,
    ns: "default",
    broker: { host: "127.0.0.1", port },
    default_tool: "kilo",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    tools: { kilo: {} },
    ack: true,
  },
  workDir: mkdtempSync(join(tmpdir(), "agentbus-smoke-daemon-")),
  inject: async (ctx) => {
    console.log(`[smoke-daemon] 注入: from=${ctx.msg.from} text=${ctx.msg.text}`);
    return { output: `冒烟回复：已收到「${ctx.msg.text}」` };
  },
});

const result = daemon.start();
if (!result.started) {
  console.error(`[smoke-daemon] 启动失败: ${result.reason}`);
  process.exit(1);
}
console.log(`[smoke-daemon] 已连接身份 default/${clientId}，等待入站消息（Ctrl+C 退出）`);
process.on("SIGINT", () => {
  daemon.stop();
  process.exit(0);
});
