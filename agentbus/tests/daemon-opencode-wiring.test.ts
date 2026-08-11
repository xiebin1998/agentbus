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
    topic: "/agentbus/ai/channel/default/fe-test/message",
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

    await daemon.stop();
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

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Plan 3 问题 1：会话标题优先用 agents.json 快照名称，未命中回退 client_id", async () => {
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire3-"));
    // 快照同步的产物（syncAgentsSnapshot 写入同路径）：client_id → 名称映射
    writeFileSync(join(dir, "agents.json"), JSON.stringify({
      generated_at: "2026-08-11T00:00:00Z",
      agents: [{ client_id: "be-svc", name: "心语大师", online: true }],
    }), "utf-8");
    const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    // 命中快照：会话名用名称而非裸 client_id
    publishToDaemon({ id: "o-4", from: "ns2/be-svc", to: "fe-test", text: "命中快照" });
    await waitFor(() => calls.length >= 1);
    expect(calls[0]!.method).toBe("createSession");
    expect(calls[0]!.args[1]).toBe("心语大师");

    // 未命中快照：回退 client_id（现状行为不变）
    publishToDaemon({ id: "o-5", from: "ns2/ghost-svc", to: "fe-test", text: "未命中" });
    await waitFor(() => calls.length >= 2);
    expect(calls[1]!.args[1]).toBe("ghost-svc");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Plan 3 问题 2：回复携带 session → 注回原会话（不新建）且注册表回写", async () => {
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire4-"));
    const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({ id: "s-1", from: "be-svc", to: "fe-test", text: "提问" });
    await waitFor(() => calls.length >= 1);
    expect(calls[0]!.method).toBe("createSession");

    // 回复（reply_to 非空）携带发起方会话 → 续接注回 ses_origin 而非新建会话
    publishToDaemon({
      id: "s-2", from: "be-svc", to: "fe-test", text: "回复内容",
      reply_to: "s-1", session: "ses_origin", expect_reply: false,
    });
    await waitFor(() => calls.length >= 2);
    expect(calls[1]!.method).toBe("inject");
    expect(calls[1]!.args[1]).toBe("ses_origin");

    // 注册表已回写：同一发件人后续消息续接原会话（不再新建）
    publishToDaemon({ id: "s-3", from: "be-svc", to: "fe-test", text: "再来一条" });
    await waitFor(() => calls.length >= 3);
    expect(calls[2]!.method).toBe("inject");
    expect(calls[2]!.args[1]).toBe("ses_origin");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("Plan 3 问题 2：注回原会话失败（会话已删）→ 回退现状新建会话", async () => {
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "agentbus-opencode-wire5-"));
    const daemon = new Daemon({ config: makeConfig({ ack: false }), workDir: dir });
    daemon.start();
    await waitFor(() => daemon.status().connected);

    publishToDaemon({
      id: "s-4", from: "svc-x", to: "fe-test", text: "回复",
      reply_to: "s-0", session: "ses-gone", expect_reply: false,
    });
    await waitFor(() => calls.length >= 2);
    expect(calls[0]!.method).toBe("inject");
    expect(calls[0]!.args[1]).toBe("ses-gone");
    // 注回失败后回退新建（现状行为兼容）
    expect(calls[1]!.method).toBe("createSession");

    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
