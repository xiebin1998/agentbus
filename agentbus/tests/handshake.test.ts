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
import aedes from "aedes";
import mqtt from "mqtt";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
