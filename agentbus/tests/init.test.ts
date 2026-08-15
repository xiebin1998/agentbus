/**
 * TASK-12: init 编排（架构 6.2 五步流程）
 * 步骤 1 交互/默认确认 → 步骤 2 探测 CLI → 步骤 3 写配置与契约
 * → 步骤 4 注册 MCP → 步骤 5 拉起 daemon
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInitConfig, runInit, type InitReport } from "../src/init.js";
import { loadSkillTemplate } from "../src/skill.js";
import { AGENTBUS_BEGIN } from "../src/agents-md.js";

let root: string;
let home: string;

function fakeDeps(overrides: Record<string, { exitCode?: number }> = {}) {
  const runner = async (bin: string, args: string[]) => {
    if (args.includes("--version")) {
      const o = overrides[bin];
      return { exitCode: o?.exitCode ?? 0, stdout: `${bin} 1.0.0`, stderr: "" };
    }
    calls.push({ bin, args });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const spawnDaemon = (cmd: string, args: string[]) => {
    spawns.push({ cmd, args });
  };
  return { runner, calls, spawns, spawnDaemon };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentbus-init-"));
  home = mkdtempSync(join(tmpdir(), "agentbus-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("buildInitConfig 默认值生成", () => {
  it("client_id 默认随机 ag-8hex（TASK-32）；ns 默认 default；broker 默认 localhost:18830", () => {
    const raw = buildInitConfig({ tools: ["qoder"] }, root);
    expect(raw.client_id).toMatch(/^ag-[0-9a-f]{8}$/);
    expect(raw.ns).toBe("default");
    expect(raw.broker).toMatchObject({ host: "localhost", port: 18830 });
  });

  it("sse_url 按 hub 主机派生：broker host → http://<host>:8000/sse?client_id=..&ns=..", () => {
    const raw = buildInitConfig({ tools: ["qoder"], broker: "10.1.5.100:18830" }, root);
    expect(raw.broker).toMatchObject({ host: "10.1.5.100", port: 18830 });
    expect(raw.sse_url).toBe(
      `http://10.1.5.100:8000/sse?client_id=${raw.client_id}&ns=${raw.ns}`,
    );
  });

  it("显式 sse_url 优先于派生值", () => {
    const raw = buildInitConfig({ tools: ["qoder"], sseUrl: "http://h:9/sse" }, root);
    expect(raw.sse_url).toBe("http://h:9/sse");
  });

  it("default_tool 取第一个工具；tools 键按勾选工具生成", () => {
    const raw = buildInitConfig({ tools: ["kilo", "qoder"] }, root);
    expect(raw.default_tool).toBe("kilo");
    expect(Object.keys(raw.tools).sort()).toEqual(["kilo", "qoder"]);
  });

  it("空工具列表与非法 broker 串抛错", () => {
    expect(() => buildInitConfig({ tools: [] }, root)).toThrow(/工具/);
    expect(() => buildInitConfig({ tools: ["qoder"], broker: "nohost" }, root)).toThrow(/broker/);
  });

  it("四期：--user/--password 写入 broker.username/password；不传则无凭证字段", () => {
    const withCred = buildInitConfig({ tools: ["qoder"], user: "bob", password: "s3cret" }, root);
    expect(withCred.broker).toMatchObject({ username: "bob", password: "s3cret" });
    const noCred = buildInitConfig({ tools: ["qoder"] }, root);
    expect(noCred.broker).not.toHaveProperty("username");
    expect(noCred.broker).not.toHaveProperty("password");
  });
});

describe("runInit --yes 全链路（非交互）", () => {
  it("--yes 未指定 tools：自动探测可接入工具（TASK-28 一键安装契约）", async () => {
    // 仅 qodercli 与 opencode 已安装，其余未安装
    const deps = fakeDeps({
      kilo: { exitCode: 1 },
      claude: { exitCode: 1 },
      codex: { exitCode: 1 },
      hermes: { exitCode: 1 },
    });
    const report = await runInit(
      { yes: true },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    expect(report.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(Object.keys(cfg.tools).sort()).toEqual(["opencode", "qoder"]);
    expect(cfg.default_tool).toBe("qoder");
  });

  it("--yes 自动探测全部未安装：失败且不写配置", async () => {
    const deps = fakeDeps({
      qodercli: { exitCode: 1 },
      kilo: { exitCode: 1 },
      opencode: { exitCode: 1 },
      claude: { exitCode: 1 },
      codex: { exitCode: 1 },
      hermes: { exitCode: 1 },
    });
    const report = await runInit(
      { yes: true },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/未安装|未探测到/);
    expect(existsSync(join(root, ".agentbus", "config.json"))).toBe(false);
  });

  async function init(overrides: Record<string, { exitCode?: number }> = {}) {
    const deps = fakeDeps(overrides);
    const report = await runInit(
      { yes: true, tools: ["qoder", "kilo"], scope: "project" },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    return { report, deps };
  }

  it("步骤 3：写 .agentbus/config.json 与目录骨架（logs/inbox）", async () => {
    await init();
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(cfg.default_tool).toBe("qoder");
    expect(existsSync(join(root, ".agentbus", "logs"))).toBe(true);
    expect(existsSync(join(root, ".agentbus", "inbox"))).toBe(true);
  });

  it("步骤 3：为每个支持 skill 的工具安装 SKILL.md", async () => {
    await init();
    expect(readFileSync(join(root, ".qoder", "skills", "agentbus", "SKILL.md"), "utf-8")).toBe(loadSkillTemplate());
    expect(readFileSync(join(root, ".kilo", "skills", "agentbus", "SKILL.md"), "utf-8")).toBe(loadSkillTemplate());
  });

  it("步骤 4：project scope 注册写入 .qoder/settings.json 与 .kilo/kilo.jsonc", async () => {
    await init();
    const qoderMcp = JSON.parse(readFileSync(join(root, ".qoder", "settings.json"), "utf-8"));
    expect(qoderMcp.mcpServers.agentbus.type).toBe("stdio");
    const kiloJson = JSON.parse(readFileSync(join(root, ".kilo", "kilo.jsonc"), "utf-8"));
    expect(kiloJson.mcp.agentbus.type).toBe("stdio");
  });

  it("步骤 5：拉起 daemon（detached spawn daemon start）", async () => {
    const { deps } = await init();
    expect(deps.spawns.length).toBe(1);
    expect(deps.spawns[0].args.join(" ")).toContain("daemon start");
  });

  it("四期：--user/--password 写入 config.json 并保障 .agentbus/ 入 .gitignore（幂等）", async () => {
    const deps = fakeDeps();
    const report = await runInit(
      { yes: true, tools: ["qoder"], scope: "project", user: "bob", password: "s3cret" },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    expect(report.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(cfg.broker).toMatchObject({ username: "bob", password: "s3cret" });
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toContain(".agentbus/");
    // 幂等：重跑不重复追加
    await runInit(
      { yes: true, tools: ["qoder"], scope: "project", user: "bob", password: "s3cret" },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    const gi = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(gi.split("\n").filter((l) => l.trim() === ".agentbus/").length).toBe(1);
    expect(gi.split("\n").filter((l) => l.trim() === ".agentbus/agents.json").length).toBe(1);
  });

  it("TASK-32：不传凭证时仍无条件托管 .gitignore 双条目（agents.json 快照勿提交）", async () => {
    await init();
    const gi = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(gi).toContain(".agentbus/");
    expect(gi).toContain(".agentbus/agents.json");
  });

  it("报告包含各步骤结果且 exitCode 为 0", async () => {
    const { report } = await init();
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("config.json");
  });

  it("步骤 2：所选工具全部未安装时失败并提示（不带病推进）", async () => {
    const deps = fakeDeps({ qodercli: { exitCode: 127 }, kilo: { exitCode: 127 } });
    const report = await runInit(
      { yes: true, tools: ["qoder", "kilo"], scope: "project" },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("未安装");
    expect(existsSync(join(root, ".agentbus", "config.json"))).toBe(false);
  });

  it("codex 回退全局 CLI 注册被真实执行且警告进入报告", async () => {
    const deps = fakeDeps();
    const report = await runInit(
      { yes: true, tools: ["codex"], scope: "project" },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    expect(report.ok).toBe(true);
    expect(deps.calls.some((c) => c.bin === "codex" && c.args.join(" ").startsWith("mcp add"))).toBe(true);
    expect(report.lines.join("\n")).toContain("全局");
  });

  it("hermes 无 skill 目录 → 写 AGENTS.md 托管块兜底", async () => {
    const deps = fakeDeps();
    await runInit(
      { yes: true, tools: ["hermes"], scope: "project" },
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon },
    );
    const md = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(md).toContain(AGENTBUS_BEGIN);
  });

  it("重复 init 幂等：config 已存在时覆盖更新且不破坏 .qoder/settings.json 其他键", async () => {
    await init();
    writeFileSync(join(root, ".qoder", "settings.json"), JSON.stringify({ mcpServers: { keep: { type: "stdio" } } }));
    await init();
    const parsed = JSON.parse(readFileSync(join(root, ".qoder", "settings.json"), "utf-8"));
    expect(parsed.mcpServers.keep).toBeDefined();
    expect(parsed.mcpServers.agentbus).toBeDefined();
  });

  it("cli 型注册幂等：add 前先行 remove（重复注册不报错，TASK-22 回归发现）", async () => {
    // 模拟 codex 真实行为：已注册时 mcp add 返回非零；remove 后才可 add 成功
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner = async (bin: string, args: string[]) => {
      if (args.includes("--version")) return { exitCode: 0, stdout: `${bin} 1.0.0`, stderr: "" };
      calls.push({ bin, args });
      if (args[0] === "mcp" && args[1] === "remove") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "mcp" && args[1] === "add") {
        const removed = calls.some((c) => c.args[0] === "mcp" && c.args[1] === "remove");
        return { exitCode: removed ? 0 : 1, stdout: "", stderr: removed ? "" : "already exists" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const report = await runInit(
      { yes: true, tools: ["codex"], scope: "project" },
      { projectRoot: root, homeDir: home, runner, spawnDaemon: () => {} },
    );
    expect(report.ok).toBe(true);
    const mcpCalls = calls.filter((c) => c.args[0] === "mcp").map((c) => c.args[1]);
    expect(mcpCalls).toEqual(["remove", "add"]);
  });
});

describe("runInit 交互路径", () => {
  it("非 --yes 时调用注入的 prompter 收集答案", async () => {
    const deps = fakeDeps();
    const answers = {
      ns: "iot",
      clientId: "demo",
      tools: ["qoder"],
      scope: "project" as const,
      broker: "localhost:18830",
      sseUrl: "",
      agentName: "demo-agent",
      agentDescription: "",
    };
    const prompted: string[] = [];
    const prompter = async (q: string, def?: unknown) => {
      prompted.push(q);
      void def;
      return answers[q as keyof typeof answers] ?? "";
    };
    const report = await runInit(
      {},
      { projectRoot: root, homeDir: home, runner: deps.runner, spawnDaemon: deps.spawnDaemon, prompter },
    );
    expect(report.ok).toBe(true);
    expect(prompted.length).toBeGreaterThanOrEqual(5);
    const cfg = JSON.parse(readFileSync(join(root, ".agentbus", "config.json"), "utf-8"));
    expect(cfg.ns).toBe("iot");
    expect(cfg.client_id).toBe("demo");
  });
});
