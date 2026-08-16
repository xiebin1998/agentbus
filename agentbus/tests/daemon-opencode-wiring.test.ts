/**
 * TASK-17: daemon defaultInject 的 opencode 分发接线（与 kilo 同族 KILO_FAMILY）
 * - tool="opencode" 时走 OpenCodeKiloAdapter，binary 缺省 = 工具名 "opencode"
 * - 首条 createSession（会话名 = 发件人）；CLI 侧 sessionId 回写后第二条 inject 续接
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aedes from "aedes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon } from "../src/daemon/daemon.js";

interface CallRecord {
  method: "createSession" | "inject";
  args: unknown[];
}

const calls: CallRecord[] = [];
const ctorConfigs: unknown[] = [];

vi.mock("../src/adapters/opencode-kilo.js", () => ({
  OpenCodeKiloAdapter: class {
    constructor(cfg: unknown) {
      ctorConfigs.push(cfg);
    }
    async createSession(message: string, sessionName: string) {
      calls.push({ method: "createSession", args: [message, sessionName] });
      return { sessionId: "ses-opencode-real", output: "opencode 建会话输出", exitCode: 0, timedOut: false };
    }
    async inject(message: string, sessionId: string) {
      calls.push({ method: "inject", args: [message, sessionId] });
      // 模拟会话已被删：注回该 id 必败（验证回退新建）
      if (sessionId === "ses-gone") {
        return { sessionId: null, output: "", exitCode: 1, timedOut: false, error: "session not found" };
      }
      return { sessionId, output: "opencode 续接输出", exitCode: 0, timedOut: false };
    }
  },
}));

// Mock adapter-lock 避免全局目录权限问题
vi.mock("../src/daemon/adapter-lock.js", () => ({
  acquireAdapterLock: async () => {},
  tryAcquireAdapterLock: async () => true,
  releaseAdapterLock: async () => {},
}));

let broker: aedes.Aedes;
let server: Server;
let port: number;
let currentClientId = "fe-test";

function makeConfig(overrides: Partial<AgentBusConfig> = {}): AgentBusConfig {
  return {
    client_id: currentClientId,
    ns: "default",
    broker: { host: "127.0.0.1", port },
    default_tool: "opencode",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    tools: { opencode: {} },
    ack: true,
    ...overrides,
  };
}

// 全量并行时 broker 连接/投递受负载影响，放宽本文件超时
async function waitFor(cond: () => boolean, timeoutMs = 15000): Promise<void> {
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

function publishToDaemon(msg: Record<string, unknown>): void {
  broker.publish({
    cmd: "publish",
    topic: `/agentbus/ai/channel/default/${currentClientId}/message`,
    payload: JSON.stringify({ type: "text", hop: 0, expect_reply: false, ...msg }),
    qos: 1,
    retain: false,
    dup: false,
  }, () => {});
}

describe("defaultInject opencode 分发（KILO_FAMILY）", { timeout: 30000 }, () => {
    it("首条 createSession；CLI 侧 sessionId 回写后第二条 inject 续接", async () => {
      calls.length = 0;
      ctorConfigs.length = 0;
      currentClientId = `fe-oc1-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire-"));
      const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir, onExit: () => {} });
      expect(daemon.start()).toMatchObject({ started: true });
      try {
        await waitFor(() => daemon.status().connected);

        // binary 缺省时 = 工具名 opencode（与 kilo 族语义一致）
        publishToDaemon({ id: "o-1", from: "be-svc", to: currentClientId, text: "第一条" });
        await waitFor(() => calls.length >= 1);
        expect(calls[0]!.method).toBe("createSession");
        expect(calls[0]!.args[1]).toBe("be-svc"); // 会话名 = 发件人
        expect(ctorConfigs[0]).toMatchObject({ binary: "opencode" });

        publishToDaemon({ id: "o-2", from: "be-svc", to: currentClientId, text: "第二条" });
        await waitFor(() => calls.length >= 2);
        expect(calls[1]!.method).toBe("inject");
        // 关键：续接用的是适配器回写的真实 session id（同 kilo 族语义）
        expect(calls[1]!.args[1]).toBe("ses-opencode-real");
      } finally {
        await daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

  it("tools.opencode.binary/workspace 配置透传给适配器", async () => {
    ctorConfigs.length = 0;
    calls.length = 0;
    currentClientId = `fe-oc2-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire2-"));
      const daemon = new Daemon({
        config: makeConfig({ ack: false, tools: { opencode: { binary: "opencode-nightly", workspace: "/ws" } } }),
        workDir: dir,
        onExit: () => {},
      });
    daemon.start();
    try {
      await waitFor(() => daemon.status().connected);

      publishToDaemon({ id: "o-3", from: "be-svc", to: currentClientId, text: "binary 透传" });
      await waitFor(() => ctorConfigs.length >= 1);
      expect(ctorConfigs[0]).toMatchObject({ binary: "opencode-nightly", workspace: "/ws" });
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

    it("会话标题使用 client_id（不再从本地快照查询）", async () => {
      calls.length = 0;
      currentClientId = `fe-oc3-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire3-"));
      const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir, onExit: () => {} });
      daemon.start();
      try {
        await waitFor(() => daemon.status().connected);

        // 会话名使用 client_id
        publishToDaemon({ id: "o-4", from: "ns2/be-svc", to: currentClientId, text: "命中快照" });
        await waitFor(() => calls.length >= 1);
        expect(calls[0]!.method).toBe("createSession");
        expect(calls[0]!.args[1]).toBe("be-svc");

        // 另一个发件人也使用 client_id
        publishToDaemon({ id: "o-5", from: "ns2/ghost-svc", to: currentClientId, text: "未命中" });
        await waitFor(() => calls.length >= 2);
        expect(calls[1]!.args[1]).toBe("ghost-svc");
      } finally {
        await daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("通道方案：回复携带 session → 更新通道 remoteSessionId，后续消息续接本地 session", async () => {
      calls.length = 0;
      currentClientId = `fe-oc4-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire4-"));
      const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir, onExit: () => {} });
      daemon.start();
      try {
        await waitFor(() => daemon.status().connected);

        // 第一条：创建通道 + createSession
        publishToDaemon({ id: "s-1", from: "be-svc", to: currentClientId, text: "提问" });
        await waitFor(() => calls.length >= 1);
        expect(calls[0]!.method).toBe("createSession");

        // 第二条：同发件人，通道已存在，续接本地 session（不再用消息的 session 字段）
        publishToDaemon({ id: "s-2", from: "be-svc", to: currentClientId, text: "继续" });
        await waitFor(() => calls.length >= 2);
        expect(calls[1]!.method).toBe("inject");
        expect(calls[1]!.args[1]).toBe("ses-opencode-real");

        // 第三条：仍然续接同一 session
        publishToDaemon({ id: "s-3", from: "be-svc", to: currentClientId, text: "再来一条" });
        await waitFor(() => calls.length >= 3);
        expect(calls[2]!.method).toBe("inject");
        expect(calls[2]!.args[1]).toBe("ses-opencode-real");
      } finally {
        await daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("通道方案：新发件人首条消息 → createSession 新建通道", async () => {
      calls.length = 0;
      currentClientId = `fe-oc5-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire5-"));
      const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir, onExit: () => {} });
      daemon.start();
      try {
        await waitFor(() => daemon.status().connected);

        // 新发件人首条：创建通道 + createSession
        publishToDaemon({ id: "s-4", from: "svc-x", to: currentClientId, text: "你好" });
        await waitFor(() => calls.length >= 1);
        expect(calls[0]!.method).toBe("createSession");
        // 第二条：同发件人续接
        publishToDaemon({ id: "s-5", from: "svc-x", to: currentClientId, text: "继续" });
        await waitFor(() => calls.length >= 2);
        expect(calls[1]!.method).toBe("inject");
        expect(calls[1]!.args[1]).toBe("ses-opencode-real");
      } finally {
        await daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
});
