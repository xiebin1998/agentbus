/**
 * TASK-12: MCP 注册器（架构 6.3 scope 映射表 / 6.5-C 配置路径 / 6.5-D 七红线）
 *
 * 红线 1 Claude 与 Qoder 项目级各自独立（claude 用 .mcp.json，qoder 用 .qoder/mcp.json）—— 不再共用
 * 红线 2 claude/qodercli -s 默认 local —— scope 必须显式落到明确文件路径，绝不允许隐式 local
 * 红线 3 kilo mcp add 实测写全局 —— Kilo 项目级必须直写 .kilo/kilo.json，不得使用 CLI
 * 红线 4 键名/传输字段差异 —— Claude/Qoder 用 mcpServers+"stdio"；Kilo/OpenCode 用 mcp+"stdio"
 * 红线 5 文件必须 UTF-8 无 BOM（kilo 遇 BOM 报 ConfigJsonError 静默跳过）
 * 红线 6 Codex 仅全局 —— project 请求回退 global（CLI 注册），并明确告知用户
 * 红线 7 回写验证 —— 写后读回确认注册成功（doctor 亦复用 verifyMcpFile）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** MCP 服务器注册名（全工具统一） */
export const MCP_NAME = "agentbus";

export type McpScope = "project" | "global";
export type McpMethod = "file" | "cli" | "skip";

export interface McpPlan {
  tool: string;
  /** 用户请求的 scope */
  requestedScope: McpScope;
  /** 生效 scope（codex 会回退为 global） */
  scope: McpScope;
  /** file=agentbus 直写文件；cli=调用目标工具 CLI；skip=待实测跳过 */
  method: McpMethod;
  binary?: string;
  cliArgs?: string[];
  path?: string;
  sectionKey?: "mcpServers" | "mcp";
  entry?: Record<string, unknown>;
  warnings: string[];
}

const stdioEntry = () => ({
  type: "stdio",
  command: "agentbus",
  args: ["mcp", "--stdio"],
});
const cliAddArgs = () => ["mcp", "add", MCP_NAME, "--stdio"];

/** 按工具与 scope 生成注册计划（纯函数，不做任何磁盘/进程操作） */
export function planMcpRegistration(
  tool: string,
  requestedScope: McpScope,
  sseUrl: string,
  projectRoot: string,
  homeDir: string,
): McpPlan {
  const warnings: string[] = [];

  switch (tool) {
    case "claude": {
      // 红线 2：project/global 都显式落到明确文件，绝不走 CLI 默认的 local scope
      const path =
        requestedScope === "project"
          ? join(projectRoot, ".mcp.json")
          : join(homeDir, ".claude.json");
      // 红线 4：mcpServers + stdio
      return {
        tool,
        requestedScope,
        scope: requestedScope,
        method: "file",
        path,
        sectionKey: "mcpServers",
        entry: stdioEntry(),
        warnings,
      };
    }
    case "qoder": {
      // qoder 项目级写到 <projectRoot>/.qoder/mcp.json（与 claude 的 .mcp.json 分开）
      const path =
        requestedScope === "project"
          ? join(projectRoot, ".qoder", "mcp.json")
          : join(homeDir, ".qoder", "mcp.json");
      return {
        tool,
        requestedScope,
        scope: requestedScope,
        method: "file",
        path,
        sectionKey: "mcpServers",
        entry: stdioEntry(),
        warnings,
      };
    }
    case "kilo": {
      if (requestedScope === "project") {
        // 红线 3：kilo CLI 无 project scope（实测 --url 写全局），项目级必须直写文件
        return {
          tool,
          requestedScope,
          scope: "project",
          method: "file",
          path: join(projectRoot, ".kilo", "kilo.json"),
          sectionKey: "mcp",
          entry: stdioEntry(),
          warnings,
        };
      }
      return {
        tool,
        requestedScope,
        scope: "global",
        method: "cli",
        binary: "kilo",
        cliArgs: cliAddArgs(),
        warnings,
      };
    }
    case "opencode": {
      const path =
        requestedScope === "project"
          ? join(projectRoot, "opencode.json")
          : join(homeDir, ".config", "opencode", "opencode.json");
      return {
        tool,
        requestedScope,
        scope: requestedScope,
        method: "file",
        path,
        sectionKey: "mcp",
        entry: stdioEntry(),
        warnings,
      };
    }
    case "codex": {
      // 红线 6：Codex 不支持 project scope；回退全局并明确告知（agentbus 不手写 config.toml）
      if (requestedScope === "project") {
        warnings.push("Codex 不支持 project scope，已回退全局注册（~/.codex/config.toml，影响所有项目）");
      }
      return {
        tool,
        requestedScope,
        scope: "global",
        method: "cli",
        binary: "codex",
        cliArgs: cliAddArgs(),
        warnings,
      };
    }
    case "hermes":
      warnings.push("hermes MCP 注册语法待实测（架构 5.5-B/6.3），本次跳过注册，请手动接入");
      return { tool, requestedScope, scope: requestedScope, method: "skip", warnings };
    default:
      throw new Error(`未知工具 ${tool}（可选：claude/qoder/kilo/opencode/codex/hermes）`);
  }
}

