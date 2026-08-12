/**
 * TASK-12: doctor 环境体检 + status 状态摘要（架构 6.1 / 6.5-D 红线 7）
 *
 * doctor 检查项：配置 / broker 可达 / SSE 可达 / CLI 探测 / MCP 注册回验 / daemon 存活
 * status：daemon pid 状态 + sessions.json 摘要
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

  it("配 remote 段的工具（hermes 远端）跳过本机探测，不报未安装（TASK-18）", async () => {
    writeFileSync(join(workDir, "config.json"), JSON.stringify({
      ...CONFIG,
      default_tool: "hermes",
      tools: { hermes: { remote: { host: "10.1.5.200", user: "root" }, workspace: "~/agent-home" } },
    }));
    const seen: string[] = [];
    const report = await runDoctor(baseDeps({
      runner: async (bin) => {
        seen.push(bin);
        return { exitCode: 127, stdout: "", stderr: "" };
      },
    }));
    const cli = report.checks.find((c) => c.name.includes("CLI"));
    expect(cli?.ok).toBe(true);
    expect(cli?.detail).toContain("hermes");
    expect(cli?.detail).toContain("远端");
    expect(seen).not.toContain("hermes"); // 本机不探测远端工具
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

describe("默认探测：localhost 不可达时回退 127.0.0.1（TASK-22：Windows 上 localhost 优先 ::1 脑裂）", () => {
  it("服务仅监听 127.0.0.1 时，localhost 探测仍判可达（HTTP 与 TCP）", async () => {
    const { defaultCheckHttp, defaultCheckTcp } = await import("../src/doctor.js");
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await defaultCheckHttp(`http://localhost:${port}/`, 3000)).toBe(true);
      expect(await defaultCheckTcp("localhost", port, 3000)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("TASK-30: 隔离检查（OS 级只读工具链）", () => {
  it("未启用 isolation → 检查通过且提示可选", async () => {
    const report = await runDoctor(baseDeps());
    const check = report.checks.find((c) => c.name === "隔离");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
    expect(check!.detail).toContain("未启用");
  });

  it("isolation=true 且工具链可用（icacls/chmod exit 0）→ ✓", async () => {
    writeFileSync(join(workDir, "config.json"), JSON.stringify({ ...CONFIG, isolation: true }));
    const report = await runDoctor(baseDeps());
    const check = report.checks.find((c) => c.name === "隔离");
    expect(check!.ok).toBe(true);
  });

  it("isolation=true 但工具链不可用 → ✗ 且体检不通过", async () => {
    writeFileSync(join(workDir, "config.json"), JSON.stringify({ ...CONFIG, isolation: true }));
    const report = await runDoctor(
      baseDeps({
        runner: async (bin, args) => {
          if (bin === "icacls" || bin === "chmod") return { exitCode: 1, stdout: "", stderr: "不是内部命令" };
          if (args.includes("--version")) return { exitCode: 0, stdout: `${bin} 1.0.0`, stderr: "" };
          if (args.includes("list")) return { exitCode: 0, stdout: "agentbus: http://...", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    );
    const check = report.checks.find((c) => c.name === "隔离");
    expect(check!.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe("TASK-32: 身份冲突检查（daemon.log 高频重连指纹）", () => {
  it("无日志/低频重连 → 检查通过", async () => {
    const report = await runDoctor(baseDeps());
    const check = report.checks.find((c) => c.name === "身份冲突");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
  });

  it("日志高频重连（≥6 次 reconnecting）→ 失败并提示 client_id 碰撞修复步骤", async () => {
    mkdirSync(join(workDir, "logs"), { recursive: true });
    const lines = Array.from({ length: 8 }, (_, i) =>
      `2026-08-11T10:00:0${i}.000Z [INFO] MQTT reconnecting`,
    ).join("\n");
    writeFileSync(join(workDir, "logs", "daemon.log"), `${lines}\n`, "utf-8");
    const report = await runDoctor(baseDeps());
    const check = report.checks.find((c) => c.name === "身份冲突");
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/client_id/);
    expect(check!.detail).toMatch(/init/);
    expect(report.ok).toBe(false);
  });

  it("日志出现 identity_conflict → 直接失败", async () => {
    mkdirSync(join(workDir, "logs"), { recursive: true });
    writeFileSync(
      join(workDir, "logs", "daemon.log"),
      `2026-08-11T10:00:00.000Z [ERROR] MQTT identity_conflict: 60s 内 3 次非主动断连\n`,
      "utf-8",
    );
    const report = await runDoctor(baseDeps());
    const check = report.checks.find((c) => c.name === "身份冲突");
    expect(check!.ok).toBe(false);
  });
});
