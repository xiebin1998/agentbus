/**
 * TASK-16: daemon defaultInject 的 codex 分发接线
 * codex 会话 id 由 CLI 侧生成（JSONL 提取）：
 * - 首条 createSession；适配器返回的 sessionId 回写注册表（与 kilo 族同语义）
 * - 第二条 injectWith 用回写后的真实 thread_id 续接
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
  method: "createSession" | "injectWith";
  args: unknown[];
}

const calls: CallRecord[] = [];
const ctorConfigs: unknown[] = [];

vi.mock("../src/adapters/codex.js", () => ({
  CodexAdapter: class {
    constructor(cfg: unknown) {
      ctorConfigs.push(cfg);
    }
    async createSession(text: string, mode: string) {
      calls.push({ method: "createSession", args: [text, mode] });
      return { sessionId: "thread-real-id", output: "codex 建会话输出", exitCode: 0, timedOut: false };
    }
    async injectWith(text: string, sessionId: string, mode: string) {
      calls.push({ method: "injectWith", args: [text, sessionId, mode] });
      return { sessionId, output: "codex 续接输出", exitCode: 0, timedOut: false };
    }
  },
}));

let broker: aedes.Aedes;
let server: Server;
let port: number;

function makeConfig(overrides: Partial<AgentBusConfig> = {}): AgentBusConfig {
  return {
    client_id: "fe-test",
    ns: "default",
    broker: { host: "127.0.0.1", port },
    default_tool: "codex",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: {},
    tools: { codex: {} },
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
    topic: "/phnix/ai/channel/default/fe-test/message",
    payload: JSON.stringify({ type: "text", hop: 0, expect_reply: false, ...msg }),
    qos: 1,
    retain: false,
    dup: false,
  }, () => {});
}

describe("defaultInject codex 分发", { timeout: 30000 }, () => {
  it("首条 createSession；CLI 侧 sessionId 回写后第二条用它续接", async () => {
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-codex-wire-"));
    const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "x-1", from: "be-svc", to: "fe-test", text: "第一条" });
    await waitFor(() => calls.length >= 1);
    expect(calls[0]!.method).toBe("createSession");
    expect(calls[0]!.args[1]).toBe("readonly");

    publishToDaemon({ id: "x-2", from: "be-svc", to: "fe-test", text: "第二条" });
    await waitFor(() => calls.length >= 2);
    expect(calls[1]!.method).toBe("injectWith");
    // 关键：续接用的是适配器回写的真实 thread_id，而非 daemon 预生成 UUID
    expect(calls[1]!.args[1]).toBe("thread-real-id");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tools.codex.binary/workspace 配置透传给适配器", async () => {
    ctorConfigs.length = 0;
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-codex-wire2-"));
    const daemon = new Daemon({
      config: makeConfig({ ack: false, tools: { codex: { binary: "codex-nightly", workspace: "/ws" } } }),
      workDir: dir,
    });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "x-3", from: "be-svc", to: "fe-test", text: "binary 透传" });
    await waitFor(() => ctorConfigs.length >= 1);
    expect(ctorConfigs[0]).toMatchObject({ binary: "codex-nightly", workspace: "/ws" });

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
