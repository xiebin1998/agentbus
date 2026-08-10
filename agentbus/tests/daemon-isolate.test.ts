/**
 * TASK-30: daemon 隔离接线（架构 4.7 三层防线之隔离层）
 *
 * 验收语义：readonly 回合在 OS 层物理禁写（参数层被绕过时仍安全）——
 * isolation=true 时 daemon 在注入回合窗口内对工作目录施加只读，回合结束解除；
 * full 回合与 isolation=false 时不施加。
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aedes from "aedes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon } from "../src/daemon/daemon.js";
import { probeReadonly } from "../src/isolate.js";

let broker: aedes.Aedes;
let server: Server;
let port: number;

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
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

function publish(from: string, id: string, text: string): void {
  broker.publish({
    cmd: "publish",
    topic: "/phnix/ai/channel/default/fe-iso/message",
    payload: JSON.stringify({ id, from, to: "fe-iso", text, type: "text", hop: 0, expect_reply: false }),
    qos: 1,
    retain: false,
    dup: false,
  }, () => {});
}

/** 组装 daemon：workspace 为独立临时目录（含 .agentbus 子目录，隔离需排除它） */
async function runScenario(opts: {
  isolation: boolean;
  trustMap?: Record<string, "readonly" | "full">;
}): Promise<{ probes: boolean[]; workspace: string; cleanup: () => Promise<void> }> {
  const workspace = mkdtempSync(join(tmpdir(), "agentbus-iso-ws-"));
  mkdirSync(join(workspace, ".agentbus"), { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "agentbus-iso-wd-"));
  const config: AgentBusConfig = {
    client_id: "fe-iso",
    ns: "default",
    broker: { host: "127.0.0.1", port },
    default_tool: "kilo",
    allowed_senders: [],
    hop_limit: 3,
    rate_limit: 100,
    inbound_mode: "readonly",
    trust_map: opts.trustMap ?? {},
    tools: { kilo: { workspace } },
    ack: true,
    isolation: opts.isolation,
  };
  const probes: boolean[] = [];
  const daemon = new Daemon({
    config,
    workDir,
    inject: async () => {
      probes.push(probeReadonly(workspace));
      return { output: "ok" };
    },
  });
  expect(daemon.start()).toMatchObject({ started: true });
  await waitFor(() => daemon.status().connected);
  return {
    probes,
    workspace,
    cleanup: async () => {
      // stop 须等 MQTT 关闭完成（异步 offline 日志）再删目录，否则 appendFileSync ENOENT 变 unhandled rejection
      await daemon.stop();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform !== "win32")("TASK-30: isolation 接线（真机 icacls）", () => {
  it("isolation=true + readonly：回合窗口内物理禁写，回合后解除", async () => {
    const { probes, workspace, cleanup } = await runScenario({ isolation: true });
    try {
      publish("be-svc", "iso-1", "只读回合");
      await waitFor(() => probes.length === 1);
      expect(probes[0]).toBe(true); // 注入窗口内工作目录已只读
      await new Promise((r) => setTimeout(r, 300)); // 等 isolateRelease 串行链走完
      expect(probeReadonly(workspace)).toBe(false); // 回合结束解除
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("isolation=true + full（trust_map 提权）：不施加隔离", async () => {
    const { probes, cleanup } = await runScenario({ isolation: true, trustMap: { "ci-bot": "full" } });
    try {
      publish("ci-bot", "iso-2", "完整权限回合");
      await waitFor(() => probes.length === 1);
      expect(probes[0]).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("isolation=false（默认）：readonly 回合也不施加隔离", async () => {
    const { probes, cleanup } = await runScenario({ isolation: false });
    try {
      publish("be-svc", "iso-3", "普通回合");
      await waitFor(() => probes.length === 1);
      expect(probes[0]).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("stop() 返回 Promise 且 resolve 于 MQTT 关闭完成后（resolve 后即可安全删 workDir）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agentbus-iso-ws3-"));
    mkdirSync(join(workspace, ".agentbus"), { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), "agentbus-iso-wd3-"));
    const daemon = new Daemon({
      config: {
        client_id: "fe-iso",
        ns: "default",
        broker: { host: "127.0.0.1", port },
        default_tool: "kilo",
        allowed_senders: [],
        hop_limit: 3,
        rate_limit: 100,
        inbound_mode: "readonly",
        trust_map: {},
        tools: { kilo: { workspace } },
        ack: true,
        isolation: false,
      },
      workDir,
      inject: async () => ({ output: "ok" }),
    });
    expect(daemon.start()).toMatchObject({ started: true });
    await waitFor(() => daemon.status().connected);
    const stopped = daemon.stop() as unknown;
    // 契约：stop 必须可 await（RED 前返回 void，此断言失败）
    expect(typeof (stopped as Promise<void> | undefined)?.then).toBe("function");
    await stopped;
    expect(daemon.status().connected).toBe(false);
    // resolve 后立即删目录：无异步日志残留（若有则变 unhandled rejection 使全套非零退出）
    rmSync(workspace, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 200));
  }, 30_000);

  it("并发异源回合：隔离引用计数，全部结束后才解除", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agentbus-iso-ws2-"));
    mkdirSync(join(workspace, ".agentbus"), { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), "agentbus-iso-wd2-"));
    const probes: boolean[] = [];
    let releaseBoth!: () => void;
    const gate = new Promise<void>((r) => (releaseBoth = r));
    const daemon = new Daemon({
      config: {
        client_id: "fe-iso",
        ns: "default",
        broker: { host: "127.0.0.1", port },
        default_tool: "kilo",
        allowed_senders: [],
        hop_limit: 3,
        rate_limit: 100,
        inbound_mode: "readonly",
        trust_map: {},
        tools: { kilo: { workspace } },
        ack: true,
        isolation: true,
      },
      workDir,
      inject: async () => {
        probes.push(probeReadonly(workspace));
        await gate; // 两个回合同时在窗口内
        return { output: "ok" };
      },
    });
    try {
      expect(daemon.start()).toMatchObject({ started: true });
      await waitFor(() => daemon.status().connected);
      publish("sender-a", "iso-4", "并发 A");
      publish("sender-b", "iso-5", "并发 B");
      await waitFor(() => probes.length === 2);
      expect(probes[0]).toBe(true);
      expect(probes[1]).toBe(true);
      expect(probeReadonly(workspace)).toBe(true); // 两回合都未结束 → 仍隔离
      releaseBoth();
      await new Promise((r) => setTimeout(r, 500));
      expect(probeReadonly(workspace)).toBe(false); // 引用归零 → 解除
    } finally {
      await daemon.stop();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});
