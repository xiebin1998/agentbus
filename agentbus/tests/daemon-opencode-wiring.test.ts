/**
 * TASK-17: daemon defaultInject 的 opencode 分发接线（与 kilo 同族 KILO_FAMILY）
 * - tool="opencode" 时走 OpenCodeKiloAdapter，binary 缺省 = 工具名 "opencode"
 * - 首条 createSession（会话名 = 发件人）；CLI 侧 sessionId 回写后第二条 inject 续接
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
      return { sessionId, output: "opencode 续接输出", exitCode: 0, timedOut: false };
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
    default_tool: "opencode",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: {},
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
    topic: "/phnix/ai/channel/default/fe-test/message",
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
    const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire-"));
    const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    // binary 缺省时 = 工具名 opencode（与 kilo 族语义一致）
    publishToDaemon({ id: "o-1", from: "be-svc", to: "fe-test", text: "第一条" });
    await waitFor(() => calls.length >= 1);
    expect(calls[0]!.method).toBe("createSession");
    expect(calls[0]!.args[1]).toBe("be-svc"); // 会话名 = 发件人
    expect(ctorConfigs[0]).toMatchObject({ binary: "opencode" });

    publishToDaemon({ id: "o-2", from: "be-svc", to: "fe-test", text: "第二条" });
    await waitFor(() => calls.length >= 2);
    expect(calls[1]!.method).toBe("inject");
    // 关键：续接用的是适配器回写的真实 session id（同 kilo 族语义）
    expect(calls[1]!.args[1]).toBe("ses-opencode-real");

    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tools.opencode.binary/workspace 配置透传给适配器", async () => {
    ctorConfigs.length = 0;
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire2-"));
    const daemon = new Daemon({
      config: makeConfig({ ack: false, tools: { opencode: { binary: "opencode-nightly", workspace: "/ws" } } }),
      workDir: dir,
    });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "o-3", from: "be-svc", to: "fe-test", text: "binary 透传" });
    await waitFor(() => ctorConfigs.length >= 1);
    expect(ctorConfigs[0]).toMatchObject({ binary: "opencode-nightly", workspace: "/ws" });

    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
