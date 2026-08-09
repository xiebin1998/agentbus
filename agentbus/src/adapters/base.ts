/**
 * TASK-07: Adapter 执行框架 —— spawn 一次性 CLI 回合（架构 4.6 代回支点）
 *
 * 语义：子进程跑完一回合 → 输出打到 stdout → 退出；本层只负责收集，
 * 结构化提取由各适配器实现（对 daemon 统一为 turn.output）。
 */
import { spawn } from "node:child_process";

export interface SpawnSpec {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface RunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn 失败等错误描述（不抛异常，调用方按结果分支） */
  error?: string;
}

/** spawn + stdout/stderr 收集 + 超时 kill；一切异常收敛进返回值 */
export function runCommand(spec: SpawnSpec): Promise<RunnerResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      windowsHide: true,
    });

    const finish = (result: RunnerResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));

    child.on("error", (err) => {
      finish({ exitCode: -1, stdout, stderr, timedOut: false, error: `spawn 失败: ${err.message}` });
    });

    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut: false });
    });

    timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      // 宽限后仍不退出则强杀
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      finish({ exitCode: -1, stdout, stderr, timedOut: true, error: `执行超时（${spec.timeoutMs}ms）` });
    }, spec.timeoutMs);
  });
}

/** 适配器的统一回合结果（daemon 侧只依赖此形状） */
export interface AdapterTurn {
  sessionId: string;
  output: string;
  exitCode: number;
  timedOut: boolean;
  error?: string;
}
