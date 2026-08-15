/**
 * TASK-08: OpenCode/Kilo 适配器（同族共用，二进制名参数化，架构 5.3）
 *
 * 实测 kilo 7.4.17（2026-08-09）：
 * - `run` 子命令 + 位置参数消息；`--title` 会话命名；`-s/--session` 续接
 * - `--format json` 输出 NDJSON 事件流 → 取末条文本事件（架构 4.6 表）
 * - `--auto` 全自动批准（本工具无只读权限档 → 入站只读靠信封约束 + 隔离层兜底，4.7）
 * - 新会话 id 不由 daemon 预生成，从事件流 session 事件中提取
 *
 * TASK-27 进阶通道（架构 5.4）实测 opencode/kilo（2026-08-15）：
 * - `serve --port <n> --hostname <h>` 起无头服务器；`run --attach <url>` 免冷启动注入
 * - kilo 与 opencode 均支持 serve + attach（同族同 API）→ supportsServe 两者皆真
 */
import { runCommand, type RunnerResult, type SpawnSpec } from "./base.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

/**
 * 解析 opencode/kilo 的实际可执行文件路径
 * npm 全局安装的 .cmd 走 cmd.exe 套壳会导致 stdout 重定向失效
 * 直接使用 node_modules 下的 .exe 绕过 cmd.exe
 */
