/**
 * TASK-12: MCP 注册器（架构 6.3 / 6.5-C/D 七红线）
 *
 * 红线 1 Claude 与 Qoder 共用 .mcp.json —— 必须合并，严禁整文件覆盖
 * 红线 2 claude/qodercli -s 默认 local —— project/global 必须落到明确的文件路径
 * 红线 3 kilo mcp add 实测写全局 —— Kilo 项目级必须直写 .kilo/kilo.json，不用 CLI
 * 红线 4 键名/传输字段差异 —— mcpServers+sse vs mcp+remote，不可混用
 * 红线 5 文件必须 UTF-8 无 BOM（kilo 遇 BOM 静默跳过）
 * 红线 6 Codex 仅全局 —— project 请求必须回退并明确告知
 * 红线 7 回写验证 —— 写后必须读回确认注册成功
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MCP_NAME,
  planMcpRegistration,
  registerMcpFile,
  upsertMcpJson,
  verifyMcpFile,
} from "../src/mcp-registry.js";

const SSE_URL = "http://localhost:8000/sse?client_id=demo&ns=default";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentbus-reg-"));
  home = mkdtempSync(join(tmpdir(), "agentbus-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("planMcpRegistration scope 映射（红线 2/3/4/6）", () => {
  it("claude project → 直写项目根 .mcp.json（mcpServers + sse）", () => {
    const plan = planMcpRegistration("claude", "project", SSE_URL, root, home);
    expect(plan.method).toBe("file");
    expect(plan.path).toBe(join(root, ".mcp.json"));
    expect(plan.sectionKey).toBe("mcpServers");
    expect(plan.entry).toEqual({ type: "sse", url: SSE_URL });
  });

  it("红线 2：claude/qoder 的 project 与 global 落到明确区分的文件路径，绝无隐式 local", () => {
    const cp = planMcpRegistration("claude", "project", SSE_URL, root, home);
    const cg = planMcpRegistration("claude", "global", SSE_URL, root, home);
    expect(cg.method).toBe("file");
    expect(cg.path).toBe(join(home, ".claude.json"));
    expect(cp.path).not.toBe(cg.path);

    const qg = planMcpRegistration("qoder", "global", SSE_URL, root, home);
    expect(qg.path).toBe(join(home, ".qoder", "mcp.json"));
  });

  it("红线 3：kilo project 必须直写 .kilo/kilo.json，method 为 file（不用 CLI）", () => {
    const plan = planMcpRegistration("kilo", "project", SSE_URL, root, home);
    expect(plan.method).toBe("file");
    expect(plan.path).toBe(join(root, ".kilo", "kilo.json"));
  });

  it("kilo global 走 CLI（实测 CLI 写全局 ~/.config/kilo/kilo.jsonc）", () => {
    const plan = planMcpRegistration("kilo", "global", SSE_URL, root, home);
    expect(plan.method).toBe("cli");
    expect(plan.binary).toBe("kilo");
    expect(plan.cliArgs).toEqual(["mcp", "add", MCP_NAME, "--url", SSE_URL]);
  });

  it("红线 4：opencode 用 mcp 键 + type=remote，与 claude/qoder 的 mcpServers+sse 不混用", () => {
    const plan = planMcpRegistration("opencode", "project", SSE_URL, root, home);
    expect(plan.method).toBe("file");
    expect(plan.path).toBe(join(root, "opencode.json"));
    expect(plan.sectionKey).toBe("mcp");
    expect(plan.entry).toEqual({ type: "remote", url: SSE_URL });

    const global = planMcpRegistration("opencode", "global", SSE_URL, root, home);
    expect(global.path).toBe(join(home, ".config", "opencode", "opencode.json"));
  });

  it("红线 6：codex 不支持 project，回退 global CLI 并给出明确警告", () => {
    const plan = planMcpRegistration("codex", "project", SSE_URL, root, home);
    expect(plan.method).toBe("cli");
    expect(plan.scope).toBe("global");
    expect(plan.binary).toBe("codex");
    expect(plan.cliArgs).toEqual(["mcp", "add", MCP_NAME, "--url", SSE_URL]);
    expect(plan.warnings.join(" ")).toContain("全局");
  });

  it("hermes 注册方式待实测 → skip 且带警告", () => {
    const plan = planMcpRegistration("hermes", "project", SSE_URL, root, home);
    expect(plan.method).toBe("skip");
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

describe("upsertMcpJson 合并语义（红线 1）", () => {
  it("无文件时生成最小结构", () => {
    const out = JSON.parse(upsertMcpJson(undefined, "mcpServers", MCP_NAME, { type: "sse", url: SSE_URL }));
    expect(out).toEqual({ mcpServers: { agentbus: { type: "sse", url: SSE_URL } } });
  });

  it("红线 1：合并保留已有服务器与其他顶层键，严禁整文件覆盖", () => {
    const existing = JSON.stringify({
      topLevel: "keep-me",
      mcpServers: { other: { type: "stdio", command: "x" } },
    });
    const out = JSON.parse(upsertMcpJson(existing, "mcpServers", MCP_NAME, { type: "sse", url: SSE_URL }));
    expect(out.topLevel).toBe("keep-me");
    expect(out.mcpServers.other).toEqual({ type: "stdio", command: "x" });
    expect(out.mcpServers[MCP_NAME].url).toBe(SSE_URL);
  });

  it("红线 5：已有内容带 BOM 时先剥离再解析，输出不带 BOM", () => {
    const withBom = `\uFEFF${JSON.stringify({ mcp: {} })}`;
    const out = upsertMcpJson(withBom, "mcp", MCP_NAME, { type: "remote", url: SSE_URL });
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(out).mcp[MCP_NAME].type).toBe("remote");
  });

  it("已有文件不是合法 JSON 时抛错（不覆盖用户数据）", () => {
    expect(() => upsertMcpJson("{broken", "mcp", MCP_NAME, {})).toThrow(/JSON/);
  });
});

describe("registerMcpFile 写盘与回写验证（红线 5/7）", () => {
  it("红线 5：写出的文件 UTF-8 无 BOM；红线 7：写后读回验证通过", () => {
    const plan = planMcpRegistration("kilo", "project", SSE_URL, root, home);
    const result = registerMcpFile(plan);
    expect(result.written).toBe(true);
    expect(result.verified).toBe(true);
    const bytes = readFileSync(plan.path!);
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it("目标目录不存在时自动创建（.kilo/ 等）", () => {
    const plan = planMcpRegistration("kilo", "project", SSE_URL, root, home);
    expect(existsSync(join(root, ".kilo"))).toBe(false);
    registerMcpFile(plan);
    expect(existsSync(plan.path!)).toBe(true);
  });

  it("重复注册幂等：二次注册不破坏已有内容", () => {
    const plan = planMcpRegistration("claude", "project", SSE_URL, root, home);
    writeFileSync(plan.path!, JSON.stringify({ mcpServers: { keep: { type: "stdio" } } }));
    registerMcpFile(plan);
    registerMcpFile(plan);
    const parsed = JSON.parse(readFileSync(plan.path!, "utf-8"));
    expect(parsed.mcpServers.keep).toBeDefined();
    expect(parsed.mcpServers[MCP_NAME].url).toBe(SSE_URL);
  });

  it("红线 7：verifyMcpFile 在键缺失时返回 false", () => {
    const path = join(root, ".mcp.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));
    expect(verifyMcpFile(path, "mcpServers", MCP_NAME)).toBe(false);
    expect(verifyMcpFile(join(root, "not-exist.json"), "mcpServers", MCP_NAME)).toBe(false);
  });
});
