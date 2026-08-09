/**
 * TASK-15: daemon defaultInject 的 claude 分发接线
 * config tools.claude 且未注入 inject 钩子时，应走 ClaudeAdapter：
 * - 首条消息 createSession（--session-id 形态），mode 按信任分级
 * - 第二条消息 injectWith（-r 续接形态）
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

vi.mock("../src/adapters/claude.js", () => ({
  newClaudeSessionId: () => "mock-uuid",
  ClaudeAdapter: class {
    constructor(cfg: unknown) {
      ctorConfigs.push(cfg);
    }
    async createSession(text: string, sessionId: string, mode: string) {
      calls.push({ method: "createSession", args: [text, sessionId, mode] });
      return { sessionId, output: "claude 建会话输出", exitCode: 0, timedOut: false };
    }
    async injectWith(text: string, sessionId: string, mode: string) {
      calls.push({ method: "injectWith", args: [text, sessionId, mode] });
      return { sessionId, output: "claude 续接输出", exitCode: 0, timedOut: false };
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
    default_tool: "claude",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: {},
    tools: { claude: {} },
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

describe("defaultInject claude 分发", { timeout: 30000 }, () => {
  it("首条走 createSession（readonly → plan 参数由适配器负责），第二条走 injectWith 复用会话", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbus-claude-wire-"));
    const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "c-1", from: "be-svc", to: "fe-test", text: "第一条" });
    await waitFor(() => calls.length >= 1);
    expect(calls[0]!.method).toBe("createSession");
    expect(calls[0]!.args[2]).toBe("readonly");

    publishToDaemon({ id: "c-2", from: "be-svc", to: "fe-test", text: "第二条" });
    await waitFor(() => calls.length >= 2);
    expect(calls[1]!.method).toBe("injectWith");
    // 会话复用：续接使用首条生成的 sessionId
    expect(calls[1]!.args[1]).toBe(calls[0]!.args[1]);

    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("trust_map full → mode 传入 full", async () => {
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-claude-wire2-"));
    const daemon = new Daemon({
      config: makeConfig({ ack: false, trust_map: { "ci-bot": "full" } }),
      workDir: dir,
    });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "c-3", from: "ci-bot", to: "fe-test", text: "full 消息" });
    await waitFor(() => calls.length >= 1);
    expect(calls[0]!.args[2]).toBe("full");

    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tools.claude.binary 配置透传给适配器", async () => {
    ctorConfigs.length = 0;
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-claude-wire3-"));
    const daemon = new Daemon({
      config: makeConfig({ ack: false, tools: { claude: { binary: "claude-nightly", workspace: "/ws" } } }),
      workDir: dir,
    });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "c-4", from: "be-svc", to: "fe-test", text: "binary 透传" });
    await waitFor(() => ctorConfigs.length >= 1);
    expect(ctorConfigs[0]).toMatchObject({ binary: "claude-nightly", workspace: "/ws" });

    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
