/**
 * TASK-14: uninstall 全链路（架构 6.1 / 6.5-D 红线 1：只删 agentbus 键）
 * 停 daemon → 移除 MCP 注册（file 型删键 / cli 型 mcp remove）→ 删 skill/托管块 → 清 .agentbus/
 * DoD：卸载后 doctor 零残留（config 不存在即"未初始化"）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planMcpUninstall, removeMcpJsonEntry } from "../src/mcp-registry.js";
import { runUninstall } from "../src/uninstall.js";
import { loadSkillTemplate } from "../src/skill.js";
import { AGENTBUS_BEGIN, AGENTBUS_END } from "../src/agents-md.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentbus-uninstall-"));
  home = mkdtempSync(join(tmpdir(), "agentbus-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---------- removeMcpJsonEntry（纯函数）----------

describe("removeMcpJsonEntry", () => {
  it("只删 agentbus 键：同级其他条目与其他 section 保留", () => {
    const src = JSON.stringify({
      mcpServers: { agentbus: { type: "sse" }, other: { type: "sse" } },
      unrelated: 1,
    });
    const out = removeMcpJsonEntry(src, "mcpServers", "agentbus");
    expect(out).not.toBeNull();
    const doc = JSON.parse(out!);
    expect(doc.mcpServers).toEqual({ other: { type: "sse" } });
    expect(doc.unrelated).toBe(1);
  });

  it("键不存在 → 返回 null（调用方判定无需改动）", () => {
    const src = JSON.stringify({ mcpServers: { other: {} } });
    expect(removeMcpJsonEntry(src, "mcpServers", "agentbus")).toBeNull();
  });

  it("空/undefined 内容 → null", () => {
    expect(removeMcpJsonEntry(undefined, "mcp", "agentbus")).toBeNull();
    expect(removeMcpJsonEntry("", "mcp", "agentbus")).toBeNull();
  });

  it("section 删空后整个 section 一并移除", () => {
    const src = JSON.stringify({ mcp: { agentbus: { type: "remote" } } });
    const doc = JSON.parse(removeMcpJsonEntry(src, "mcp", "agentbus")!);
    expect("mcp" in doc).toBe(false);
  });

  it("非法 JSON 抛错（绝不静默覆盖用户数据）", () => {
    expect(() => removeMcpJsonEntry("{oops", "mcp", "agentbus")).toThrow(/合法 JSON/);
  });

  it("BOM 输入正常处理", () => {
    const src = `\uFEFF${JSON.stringify({ mcpServers: { agentbus: {} } })}`;
    const doc = JSON.parse(removeMcpJsonEntry(src, "mcpServers", "agentbus")!);
    expect("mcpServers" in doc).toBe(false);
  });
});

// ---------- planMcpUninstall ----------

describe("planMcpUninstall", () => {
  it("claude/qoder：项目 .mcp.json + 全局文件，section 均 mcpServers", () => {
    const c = planMcpUninstall("claude", root, home);
    expect(c.files).toEqual([
      { path: join(root, ".mcp.json"), sectionKey: "mcpServers" },
      { path: join(home, ".claude.json"), sectionKey: "mcpServers" },
    ]);
    const q = planMcpUninstall("qoder", root, home);
    expect(q.files[1].path).toBe(join(home, ".qoder", "mcp.json"));
  });

  it("kilo：项目直写文件 + CLI 全局兜底", () => {
    const k = planMcpUninstall("kilo", root, home);
    expect(k.files).toEqual([{ path: join(root, ".kilo", "kilo.json"), sectionKey: "mcp" }]);
    expect(k.cliBinary).toBe("kilo");
  });

  it("opencode：项目 + 全局文件，section mcp", () => {
    const o = planMcpUninstall("opencode", root, home);
    expect(o.files.map((f) => f.path)).toEqual([
      join(root, "opencode.json"),
      join(home, ".config", "opencode", "opencode.json"),
    ]);
  });

  it("codex：仅 CLI（agentbus 不手写 config.toml）", () => {
    const c = planMcpUninstall("codex", root, home);
    expect(c.files).toEqual([]);
    expect(c.cliBinary).toBe("codex");
  });

  it("hermes：无文件无 CLI", () => {
    expect(planMcpUninstall("hermes", root, home)).toEqual({ files: [], cliBinary: undefined });
  });
});

// ---------- runUninstall 编排 ----------

/** 预置一个 init 完成态项目（qoder + kilo + hermes 组合）；daemon pid 用当前进程保证存活探测为真 */
function seedInitProject(daemonPid = process.pid) {
  mkdirSync(join(root, ".agentbus", "logs"), { recursive: true });
  writeFileSync(
    join(root, ".agentbus", "config.json"),
    JSON.stringify({
      client_id: "demo",
      ns: "default",
      broker: { host: "localhost", port: 18830 },
      sse_url: "http://localhost:8000/sse?client_id=demo&ns=default",
      default_tool: "qoder",
      allowed_senders: [],
      tools: { qoder: {}, kilo: {}, hermes: {} },
      ack: true,
    }),
    "utf-8",
  );
  writeFileSync(join(root, ".agentbus", "daemon.pid"), String(daemonPid), "utf-8");
  // MCP 注册（红线 1 场景：.mcp.json 有其他条目）
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { agentbus: { type: "sse", url: "u" }, keepme: { type: "sse" } } }),
    "utf-8",
  );
  mkdirSync(join(root, ".kilo"), { recursive: true });
  writeFileSync(join(root, ".kilo", "kilo.json"), JSON.stringify({ mcp: { agentbus: { type: "remote" } } }), "utf-8");
  // skill
  mkdirSync(join(root, ".qoder", "skills", "agentbus"), { recursive: true });
  writeFileSync(join(root, ".qoder", "skills", "agentbus", "SKILL.md"), loadSkillTemplate(), "utf-8");
  mkdirSync(join(root, ".kilocode", "skills", "agentbus"), { recursive: true });
  writeFileSync(join(root, ".kilocode", "skills", "agentbus", "SKILL.md"), loadSkillTemplate(), "utf-8");
  // AGENTS.md：托管块 + 用户内容
  writeFileSync(
    join(root, "AGENTS.md"),
    `# 项目约定\n\n${AGENTBUS_BEGIN}\n块正文\n${AGENTBUS_END}\n\n## 用户自己的段落\n`,
    "utf-8",
  );
}