function resolveExePath(binary: string): string {
  if (binary === "opencode") {
    // opencode 实际 exe 路径
    const exePath = join(homedir(), "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(exePath)) return exePath;
  }
  // kilo 或其他情况返回裸名，走默认解析
  return binary;
}

export interface KiloTurn {
  /** createSession 从事件流提取；提取失败为 null（调用方记告警） */
  sessionId: string | null;
  output: string;
  exitCode: number;
  timedOut: boolean;
  error?: string;
}

export interface OpenCodeKiloConfig {
  /** 二进制名：kilo / opencode */
  binary?: string;
  workspace: string;
  timeoutMs?: number;
}

export class OpenCodeKiloAdapter {
  private binary: string;
  private timeoutMs: number;

  constructor(
    private cfg: OpenCodeKiloConfig,
    private run: (spec: SpawnSpec) => Promise<RunnerResult> = runCommand,
  ) {
    this.binary = cfg.binary ?? "kilo";
    this.timeoutMs = cfg.timeoutMs ?? 600_000;
  }

  /** 建会话参数；会话名 = 来源 client_id（架构 4.3） */
  createSessionArgs(message: string, sessionName: string): string[] {
    return this.turnArgs(message, sessionName);
  }

  /** 续接参数：--auto 全自动批准（与 createSession 一致，避免 kilo 调用工具时权限被拒） */
  injectArgs(message: string, sessionId: string): string[] {
    return this.baseArgs(message, ["-s", sessionId, "--auto"]);
  }

  /** 回合参数：--auto 全自动批准（无只读权限档 → 靠信封约束 + 隔离层兜底，架构 4.7） */
  turnArgs(message: string, sessionName: string): string[] {
    // opencode 的 --title 在非 TTY 环境下会挂起，仅 kilo 使用
    const trailing = this.binary === "kilo" ? ["--title", sessionName, "--auto"] : ["--auto"];
    return this.baseArgs(message, trailing);
  }

  /** 是否支持 serve 模式（仅 kilo 支持；opencode attach/cold-start 检测 stdout TTY，pipe 挂起，需用 stdoutFile 冷启动） */
  supportsServe(): boolean {
    return this.binary === "kilo";
  }

  /** serve 无头服务器参数；port 缺省 0 = 随机端口（stdout 打印实际地址） */
  serveArgs(port = 0, hostname = "127.0.0.1"): string[] {
    return ["serve", "--port", String(port), "--hostname", hostname];
  }

  /** attach 建会话参数：连已就绪 serve，免冷启动 */
  attachCreateSessionArgs(serverUrl: string, message: string, sessionName: string): string[] {
    return this.attachBaseArgs(serverUrl, message, ["--title", sessionName, "--auto"]);
  }

  /** attach 续接参数：连已就绪 serve + -s 会话续接 + --auto 全自动批准 */
  attachInjectArgs(serverUrl: string, message: string, sessionId: string): string[] {
    return this.attachBaseArgs(serverUrl, message, ["-s", sessionId, "--auto"]);
  }

  private attachBaseArgs(serverUrl: string, message: string, trailing: string[]): string[] {
    // --pure 禁用外部 MCP 插件（实测 opencode attach 不带 --pure 时只输出 step_start 就退出）
    // 不传 --dir：serve 已绑定 workspace（spawn cwd），attach 传不同 --dir 会导致只输出 step_start 就退出
    return ["run", "--attach", serverUrl, "--format", "json", "--pure", ...trailing, message];
  }

  /** 选项一律置于位置参数消息之前（yargs array 位置参数会吞后续 token） */
  private baseArgs(message: string, trailing: string[] = []): string[] {
    // --pure 禁用外部 MCP 插件（daemon 调用时无 MCP 桥，避免 kilo 尝试连接导致权限拒绝）
    return ["run", "--format", "json", "--pure", "--dir", this.cfg.workspace, ...trailing, message];
  }

  async createSession(message: string, sessionName: string): Promise<KiloTurn> {
    return this.runTurn(this.createSessionArgs(message, sessionName));
  }

  async inject(message: string, sessionId: string): Promise<KiloTurn> {
    return this.runTurn(this.injectArgs(message, sessionId));
  }

  /** attach 建会话回合（TASK-27：连 serve 免冷启动） */
  async attachCreateSession(serverUrl: string, message: string, sessionName: string): Promise<KiloTurn> {
    return this.runTurn(this.attachCreateSessionArgs(serverUrl, message, sessionName));
  }

  /** attach 续接回合（TASK-27：连 serve 免冷启动） */
  async attachInject(serverUrl: string, message: string, sessionId: string): Promise<KiloTurn> {
    return this.runTurn(this.attachInjectArgs(serverUrl, message, sessionId));
  }

  private async runTurn(args: string[]): Promise<KiloTurn> {
    // opencode 直接使用 .exe 路径，避免 .cmd 走 cmd.exe 套壳导致 stdout 重定向失效
    const cmdPath = resolveExePath(this.binary);
    const result = await this.run({
      cmd: cmdPath,
      args,
      cwd: this.cfg.workspace,
      timeoutMs: this.timeoutMs,
      // opencode 检测 stdout TTY：pipe 挂起，需重定向到临时文件
      stdoutFile: this.binary === "opencode",
    });
    const output = this.extractText(result.stdout);
    let error = result.error;
    if (result.timedOut) {
      error = `${this.binary} 回合超时（${this.timeoutMs}ms）`;
    } else if (result.exitCode !== 0 && !error) {
      const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
      error = `${this.binary} 退出码 ${result.exitCode}${tail ? `：${tail}` : ""}`;
    }
    return {
      sessionId: this.extractSessionId(result.stdout),
      output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      error,
    };
  }

  /** NDJSON 事件流 → 末条文本事件的文本；无文本事件回退整段 trim */
  extractText(stdout: string): string {
    const trimmed = stdout.trim();
    if (!trimmed) return "";
    let lastText: string | null = null;
    for (const line of trimmed.split("\n")) {
      const text = this.textFromEvent(line);
      if (text !== null) lastText = text;
    }
    return lastText ?? trimmed;
  }

  /** 单行事件的文本提取；非文本/非法 JSON 返回 null */
  private textFromEvent(line: string): string | null {
    const s = line.trim();
    if (!s) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
    if (obj === null || typeof obj !== "object") return null;
    const ev = obj as Record<string, unknown>;
    // { type:"text", text:"..." }
    if (typeof ev.text === "string" && ev.text.trim()) return ev.text;
    // { message: { content:"..." } }
    const message = ev.message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string" && content.trim()) return content;
    }
    // { parts: [ { type:"text", text:"..." }, ... ] }
    if (Array.isArray(ev.parts)) {
      for (let i = ev.parts.length - 1; i >= 0; i--) {
        const part = ev.parts[i] as Record<string, unknown> | null;
        if (part && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          return part.text;
        }
      }
    }
    // TASK-27 attach 实测形态：{ type:"text", part: { type:"text", text:"..." } }（单数 part）
    const part = ev.part;
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) return p.text;
    }
    return null;
  }

  /** 从事件流提取新会话 id（session_id/sessionID/sessionId 多形态兼容） */
  extractSessionId(stdout: string): string | null {
    for (const line of stdout.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(s);
      } catch {
        continue;
      }
      if (obj === null || typeof obj !== "object") continue;
      const ev = obj as Record<string, unknown>;
      for (const key of ["session_id", "sessionID", "sessionId"]) {
        const v = ev[key];
        if (typeof v === "string" && v) return v;
      }
      const props = ev.properties;
      if (props && typeof props === "object") {
        for (const key of ["session_id", "sessionID", "sessionId"]) {
          const v = (props as Record<string, unknown>)[key];
          if (typeof v === "string" && v) return v;
        }
      }
    }
    return null;
  }
}
