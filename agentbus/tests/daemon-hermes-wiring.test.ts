/**
 * TASK-18: daemon defaultInject 的 hermes 分发接线（架构 5.5 A）
 * hermes 按名建/续（同一命令形态，会话名 = 发件人）：
 * - 首条 createSession(sessionName=发件人)；第二条 inject 同名续接
 * - remote 段（host/user/ssh_key）从 tools.hermes.remote 透传给适配器
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

vi.mock("../src/adapters/hermes.js", () => ({
  HermesAdapter: class {
    constructor(cfg: unknown) {
      ctorConfigs.push(cfg);
    }
    async createSession(text: string, sessionName: string) {
      calls.push({ method: "createSession", args: [text, sessionName] });
      return { sessionId: sessionName, output: "hermes 建会话输出", exitCode: 0, timedOut: false };
    }
    async inject(text: string, sessionName: string) {
      calls.push({ method: "inject", args: [text, sessionName] });
      return { sessionId: sessionName, output: "hermes 续接输出", exitCode: 0, timedOut: false };
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
    default_tool: "hermes",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: {},
    tools: { hermes: {} },
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

describe("defaultInject hermes 分发（按名建/续）", { timeout: 30000 }, () => {
  it("首条 createSession、第二条 inject，会话名均 = 发件人（按名幂等）", async () => {
    calls.length = 0;
    ctorConfigs.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-hermes-wire-"));
    const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "h-1", from: "be-svc", to: "fe-test", text: "第一条" });
    await waitFor(() => calls.length >= 1);
    expect(calls[0]!.method).toBe("createSession");
    expect(calls[0]!.args[1]).toBe("be-svc"); // 会话名 = 发件人

    publishToDaemon({ id: "h-2", from: "be-svc", to: "fe-test", text: "第二条" });
    await waitFor(() => calls.length >= 2);
    expect(calls[1]!.method).toBe("inject");
    // 按名续接：会话名不变（区别于 UUID 注册表语义）
    expect(calls[1]!.args[1]).toBe("be-svc");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tools.hermes.remote/workspace/binary 配置透传给适配器", async () => {
    ctorConfigs.length = 0;
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-hermes-wire2-"));
    const daemon = new Daemon({
      config: makeConfig({
        ack: false,
        tools: {
          hermes: {
            binary: "hermes-nightly",
            workspace: "~/agent-home",
            remote: { host: "10.1.5.200", user: "root", ssh_key: "~/.ssh/id_ed25519" },
          },
        },
      }),
      workDir: dir,
    });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "h-3", from: "be-svc", to: "fe-test", text: "remote 透传" });
    await waitFor(() => ctorConfigs.length >= 1);
    expect(ctorConfigs[0]).toMatchObject({
      binary: "hermes-nightly",
      workspace: "~/agent-home",
      remote: { host: "10.1.5.200", user: "root", sshKey: "~/.ssh/id_ed25519" },
    });

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