describe("runUninstall", () => {
  it("全链路：停 daemon → 删 MCP 键（保留其他条目）→ 删 skill/托管块 → 清 .agentbus", async () => {
    seedInitProject();
    const stopped: number[] = [];
    const calls: Array<{ bin: string; args: string[] }> = [];
    const report = await runUninstall({
      projectRoot: root,
      homeDir: home,
      stopDaemon: (pid) => {
        stopped.push(pid);
        return true;
      },
      runner: async (bin, args) => {
        calls.push({ bin, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(report.ok).toBe(true);
    expect(stopped).toEqual([process.pid]);
    // 红线 1：只删 agentbus 键
    const mcpDoc = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"));
    expect(mcpDoc.mcpServers).toEqual({ keepme: { type: "sse" } });
    // kilo.json section 删空后文件仅剩 {}（或整 section 移除）
    const kiloDoc = JSON.parse(readFileSync(join(root, ".kilo", "kilo.json"), "utf-8"));
    expect(kiloDoc.mcp).toBeUndefined();
    // kilo 全局兜底走 CLI remove
    expect(calls.some((c) => c.bin === "kilo" && c.args.join(" ") === "mcp remove agentbus")).toBe(true);
    // skill 与托管块移除，用户内容保留
    expect(existsSync(join(root, ".qoder", "skills", "agentbus", "SKILL.md"))).toBe(false);
    const md = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(md).not.toContain(AGENTBUS_BEGIN);
    expect(md).toContain("用户自己的段落");
    // .agentbus 整体移除（doctor 零残留的前提）
    expect(existsSync(join(root, ".agentbus"))).toBe(false);
  });

  it("未初始化项目：ok=true 提示无需卸载，不做破坏性操作", async () => {
    writeFileSync(join(root, "AGENTS.md"), "# 用户文档\n", "utf-8");
    const report = await runUninstall({ projectRoot: root, homeDir: home });
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("未初始化");
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe("# 用户文档\n");
  });

  it("幂等：连续两次 uninstall 均 ok", async () => {
    seedInitProject();
    const deps = {
      projectRoot: root,
      homeDir: home,
      stopDaemon: () => true,
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    expect((await runUninstall(deps)).ok).toBe(true);
    const second = await runUninstall(deps);
    expect(second.ok).toBe(true);
  });

  it("CLI 移除失败仅告警不阻塞（尽力而为）", async () => {
    seedInitProject();
    const report = await runUninstall({
      projectRoot: root,
      homeDir: home,
      stopDaemon: () => true,
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    });
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("⚠");
  });

  it(".mcp.json 非法 JSON → 报失败且不覆盖文件", async () => {
    seedInitProject();
    writeFileSync(join(root, ".mcp.json"), "{broken", "utf-8");
    const report = await runUninstall({
      projectRoot: root,
      homeDir: home,
      stopDaemon: () => true,
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(report.ok).toBe(false);
    expect(readFileSync(join(root, ".mcp.json"), "utf-8")).toBe("{broken");
    expect(report.lines.join("\n")).toContain("✗");
  });

  it("daemon 未在运行（无 pid）不报错，跳过停止步骤", async () => {
    seedInitProject();
    rmSync(join(root, ".agentbus", "daemon.pid"));
    const stopped: number[] = [];
    const report = await runUninstall({
      projectRoot: root,
      homeDir: home,
      stopDaemon: (pid: number) => (stopped.push(pid), true),
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(report.ok).toBe(true);
    expect(stopped).toEqual([]);
  });

  it.runIf(process.platform === "win32")("停 daemon 后按 serve_port 定向回收孤儿 serve（TASK-27：Windows SIGTERM 为强杀）", async () => {
    seedInitProject();
    const cfgPath = join(root, ".agentbus", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    cfg.tools.opencode = { serve: true, serve_port: 4599 };
    writeFileSync(cfgPath, JSON.stringify(cfg), "utf-8");
    const ports: number[] = [];
    const report = await runUninstall({
      projectRoot: root,
      homeDir: home,
      stopDaemon: () => true,
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      killServePort: (p) => ports.push(p),
    });
    expect(report.ok).toBe(true);
    expect(ports).toEqual([4599]);
  });
});
