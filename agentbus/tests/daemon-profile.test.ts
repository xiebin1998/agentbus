/**
 * TASK-32 Task 8: daemon 档案接线
 * 1. 指标 payload 增 tools（键列表），不带名称/描述/能力
 * 2. 快照同步：随指标周期 GET 快照端点 → 原子写 .agentbus/agents.json（tmp+rename）；失败静默保留旧文件
 * 3. daemon 收到 identity_conflict → 错误日志 + 退出码 2
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aedes from "aedes";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentBusConfig } from "../src/config.js";
import { Daemon } from "../src/daemon/daemon.js";
import type { Listener } from "../src/daemon/listener.js";
import { buildMetricPayload, MetricsCollector } from "../src/daemon/metrics.js";
import { syncAgentsSnapshot } from "../src/daemon/snapshot.js";

describe("指标 payload 契约（TASK-32）", () => {
  it("payload 带 tools 键列表；不带名称/描述/能力等档案块", () => {
    const collector = new MetricsCollector();
    const payload = JSON.parse(
      buildMetricPayload("iot/ag-1", collector, { senders: 2, tools: ["qoder", "kilo"] }),
    ) as Record<string, unknown>;
    expect(payload.tools).toEqual(["qoder", "kilo"]);
    const metrics = payload.metrics as Record<string, unknown>;
    expect(typeof metrics.injected_ok).toBe("number");
    for (const k of ["name", "description", "capabilities"]) {
      expect(payload).not.toHaveProperty(k);
      expect(metrics).not.toHaveProperty(k);
    }
  });
});

describe("快照同步 syncAgentsSnapshot", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentbus-snap-"));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  const baseOpts = () => ({
    workDir,
    sseUrl: "http://10.1.5.100:8000/sse?client_id=ag-1&ns=iot",
    ns: "iot",
    username: "bob",
    password: "pw",
  });

  it("成功：GET origin/api/agent/snapshot?ns=..（Basic=broker 凭证）→ 原子写 agents.json，无 tmp 残留", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const body = JSON.stringify({ generated_at: "t", agents: [{ client_id: "ag-2", name: "乙" }] });
    const r = await syncAgentsSnapshot({
      ...baseOpts(),
      fetcher: async (url, init) => {
        calls.push({ url, auth: init.headers["Authorization"] });
        return { ok: true, status: 200, text: async () => body };
      },
    });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://10.1.5.100:8000/api/agent/snapshot?ns=iot");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("bob:pw").toString("base64")}`);
    expect(readFileSync(join(workDir, "agents.json"), "utf-8")).toBe(body);
    expect(existsSync(join(workDir, "agents.json.tmp"))).toBe(false);
  });

  it("fetch 抛错：静默失败，旧 agents.json 原样保留", async () => {
    const old = JSON.stringify({ agents: ["old"] });
    writeFileSync(join(workDir, "agents.json"), old, "utf-8");
    const r = await syncAgentsSnapshot({
      ...baseOpts(),
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(workDir, "agents.json"), "utf-8")).toBe(old);
  });

  it("HTTP 非 2xx：静默失败，旧文件保留", async () => {
    const old = JSON.stringify({ agents: ["old"] });
    writeFileSync(join(workDir, "agents.json"), old, "utf-8");
    const r = await syncAgentsSnapshot({
      ...baseOpts(),
      fetcher: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
    });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(workDir, "agents.json"), "utf-8")).toBe(old);
  });

  it("无凭证：跳过（不调 fetcher），不碰文件", async () => {
    let fetched = 0;
    const r = await syncAgentsSnapshot({
      workDir,
      sseUrl: "http://h:8000/sse",
      ns: "iot",
      fetcher: async () => {
        fetched += 1;
        return { ok: true, status: 200, text: async () => "{}" };
      },
    });
    expect(r.ok).toBe(false);
    expect(fetched).toBe(0);
    expect(existsSync(join(workDir, "agents.json"))).toBe(false);
  });
});

describe("daemon identity_conflict 处置（TASK-32）", () => {
  let broker: aedes.Aedes;
  let server: NetServer;
  let port: number;
  let workDir: string;

  beforeAll(async () => {
    broker = aedes();
    server = createNetServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    server.close();
  });
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentbus-conflict-"));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  function makeConfig(): AgentBusConfig {
    return {
      client_id: "conflict-t",
      ns: "default",
      broker: { host: "127.0.0.1", port },
      default_tool: "kilo",
      allowed_senders: [],
      hop_limit: 3,
      rate_limit: 100,
      inbound_mode: "readonly",
      trust_map: {},
      tools: { kilo: {} },
      ack: true,
    };
  }

  it("listener 报 identity_conflict → daemon 错误日志落盘 + onExit(2)", async () => {
    let statusCb: ((s: string, detail?: string) => void) | undefined;
    const fakeListener: Listener = {
      start: async () => {},
      stop: async () => {},
      publish: async () => {},
      isConnected: () => true,
    };
    const exits: number[] = [];
    const d = new Daemon({
      config: makeConfig(),
      workDir,
      metricIntervalMs: 60_000,
      onExit: (code) => exits.push(code),
      listenerFactory: (opts) => {
        statusCb = opts.onStatus;
        return fakeListener;
      },
    });
    expect(d.start().started).toBe(true);
    statusCb!("identity_conflict", "60s 内 3 次非主动断连");
    await new Promise((r) => setTimeout(r, 100));
    expect(exits).toEqual([2]);
    const log = readFileSync(join(workDir, "logs", "daemon.log"), "utf-8");
    expect(log).toContain("identity_conflict");
    await d.stop();
  });
});

describe("daemon 快照同步接线（随指标周期）", () => {
  let broker: aedes.Aedes;
  let netServer: NetServer;
  let port: number;
  let httpServer: Server;
  let httpPort: number;
  let workDir: string;

  beforeAll(async () => {
    broker = aedes();
    netServer = createNetServer(broker.handle);
    await new Promise<void>((resolve) => netServer.listen(0, "127.0.0.1", resolve));
    port = (netServer.address() as { port: number }).port;
    httpServer = createServer((req, res) => {
      if (req.url?.startsWith("/api/agent/snapshot")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ generated_at: "t", agents: [{ client_id: "ag-9", name: "同伴" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    httpPort = (httpServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    netServer.close();
    httpServer.close();
  });
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentbus-dsync-"));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("启动后随指标周期拉快照并写 agents.json（Basic=broker 凭证）", async () => {
    const config: AgentBusConfig = {
      client_id: "dsync-t",
      ns: "default",
      broker: { host: "127.0.0.1", port, username: "bob", password: "pw" },
      sse_url: `http://127.0.0.1:${httpPort}/sse?client_id=dsync-t&ns=default`,
      default_tool: "kilo",
      allowed_senders: [],
      hop_limit: 3,
      rate_limit: 100,
      inbound_mode: "readonly",
      trust_map: {},
      tools: { kilo: {} },
      ack: true,
    };
    const d = new Daemon({ config, workDir, metricIntervalMs: 200 });
    expect(d.start().started).toBe(true);
    const deadline = Date.now() + 8000;
    while (!existsSync(join(workDir, "agents.json")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const snap = JSON.parse(readFileSync(join(workDir, "agents.json"), "utf-8")) as { agents: unknown[] };
    expect(snap.agents.length).toBe(1);
    await d.stop();
  }, 15_000);
});
