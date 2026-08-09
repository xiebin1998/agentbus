/**
 * TASK-15: Claude 适配器（Claude Code CLI）
 *
 * 实测参数语义（2026-08-09，claude 2.1.220 --help，架构 11.3）：
 * - `-p` 布尔开关，prompt 走位置参数，`--` 分隔防止以 - 开头的 prompt 被吞
 * - create：`--session-id <uuid>`（daemon 预生成，必须合法 UUID）+ `-n` 会话名
 * - inject：`-r <uuid>` 续接（与 create 不同命令形态，区别于 qoder 族幂等 --session-id）
 * - `--output-format json` 退出时输出结构化结果（result 字段），免解析裸文本
 * - readonly → `--permission-mode plan`（实测档：只读调研，禁写禁执行，架构 4.7）
 * - full → `--permission-mode dontAsk`
 */
import { randomUUID } from "node:crypto";
import { runCommand, type AdapterTurn, type RunnerResult, type SpawnSpec } from "./base.js";

/** claude 的 --session-id 仅接受合法 UUID（实测 2026-08-09） */
export function newClaudeSessionId(): string {
  return randomUUID();
}

export interface ClaudeAdapterConfig {
  /** CLI 二进制名/路径（默认 claude） */
  binary?: string;
  /** 会话工作目录（spawn cwd） */
  workspace: string;
  /** 单回合超时 */
  timeoutMs?: number;
  /** 会话显示名（-n，仅 create 传；缺省不传） */
  sessionName?: string;
}

export class ClaudeAdapter {
  private binary: string;
  private timeoutMs: number;

  constructor(
    private cfg: ClaudeAdapterConfig,
    private run: (spec: SpawnSpec) => Promise<RunnerResult> = runCommand,
  ) {
    this.binary = cfg.binary ?? "claude";
    this.timeoutMs = cfg.timeoutMs ?? 600_000;
  }

  /** 建会话参数（架构 5.2：--session-id + -n） */
  createArgs(text: string, sessionId: string, mode: "readonly" | "full"): string[] {
    const head = ["--session-id", sessionId];
    if (this.cfg.sessionName) head.push("-n", this.cfg.sessionName);
    return this.baseArgs(text, head, mode);
  }

  /** 续接参数（架构 5.2：-r <uuid>；不重复传 --session-id/-n） */
  injectArgs(text: string, sessionId: string, mode: "readonly" | "full"): string[] {
    return this.baseArgs(text, ["-r", sessionId], mode);
  }

  /** 权限参数一律置于 `-- prompt` 之前，避免被位置参数吞掉 */
  private baseArgs(text: string, head: string[], mode: "readonly" | "full"): string[] {
    const perm = mode === "full" ? "dontAsk" : "plan";
    return [
      ...head,
      "-p",
      "--output-format", "json",
      "--permission-mode", perm,
      "--", text,
    ];
  }

  /** 建会话并注入首条消息（daemon 预生成 sessionId） */
  async createSession(text: string, sessionId: string, mode: "readonly" | "full"): Promise<AdapterTurn> {
    return this.runTurn(this.createArgs(text, sessionId, mode), sessionId);
  }

  /** 信任级别显式的续接注入（TASK-09 信封链路使用） */
  async injectWith(text: string, sessionId: string, mode: "readonly" | "full"): Promise<AdapterTurn> {
    return this.runTurn(this.injectArgs(text, sessionId, mode), sessionId);
  }

  private async runTurn(args: string[], sessionId: string): Promise<AdapterTurn> {
    const result = await this.run({
      cmd: this.binary,
      args,
      cwd: this.cfg.workspace,
      timeoutMs: this.timeoutMs,
    });
    const output = this.extractText(result.stdout);
    let error = result.error;
    if (result.timedOut) {
      error = `claude 回合超时（${this.timeoutMs}ms）`;
    } else if (result.exitCode !== 0) {
      const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
      error = `claude 退出码 ${result.exitCode}${tail ? `：${tail}` : ""}`;
    } else {
      // 实测陷阱：未登录等失败时进程仍 exit 0，但 JSON 携带 is_error=true
      error = this.detectLogicalError(result.stdout);
    }
    return { sessionId, output, exitCode: result.exitCode, timedOut: result.timedOut, error };
  }

  /** 从结构化输出中识别逻辑失败（is_error=true）；无法解析返回 undefined */
  private detectLogicalError(stdout: string): string | undefined {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      if (obj.is_error === true) {
        const msg = typeof obj.result === "string" ? obj.result : "未知错误";
        return `claude 回合失败：${msg}`;
      }
    } catch {
      // 非 JSON 输出无法判定，交给调用方
    }
    return undefined;
  }

  /** 结构化提取：result → message → text → content；非法 JSON 回退裸文本 */
  extractText(stdout: string): string {
    const trimmed = stdout.trim();
    if (!trimmed) return "";
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["result", "message", "text", "content"]) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v;
        if (v && typeof v === "object") return JSON.stringify(v);
      }
      return trimmed;
    } catch {
      return trimmed;
    }
  }
}