/**
 * 合并生成新文件内容（纯函数）。红线 1：保留已有顶层键与同级其他条目；
 * 红线 5：剥离输入 BOM，输出必无 BOM。非法 JSON 抛错（绝不覆盖用户数据）。
 */
export function upsertMcpJson(
  existingContent: string | undefined,
  sectionKey: string,
  name: string,
  entry: Record<string, unknown>,
): string {
  let doc: Record<string, unknown>;
  if (existingContent === undefined || existingContent.replace(/^\uFEFF/, "").trim() === "") {
    doc = {};
  } else {
    const stripped = existingContent.replace(/^\uFEFF/, "");
    try {
      doc = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      throw new Error("目标文件不是合法 JSON，为避免覆盖用户数据已中止写入");
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error("目标文件顶层必须是 JSON 对象");
    }
  }
  const section =
    doc[sectionKey] && typeof doc[sectionKey] === "object" && !Array.isArray(doc[sectionKey])
      ? (doc[sectionKey] as Record<string, unknown>)
      : {};
  section[name] = entry;
  doc[sectionKey] = section;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 红线 7：读回文件确认指定 section 下存在该注册键 */
export function verifyMcpFile(path: string, sectionKey: string, name: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const section = doc[sectionKey];
    return !!section && typeof section === "object" && name in (section as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** 按 file 型计划执行写盘（合并 + UTF-8 无 BOM + 回写验证） */
export function registerMcpFile(plan: McpPlan): { written: boolean; verified: boolean } {
  if (plan.method !== "file" || !plan.path || !plan.sectionKey || !plan.entry) {
    throw new Error(`registerMcpFile 仅支持 file 型计划（工具 ${plan.tool} 为 ${plan.method}）`);
  }
  const existing = existsSync(plan.path) ? readFileSync(plan.path, "utf-8") : undefined;
  const content = upsertMcpJson(existing, plan.sectionKey, MCP_NAME, plan.entry);
  mkdirSync(dirname(plan.path), { recursive: true });
  // 红线 5：writeFileSync utf-8 不添加 BOM
  writeFileSync(plan.path, content, "utf-8");
  return { written: true, verified: verifyMcpFile(plan.path, plan.sectionKey, MCP_NAME) };
}

// ─── TASK-14: 卸载侧（红线 1：uninstall 只删 agentbus 这一个键）────────────────

/**
 * 从 JSON 内容中移除指定 section 下的注册键（纯函数）。
 * 返回新内容；键不存在/内容为空 → null（调用方判定无需改动）。
 * section 删空后整个 section 一并移除；非法 JSON 抛错（绝不静默覆盖用户数据）。
 */
export function removeMcpJsonEntry(
  existingContent: string | undefined,
  sectionKey: string,
  name: string,
): string | null {
  if (existingContent === undefined || existingContent.replace(/^\uFEFF/, "").trim() === "") {
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(existingContent.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    throw new Error("目标文件不是合法 JSON，为避免覆盖用户数据已中止写入");
  }
  const section = doc[sectionKey];
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  if (!(name in (section as Record<string, unknown>))) return null;
  delete (section as Record<string, unknown>)[name];
  if (Object.keys(section as Record<string, unknown>).length === 0) {
    delete doc[sectionKey];
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface McpUninstallTarget {
  /** 候选配置文件（项目级 + 全局，存在哪个就清哪个） */
  files: Array<{ path: string; sectionKey: "mcpServers" | "mcp" }>;
  /** CLI 型全局注册的兜底移除命令（<binary> mcp remove agentbus） */
  cliBinary?: string;
}

/** 卸载计划：不依赖 init 时选的 scope，候选位置全部扫一遍（幂等） */
export function planMcpUninstall(tool: string, projectRoot: string, homeDir: string): McpUninstallTarget {
  switch (tool) {
    case "claude":
      return {
        files: [
          { path: join(projectRoot, ".mcp.json"), sectionKey: "mcpServers" },
          { path: join(homeDir, ".claude.json"), sectionKey: "mcpServers" },
        ],
      };
    case "qoder":
      return {
        files: [
          { path: join(projectRoot, ".qoder", "mcp.json"), sectionKey: "mcpServers" },
          { path: join(homeDir, ".qoder", "mcp.json"), sectionKey: "mcpServers" },
        ],
      };
    case "kilo":
      // 项目级直写文件 + 全局 CLI 兜底（init 时 global 走 kilo mcp add）
      return {
        files: [{ path: join(projectRoot, ".kilo", "kilo.json"), sectionKey: "mcp" }],
        cliBinary: "kilo",
      };
    case "opencode":
      return {
        files: [
          { path: join(projectRoot, "opencode.json"), sectionKey: "mcp" },
          { path: join(homeDir, ".config", "opencode", "opencode.json"), sectionKey: "mcp" },
        ],
      };
    case "codex":
      // 红线 6：agentbus 不手写 config.toml，仅 CLI 移除
      return { files: [], cliBinary: "codex" };
    case "hermes":
      return { files: [] };
    default:
      return { files: [] };
  }
}

/** CLI 型移除参数：<binary> mcp remove agentbus */
export const cliRemoveArgs = (): string[] => ["mcp", "remove", MCP_NAME];
