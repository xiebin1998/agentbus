/**
 * TASK-5: Daemon 处理 hello_ack 消息测试
 *
 * 验证：收到 hello_ack 后通道状态从 SYN_SENT → ESTABLISHED，
 *       remoteSessionId 被更新，pendingHandshake 被 resolve 并清除。
 *       无匹配 pendingHandshake 时不崩溃，仅记日志。
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import aedes from "aedes";
import mqtt from "mqtt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon } from "../src/daemon/daemon.js";

let broker: aedes.Aedes;
let server: Server;
let port: number;

function makeConfig(overrides: Partial<AgentBusConfig> = {}): AgentBusConfig {
  return {
    client_id: "test-daemon",
    ns: "ns",
    broker: { host: "127.0.0.1", port },
    default_tool: "kilo",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    tools: { kilo: {} },
    ack: true,
    ...overrides,
  };
}

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
});

afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  server.close();
});

describe("handshake: hello_ack handling", () => {
  it("updates channel state to ESTABLISHED on hello_ack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-handshake-"));
    const daemon = new Daemon({
      config: makeConfig(),
      workDir: dir,
      inject: async () => ({ output: "ok" }),
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    // 通过内部接口设置测试场景（handleMessage 为 private，channels 为 private）
    const daemonAny = daemon as any;

    // 1. 为 "ns/alice" 预创建通道（模拟发送 hello 时已建通道），状态 SYN_SENT
    daemonAny.channels.getOrCreate("ns/alice", "placeholder");

    // 2. 注册 pendingHandshake（模拟 Task 6 发送 hello 后的状态）
    const resolveSpy = vi.fn();
    const fakeTimer = setTimeout(() => {}, 0);
    daemonAny.channels.trackPendingHandshake("ns/alice", resolveSpy, fakeTimer);
    clearTimeout(fakeTimer);

    // 3. 通过 MQTT 发送 hello_ack 到 daemon
    const helloAck = {
      id: "ha-001",
      from: "ns/alice",
      to: "ns/test-daemon",
      text: "",
      type: "hello_ack",
      session: "remote-session-uuid",
      hop: 1,
      reply_to: null,
      expect_reply: false,
      timestamp: new Date().toISOString(),
    };
    broker.publish({
      cmd: "publish",
      topic: "/agentbus/ai/channel/ns/test-daemon/message",
      payload: JSON.stringify(helloAck),
      qos: 1,
      retain: false,
      dup: false,
    }, () => {});

    // 4. 等待处理完成
    await new Promise((r) => setTimeout(r, 500));

    // 5. 验证通道状态
    const channel = daemonAny.channels.get("ns/alice");
    expect(channel).not.toBeNull();
    expect(channel.state).toBe("ESTABLISHED");
    expect(channel.remoteSessionId).toBe("remote-session-uuid");

    // 6. 验证 pendingHandshake 已被消费
    const pending = daemonAny.channels.consumePendingHandshake("ns/alice");
    expect(pending).toBeNull();

    // 7. 验证 resolve 被调用
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    // 8. 验证日志包含握手完成信息
    const log = readFileSync(join(dir, "logs", "daemon.log"), "utf-8");
    expect(log).toContain("握手完成");
    expect(log).toContain("ns/alice");
    expect(log).toContain("remote-session-uuid");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles hello_ack with no matching pending handshake gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-handshake-nopending-"));
    const daemon = new Daemon({
      config: makeConfig(),
      workDir: dir,
      inject: async () => ({ output: "ok" }),
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    // 发送 hello_ack，但不预先注册 pendingHandshake
    const helloAck = {
      id: "ha-002",
      from: "ns/unknown-remote",
      to: "ns/test-daemon",
      text: "",
      type: "hello_ack",
      session: "some-session",
      hop: 1,
      reply_to: null,
      expect_reply: false,
      timestamp: new Date().toISOString(),
    };
    broker.publish({
      cmd: "publish",
      topic: "/agentbus/ai/channel/ns/test-daemon/message",
      payload: JSON.stringify(helloAck),
      qos: 1,
      retain: false,
      dup: false,
    }, () => {});

    // 等待处理
    await new Promise((r) => setTimeout(r, 500));

    // daemon 不应崩溃，日志应记录无匹配信息
    const log = readFileSync(join(dir, "logs", "daemon.log"), "utf-8");
    expect(log).toContain("hello_ack 无匹配 pendingHandshake");
    expect(log).toContain("ns/unknown-remote");

    // daemon 仍正常运行
    expect(daemon.status().running).toBe(true);

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("send_message outbound path", () => {
  let probeClient: mqtt.MqttClient;

  beforeEach(async () => {
    probeClient = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: `probe-${randomUUID()}` });
    await new Promise<void>((resolve, reject) => {
      probeClient.on("connect", () => resolve());
      probeClient.on("error", reject);
    });
  });

  it("sendHello creates correct hello message via SYN_SENT channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-sendmsg-hello-"));
    const daemon = new Daemon({
      config: makeConfig(),
      workDir: dir,
      inject: async () => ({ output: "ok" }),
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    const daemonAny = daemon as any;

    // 订阅 bob 的入站 topic 以捕获 hello
    const bobTopic = "/agentbus/ai/channel/ns/bob/message";
    const helloPromise = new Promise<any>((resolve) => {
      probeClient.subscribe(bobTopic, () => {});
      probeClient.on("message", (_topic: string, payload: Buffer) => {
        const msg = JSON.parse(payload.toString());
        if (msg.type === "hello") resolve(msg);
      });
    });

    // 预创建 SYN_SENT 通道并调用 sendHello
    const [channel] = daemonAny.channels.getOrCreate("ns/bob", "placeholder");
    const result = await daemonAny.sendHello(channel);
    expect(result).toBe(true);

    const hello = await helloPromise;
    expect(hello.type).toBe("hello");
    expect(hello.from).toBe("ns/test-daemon");
    expect(hello.to).toBe("ns/bob");
    expect(hello.text).toBe("");
    expect(hello.session).toBe(channel.localSessionId);
    expect(hello.expect_reply).toBe(false);
    expect(hello.hop).toBe(0);

    // 日志应记录握手消息已发送
    const log = readFileSync(join(dir, "logs", "daemon.log"), "utf-8");
    expect(log).toContain("握手消息已发送");
    expect(log).toContain("ns/bob");

    probeClient.end();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sendMessage with ESTABLISHED channel sends text directly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-sendmsg-est-"));
    const daemon = new Daemon({
      config: makeConfig(),
      workDir: dir,
      inject: async () => ({ output: "ok" }),
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    const daemonAny = daemon as any;

    // 预建 ESTABLISHED 通道
    const [channel] = daemonAny.channels.getOrCreate("ns/bob", "placeholder");
    daemonAny.channels.setState("ns/bob", "ESTABLISHED");
    daemonAny.channels.updateRemoteSession("ns/bob", "remote-session-123");

    // 订阅 bob 的入站 topic
    const bobTopic = "/agentbus/ai/channel/ns/bob/message";
    const msgPromise = new Promise<any>((resolve) => {
      probeClient.subscribe(bobTopic, () => {});
      probeClient.on("message", (_topic: string, payload: Buffer) => {
        const msg = JSON.parse(payload.toString());
        if (msg.type === "text") resolve(msg);
      });
    });

    const result = await daemonAny.sendMessage("bob", "Hello Bob!", false);
    expect(result.status).toBe("sent");

    const sentMsg = await msgPromise;
    expect(sentMsg.type).toBe("text");
    expect(sentMsg.from).toBe("ns/test-daemon");
    expect(sentMsg.to).toBe("ns/bob");
    expect(sentMsg.text).toBe("Hello Bob!");
    expect(sentMsg.session).toBe("remote-session-123");
    expect(sentMsg.expect_reply).toBe(false);

    probeClient.end();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sendMessage with SYN_SENT channel sends hello first then text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-sendmsg-syn-"));
    const daemon = new Daemon({
      config: makeConfig(),
      workDir: dir,
      inject: async () => ({ output: "ok" }),
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    const daemonAny = daemon as any;
    const bobTopic = "/agentbus/ai/channel/ns/bob/message";

    // 用 probe 订阅 bob 的 topic，拦截 hello 并回复 hello_ack
    const messages: any[] = [];
    // 等待订阅确认（SUBACK），确保 hello 不会在订阅生效前到达
    await new Promise<void>((resolve) => {
      probeClient.subscribe(bobTopic, { qos: 2 }, () => resolve());
    });
    probeClient.on("message", (_topic: string, payload: Buffer) => {
      const msg = JSON.parse(payload.toString());
      messages.push(msg);
      // 收到 hello 后自动回复 hello_ack
      if (msg.type === "hello") {
        const helloAck = {
          id: "ha-auto",
          from: "ns/bob",
          to: "ns/test-daemon",
          text: "",
          type: "hello_ack",
          session: "bob-remote-session",
          hop: 1,
          reply_to: null,
          expect_reply: false,
          redirect_client_id: "ns/bob",
          timestamp: new Date().toISOString(),
        };
        broker.publish({
          cmd: "publish",
          topic: "/agentbus/ai/channel/ns/test-daemon/message",
          payload: JSON.stringify(helloAck),
          qos: 1,
          retain: false,
          dup: false,
        }, () => {});
      }
    });

    // sendMessage：通道不存在 → 自动建 SYN_SENT → 发 hello → 等 hello_ack → 发 text
    const result = await daemonAny.sendMessage("bob", "Hi after handshake", false, 5000);
    expect(result.status).toBe("sent");

    // 等待 text 消息到达
    await new Promise((r) => setTimeout(r, 300));

    // 应至少有 hello + text 两条消息
    const helloMsg = messages.find((m) => m.type === "hello");
    const textMsg = messages.find((m) => m.type === "text");
    expect(helloMsg).toBeDefined();
    expect(helloMsg.from).toBe("ns/test-daemon");
    expect(helloMsg.to).toBe("ns/bob");
    expect(textMsg).toBeDefined();
    expect(textMsg.text).toBe("Hi after handshake");
    expect(textMsg.session).toBe("bob-remote-session");

    // 通道应变为 ESTABLISHED
    const channel = daemonAny.channels.get("ns/bob");
    expect(channel.state).toBe("ESTABLISHED");
    expect(channel.remoteSessionId).toBe("bob-remote-session");

    probeClient.end();
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
