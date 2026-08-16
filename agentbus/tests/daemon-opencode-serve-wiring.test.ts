/**
 * TASK-27: daemon defaultInject 的 opencode serve 模式接线（架构 5.4）
 * - tools.opencode.serve=true 且适配器 supportsServe → 走 ServeManager.ensure + attach 回合
 * - attach 回合失败 → 回退冷启动 run（保证可用性优先）
 * - serve 未启用 / kilo（不支持 serve）→ 维持既有冷启动路径（回归守护）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aedes from "aedes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon } from "../src/daemon/daemon.js";

interface CallRecord {
  method: string;
  args: unknown[];
}

const calls: CallRecord[] = [];
let injectShouldFail = false;

vi.mock("../src/adapters/opencode-kilo.js", () => ({
  OpenCodeKiloAdapter: class {
    constructor(public cfg: { binary?: string }) {}
    supportsServe() {
      return this.cfg.binary === "opencode";
    }
    async createSession(message: string, sessionName: string) {
      calls.push({ method: "createSession", args: [message, sessionName] });
      return { sessionId: "ses-cold", output: "冷启动建会话", exitCode: 0, timedOut: false };
    }
    async inject(message: string, sessionId: string) {
      calls.push({ method: "inject", args: [message, sessionId] });
      return { sessionId, output: "冷启动续接", exitCode: 0, timedOut: false };
    }
    async attachCreateSession(serverUrl: string, message: string, sessionName: string) {
      calls.push({ method: "attachCreateSession", args: [serverUrl, message, sessionName] });
      return { sessionId: "ses-attach", output: "attach 建会话", exitCode: 0, timedOut: false };
    }
    async attachInject(serverUrl: string, message: string, sessionId: string) {
      calls.push({ method: "attachInject", args: [serverUrl, message, sessionId] });
      if (injectShouldFail) return { sessionId, output: "", exitCode: 1, timedOut: false, error: "attach 失败" };
      return { sessionId, output: "attach 续接", exitCode: 0, timedOut: false };
    }
  },
}));

const ensureCalls: unknown[][] = [];
let ensureUrl = "http://127.0.0.1:4096";

vi.mock("../src/daemon/serve-manager.js", () => ({
  ServeManager: class {
    async ensure(spec: unknown) {
      ensureCalls.push([spec]);
      return ensureUrl;
    }
    stopAll() {}
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
    tools: { opencode: { serve: true } },
    ack: true,
    ...overrides,
  };
}

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

describe("defaultInject opencode serve 模式接线", { timeout: 30000 }, () => {
  it("serve=true：首条 attachCreateSession、续条 attachInject（注入免冷启动）", async () => {
    calls.length = 0;
      ensureCalls.length = 0;
      injectShouldFail = false;
      currentClientId = `fe-sw1-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-serve-wire-"));
      const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir, onExit: () => {} });
    expect(daemon.start()).toMatchObject({ started: true });
    try {
      await waitFor(() => daemon.status().connected);

      publishToDaemon({ id: "s-1", from: "be-svc", to: currentClientId, text: "第一条" });
      await waitFor(() => calls.length >= 1);
      expect(calls[0]!.method).toBe("attachCreateSession");
      expect(ensureCalls.length).toBe(1);

      publishToDaemon({ id: "s-2", from: "be-svc", to: currentClientId, text: "第二条" });
      await waitFor(() => calls.length >= 2);
      expect(calls[1]!.method).toBe("attachInject");
      expect(calls[1]!.args[2]).toBe("ses-attach"); // 续接 serve 回合回写的 session id（args[0]=url）
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attach 回合失败 → 回退冷启动 inject（可用性优先）", async () => {
      calls.length = 0;
      injectShouldFail = true;
      currentClientId = `fe-sw2-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-serve-wire2-"));
      const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir, onExit: () => {} });
    daemon.start();
    try {
      await waitFor(() => daemon.status().connected);

      publishToDaemon({ id: "s-3", from: "be-svc", to: currentClientId, text: "回退验证" });
      await waitFor(() => calls.length >= 1);
      publishToDaemon({ id: "s-4", from: "be-svc", to: currentClientId, text: "第二条" });
      await waitFor(() => calls.length >= 3);
      expect(calls[1]!.method).toBe("attachInject"); // 先尝试 attach
      expect(calls[2]!.method).toBe("inject"); // 失败后回退冷启动

      injectShouldFail = false;
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serve 未启用 → 维持冷启动路径（回归守护）", async () => {
      calls.length = 0;
      ensureCalls.length = 0;
      currentClientId = `fe-sw3-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-serve-wire3-"));
      const daemon = new Daemon({
        config: makeConfig({ ack: false, tools: { opencode: {} } }),
        workDir: dir,
        onExit: () => {},
      });
    daemon.start();
    try {
      await waitFor(() => daemon.status().connected);

      publishToDaemon({ id: "s-5", from: "be-svc", to: currentClientId, text: "无 serve" });
      await waitFor(() => calls.length >= 1);
      expect(calls[0]!.method).toBe("createSession");
      expect(ensureCalls.length).toBe(0);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kilo + serve=true：不支持 serve → 忽略配置走冷启动", async () => {
      calls.length = 0;
      ensureCalls.length = 0;
      currentClientId = `fe-sw4-${Math.random().toString(36).slice(2, 8)}`;
      const dir = mkdtempSync(join(tmpdir(), "agentbus-serve-wire4-"));
      const daemon = new Daemon({
        config: makeConfig({ ack: false, default_tool: "kilo", tools: { kilo: { serve: true } } }),
        workDir: dir,
        onExit: () => {},
      });
    daemon.start();
    try {
      await waitFor(() => daemon.status().connected);

      publishToDaemon({ id: "s-6", from: "be-svc", to: currentClientId, text: "kilo 无 serve" });
      await waitFor(() => calls.length >= 1);
      expect(calls[0]!.method).toBe("createSession");
      expect(ensureCalls.length).toBe(0);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
