/**
 * TASK-12: doctor 环境体检 + status 状态摘要（架构 6.1 / 6.5-D 红线 7）
 *
 * doctor 检查项：配置 / broker 可达 / SSE 可达 / CLI 探测 / MCP 注册回验 / daemon 存活
 * status：daemon pid 状态 + sessions.json 摘要
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { readDaemonStatus, readSessionsSummary } from "../src/status.js";

let root: string;
let workDir: string;
let home: string;

const CONFIG = {
  client_id: "demo",
  ns: "default",
  broker: { host: "localhost", port: 18830 },
  sse_url: "http://localhost:8000/sse?client_id=demo&ns=default",
  default_tool: "qoder",
  allowed_senders: [],
  hop_limit: 3,
  rate_limit: 5,
  inbound_mode: "readonly",
  trust_map: {},
  tools: { qoder: {} },
  ack: true,
};

function baseDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    workDir,
    projectRoot: root,
    homeDir: home,
    runner: async (bin, args) => {
      if (args.includes("--version")) return { exitCode: 0, stdout: `${bin} 1.0.0`, stderr: "" };
      if (args.includes("list")) return { exitCode: 0, stdout: "agentbus: http://...", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    checkTcp: async () => true,
    checkHttp: async () => true,
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentbus-doctor-"));
  workDir = join(root, ".agentbus");
  mkdirSync(workDir, { recursive: true });
  home = mkdtempSync(join(tmpdir(), "agentbus-home-"));
  writeFileSync(join(workDir, "config.json"), JSON.stringify(CONFIG));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("全绿场景：所有检查项通过，整体 ok", async () => {
    // 前置：MCP 已注册 + daemon 在跑
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { agentbus: { type: "sse", url: CONFIG.sse_url } },
    }));
    writeFileSync(join(workDir, "daemon.pid"), String(process.pid));
    const report = await runDoctor(baseDeps());
    expect(report.ok).toBe(true);
    const names = report.checks.map((c) => c.name);
    for (const n of ["配置", "Broker", "SSE", "CLI", "MCP 注册", "daemon"]) {
      expect(names.join(" ")).toContain(n);
    }
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("配置文件缺失 → 配置项失败且整体 ok=false", async () => {
    const report = await runDoctor(baseDeps({ workDir: join(root, "no-such-dir") }));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("配置"))?.ok).toBe(false);
  });

  it("broker TCP 不通 → 该项失败", async () => {
    const report = await runDoctor(baseDeps({ checkTcp: async () => false }));
    expect(report.checks.find((c) => c.name.includes("Broker"))?.ok).toBe(false);
  });

  it("SSE 不可达 → 该项失败（config 无 sse_url 时跳过为提示）", async () => {
    const report = await runDoctor(baseDeps({ checkHttp: async () => false }));
    expect(report.checks.find((c) => c.name.includes("SSE"))?.ok).toBe(false);
  });

  it("CLI 未安装 → CLI 项失败", async () => {
    const report = await runDoctor(
      baseDeps({ runner: async () => ({ exitCode: 127, stdout: "", stderr: "" }) }),
    );
    expect(report.checks.find((c) => c.name.includes("CLI"))?.ok).toBe(false);
  });

  it("红线 7：MCP 注册回验 —— file 型读文件键；未注册则失败", async () => {
    // 未写 .mcp.json → 注册验证失败
    const missing = await runDoctor(baseDeps());
    expect(missing.checks.find((c) => c.name.includes("MCP"))?.ok).toBe(false);

    // 写入正确注册 → 通过
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { agentbus: { type: "sse", url: CONFIG.sse_url } },
    }));
    const present = await runDoctor(baseDeps());
    expect(present.checks.find((c) => c.name.includes("MCP"))?.ok).toBe(true);
  });

  it("daemon：pid 存活为通过；无 pid 文件为失败并提示先 daemon start", async () => {
    const noPid = await runDoctor(baseDeps());
    expect(noPid.checks.find((c) => c.name.includes("daemon"))?.ok).toBe(false);

    writeFileSync(join(workDir, "daemon.pid"), String(process.pid));
    const alive = await runDoctor(baseDeps());
    expect(alive.checks.find((c) => c.name.includes("daemon"))?.ok).toBe(true);
  });
});

describe("status 摘要", () => {
  it("readDaemonStatus：无 pid 文件 → 未运行；存活 pid → running", () => {
    expect(readDaemonStatus(workDir).running).toBe(false);
    writeFileSync(join(workDir, "daemon.pid"), String(process.pid));
    expect(readDaemonStatus(workDir).running).toBe(true);
    writeFileSync(join(workDir, "daemon.pid"), "99999999");
    const stale = readDaemonStatus(workDir);
    expect(stale.running).toBe(false);
    expect(stale.stale).toBe(true);
  });

  it("readSessionsSummary：统计 sender 数；文件损坏时降级为空摘要", () => {
    expect(readSessionsSummary(workDir).senderCount).toBe(0);
    writeFileSync(
      join(workDir, "sessions.json"),
      JSON.stringify({ version: 1, senders: { a: { qoder: { sessionId: "x", tool: "qoder", createdAt: 1 } } } }),
    );
    expect(readSessionsSummary(workDir).senderCount).toBe(1);
    writeFileSync(join(workDir, "sessions.json"), "{corrupt");
    expect(readSessionsSummary(workDir).senderCount).toBe(0);
  });
});
