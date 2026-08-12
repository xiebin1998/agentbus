/**
 * TASK-07: Qoder 适配器（qodercli）
 *
 * 实测参数语义（2026-08-09，qodercli --help）：
 * - `-p` 为布尔开关，prompt 走位置参数，`--` 分隔防止以 - 开头的 prompt 被吞
 * - `--session-id <id>` 幂等：新 id 建会话，已有 id 续接（create/inject 同一命令形态）
 *   ⚠️ 实测约束：id 必须是合法 UUID，否则报 Invalid session ID（用 newQoderSessionId 生成）
 * - `-o json` 退出时输出结构化结果
 * - 权限枚举 default/accept_edits/bypass_permissions/dont_ask/auto，无只读档
 *   → 恒只读回退：`--tools ""` 禁用全部内置工具（架构 4.7；沟通定位：入站恒只读）
 */
import { randomUUID } from "node:crypto";
import { runCommand, type AdapterTurn, type RunnerResult, type SpawnSpec } from "./base.js";

/** qodercli 的 --session-id 仅接受 UUID（实测 2026-08-09） */
export function newQoderSessionId(): string {
  return randomUUID();
}

export interface QoderAdapterConfig {
  /** CLI 二进制名/路径（默认 qodercli） */
  binary?: string;
  /** 会话工作目录（-w） */
  workspace: string;
  /** 单回合超时 */
  timeoutMs?: number;
  /** 会话显示名（-n，缺省不传） */
  sessionName?: string;
}

export class QoderAdapter {
  private binary: string;
  private timeoutMs: number;

  constructor(
    private cfg: QoderAdapterConfig,
    private run: (spec: SpawnSpec) => Promise<RunnerResult> = runCommand,
  ) {
    this.binary = cfg.binary ?? "qodercli";
    this.timeoutMs = cfg.timeoutMs ?? 300_000;
  }

  /** 只读档参数（唯一档）：禁全部内置工具，不放宽权限 */
  readonlyArgs(text: string, sessionId: string): string[] {
    return this.baseArgs(text, sessionId, ["--tools", ""]);
  }

  /** 权限/工具参数一律置于 `-- prompt` 之前，避免被变参/位置参数吞掉 */
  private baseArgs(text: string, sessionId: string, trailing: string[] = []): string[] {
    const args = [
      "-w", this.cfg.workspace,
      "--session-id", sessionId,
      "-p",
      "-o", "json",
      ...trailing,
    ];
    if (this.cfg.sessionName) args.push("-n", this.cfg.sessionName);
    args.push("--", text);
    return args;
  }

  /** 建会话（daemon 预生成 sessionId，--session-id 幂等语义；恒只读档） */
  async createSession(text: string, sessionId: string): Promise<AdapterTurn> {
    return this.runTurn(this.readonlyArgs(text, sessionId), sessionId);
  }

  /** 续接注入（与 injectWith 同实现的对称 API；恒只读档） */
  async inject(text: string, sessionId: string): Promise<AdapterTurn> {
    return this.runTurn(this.readonlyArgs(text, sessionId), sessionId);
  }

  /** 续接注入（TASK-09 信封链路使用；恒只读档） */
  async injectWith(text: string, sessionId: string): Promise<AdapterTurn> {
    return this.runTurn(this.readonlyArgs(text, sessionId), sessionId);
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
      error = `qodercli 回合超时（${this.timeoutMs}ms）`;
    } else if (result.exitCode !== 0 && !error) {
      const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
      error = `qodercli 退出码 ${result.exitCode}${tail ? `：${tail}` : ""}`;
    } else if (result.exitCode === 0 && !error) {
      // 实测陷阱：未登录等失败时进程仍 exit 0，但 JSON 携带 is_error=true
      // 仅 exit 0 且无既有 error 时做逻辑检查（TASK-29 实测缺陷：spawn 失败会被覆写成 undefined）
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
        return `qodercli 回合失败：${msg}`;
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
