/**
 * TASK-16: Codex 适配器（codex-cli）
 *
 * 实测参数语义（2026-08-09，codex-cli 0.146.0 --help + 真实回合捕获，架构 11.4）：
 * - `codex exec [PROMPT]` 非交互；`--json` stdout JSONL 事件流
 * - 会话 id 在 `{"type":"thread.started","thread_id":"<uuid>"}` 事件（真实回合实测）
 * - 最终回复走 `-o, --output-last-message <file>` 写文件，回合后读文件（架构 4.6）
 * - `exec resume <id> [PROMPT]` 续接（UUID 或 thread name，UUID 优先）
 * - readonly → `-s read-only`；full → `-s workspace-write`（架构 4.7）
 *   ⚠️ 0.146.0 已移除 `-a/--ask-for-approval`，full 档免确认语义待后端可达后补实测
 * - stdin 阻塞陷阱已由 base.runCommand 统一关闭 stdin 解决
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type RunnerResult, type SpawnSpec } from "./base.js";

export interface CodexTurn {
  /** createSession 从 JSONL 事件流提取；提取失败为 null（调用方记告警） */
  sessionId: string | null;
  output: string;
  exitCode: number;
  timedOut: boolean;
  error?: string;
}

export interface CodexAdapterConfig {
  /** CLI 二进制名/路径（默认 codex） */
  binary?: string;
  /** 会话工作目录（-C） */
  workspace: string;
  /** 单回合超时 */
  timeoutMs?: number;
  /** -o 临时文件目录（默认系统 tmpdir） */
  tmpDir?: string;
}

export class CodexAdapter {
  private binary: string;
  private timeoutMs: number;
  private tmpDir: string;

  constructor(
    private cfg: CodexAdapterConfig,
    private run: (spec: SpawnSpec) => Promise<RunnerResult> = runCommand,
  ) {
    this.binary = cfg.binary ?? "codex";
    this.timeoutMs = cfg.timeoutMs ?? 600_000;
    this.tmpDir = cfg.tmpDir ?? tmpdir();
  }

  /** 建会话参数（exec + JSONL + 沙箱档 + -o 文件）；prompt 位置参数收尾 */
  createArgs(text: string, mode: "readonly" | "full", outFile: string): string[] {
    return ["exec", ...this.commonArgs(mode, outFile), text];
  }

  /** 续接参数（exec resume <id>；UUID 或 thread name） */
  resumeArgs(text: string, sessionId: string, mode: "readonly" | "full", outFile: string): string[] {
    return ["exec", "resume", sessionId, ...this.commonArgs(mode, outFile), text];
  }

  private commonArgs(mode: "readonly" | "full", outFile: string): string[] {
    const sandbox = mode === "full" ? "workspace-write" : "read-only";
    return [
      "--json",
      "-s", sandbox,
      "-C", this.cfg.workspace,
      "--skip-git-repo-check",
      "-o", outFile,
    ];
  }

  /** 建会话并注入首条消息；会话 id 由 CLI 侧生成（JSONL 提取，daemon 不预生成） */
  async createSession(text: string, mode: "readonly" | "full"): Promise<CodexTurn> {
    const outFile = join(this.tmpDir, `agentbus-codex-${randomUUID()}.txt`);
    return this.runTurn(this.createArgs(text, mode, outFile), outFile);
  }

  /** 信任级别显式的续接注入（TASK-09 信封链路使用） */
  async injectWith(text: string, sessionId: string, mode: "readonly" | "full"): Promise<CodexTurn> {
    const outFile = join(this.tmpDir, `agentbus-codex-${randomUUID()}.txt`);
    return this.runTurn(this.resumeArgs(text, sessionId, mode, outFile), outFile);
  }

  private async runTurn(args: string[], outFile: string): Promise<CodexTurn> {
    const result = await this.run({
      cmd: this.binary,
      args,
      cwd: this.cfg.workspace,
      timeoutMs: this.timeoutMs,
    });
    const output = this.readLastMessage(outFile);
    let error = result.error;
    if (result.timedOut) {
      error = `codex 回合超时（${this.timeoutMs}ms）`;
    } else if (result.exitCode !== 0 && !error) {
      const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
      error = `codex 退出码 ${result.exitCode}${tail ? `：${tail}` : ""}`;
    }
    return {
      sessionId: this.extractSessionId(result.stdout),
      output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      error,
    };
  }

  /** 读 -o 文件为最终回复（架构 4.6）；缺失回退空串；读完即清理 */
  private readLastMessage(outFile: string): string {
    if (!existsSync(outFile)) return "";
    try {
      return readFileSync(outFile, "utf-8").trim();
    } catch {
      return "";
    } finally {
      try {
        unlinkSync(outFile);
      } catch {
        // 清理失败不影响回合结果
      }
    }
  }

  /** JSONL 事件流 → 首个 thread.started 的 thread_id（兼容 session_id/sessionId 与 properties 嵌套） */
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
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) continue;
      const ev = obj as Record<string, unknown>;
      for (const key of ["thread_id", "session_id", "sessionId"]) {
        const v = ev[key];
        if (typeof v === "string" && v) return v;
      }
      const props = ev.properties;
      if (props && typeof props === "object" && !Array.isArray(props)) {
        for (const key of ["thread_id", "session_id", "sessionId"]) {
          const v = (props as Record<string, unknown>)[key];
          if (typeof v === "string" && v) return v;
        }
      }
    }
    return null;
  }
}
