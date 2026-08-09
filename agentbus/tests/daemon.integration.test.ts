/**
 * TASK-06: Daemon 集成测试（aedes 进程内 MQTT broker，无需 Docker）
 * 覆盖：连接订阅 → 入站路由注入 → ack 回发 → 会话复用 → 去重 → pid 双开防护 → stop 清理
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aedes from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon } from "../src/daemon/daemon.js";
import type { BusMessage } from "../src/protocol.js";

let broker: aedes.Aedes;
let server: Server;
let port: number;
let workDir: string;

function makeConfig(): AgentBusConfig {
  return {
    client_id: "fe-test",
    ns: "default",
    broker: { host: "127.0.0.1", port },
    default_tool: "kilo",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: {},
    tools: { kilo: {} },
    ack: true,
  };
}

/** 轮询等待条件成立（最长 timeout 毫秒） */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  broker = aedes();
  server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  workDir = mkdtempSync(join(tmpdir(), "agentbus-daemon-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  server.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("daemon 端到端", () => {
  const injected: Array<{ tool: string; sessionId: string; msg: BusMessage }> = [];
  let daemon: Daemon;
  let sender: MqttClient;
  const acks: BusMessage[] = [];

  beforeAll(async () => {
    daemon = new Daemon({
      config: makeConfig(),
      workDir,
      inject: (tool, sessionId, msg) => {
        injected.push({ tool, sessionId, msg });
      },
    });
    expect(daemon.start()).toMatchObject({ started: true });

    // 发件人客户端：订阅自己的 flat topic 以接收 ack
    sender = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "be-svc" });
    await new Promise<void>((resolve) => sender.on("connect", () => resolve()));
    await new Promise<void>((resolve) =>
      sender.subscribe("/phnix/ai/channel/be-svc/message", { qos: 1 }, () => resolve()),
    );
    sender.on("message", (_t, payload) => {
      acks.push(JSON.parse(payload.toString("utf-8")) as BusMessage);
    });

    await waitFor(() => daemon.status().connected);
  });

  afterAll(async () => {
    daemon.stop();
    sender.end(true);
  });

  function publishToDaemon(msg: Record<string, unknown>): void {
    broker.publish({
      cmd: "publish",
      topic: "/phnix/ai/channel/default/fe-test/message",
      payload: JSON.stringify({ type: "text", hop: 0, expect_reply: true, ...msg }),
      qos: 1,
      retain: false,
      dup: false,
    }, () => {});
  }

  it("入站消息注入默认工具，ack 回发到发件人 flat topic", async () => {
    publishToDaemon({ id: "msg-e2e-1", from: "be-svc", to: "fe-test", text: "你好" });
    await waitFor(() => injected.length === 1 && acks.length === 1);
    expect(injected[0]!.tool).toBe("kilo");
    expect(injected[0]!.msg.text).toBe("你好");
    expect(acks[0]!.type).toBe("control");
    expect(acks[0]!.reply_to).toBe("msg-e2e-1");
    expect(acks[0]!.expect_reply).toBe(false);
  });

  it("会话写入 sessions.json，同一发件人复用同一 sessionId", async () => {
    const reg = JSON.parse(readFileSync(join(workDir, "sessions.json"), "utf-8"));
    const firstSession = reg.senders["be-svc"].kilo.sessionId;
    expect(firstSession).toBe(injected[0]!.sessionId);

    publishToDaemon({ id: "msg-e2e-2", from: "be-svc", to: "fe-test", text: "再来一条" });
    await waitFor(() => injected.length === 2);
    expect(injected[1]!.sessionId).toBe(firstSession); // 复用会话
  });

  it("重复 msg id 被去重（cleanSession:false 重投递防护）", async () => {
    publishToDaemon({ id: "msg-e2e-1", from: "be-svc", to: "fe-test", text: "重复投递" });
    await new Promise((r) => setTimeout(r, 300));
    expect(injected.length).toBe(2); // 未新增注入
  });

  it("第二次 start 被 pid 锁拒绝（防双开）", () => {
    const second = new Daemon({ config: makeConfig(), workDir });
    const result = second.start();
    expect(result.started).toBe(false);
    expect(result.reason).toContain("已在运行");
  });

  it("stop 释放 pid 锁且状态归位", () => {
    expect(existsSync(join(workDir, "daemon.pid"))).toBe(true);
    daemon.stop();
    expect(existsSync(join(workDir, "daemon.pid"))).toBe(false);
    expect(daemon.status().running).toBe(false);
  });
});
