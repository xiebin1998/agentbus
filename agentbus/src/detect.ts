/**
 * TASK-12: CLI 探测（架构 6.2 步骤 2）
 *
 * 逐个探测所选工具的 CLI 是否可用：`<binary> --version` exit 0 即视为已安装，
 * 版本取 stdout（fallback stderr）首行。探测失败一律收敛为 installed=false，不抛异常。
 */
import { runCommand } from "./adapters/base.js";

/** 工具名 → 二进制名映射（本机实测：qoder 的二进制是 qodercli） */
export const TOOL_BINARIES: Record<string, string> = {
  qoder: "qodercli",
  kilo: "kilo",
  opencode: "opencode",
  claude: "claude",
  codex: "codex",
  hermes: "hermes",
};

export interface RunnerResultLike {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 可注入的探测执行器（测试用假实现，生产走 runCommand） */
export type CliRunner = (bin: string, args: string[]) => Promise<RunnerResultLike>;

export interface DetectResult {
  tool: string;
  binary: string;
  installed: boolean;
  version?: string;
  /** 未安装/未知工具的原因说明 */
  reason?: string;
}

const defaultRunner: CliRunner = async (bin, args) => {
  const r = await runCommand({ cmd: bin, args, timeoutMs: 10_000 });
  if (r.error) throw new Error(r.error);
  return r;
};

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line?.trim();
}

/** 探测一组工具；未知工具名返回 installed=false 并注明原因，不影响其余探测 */
export async function detectClis(tools: string[], runner: CliRunner = defaultRunner): Promise<DetectResult[]> {
  const results: DetectResult[] = [];
  for (const tool of tools) {
    const binary = TOOL_BINARIES[tool];
    if (!binary) {
      results.push({ tool, binary: tool, installed: false, reason: `未知工具 ${tool}（可选：${Object.keys(TOOL_BINARIES).join(", ")}）` });
      continue;
    }
    try {
      const r = await runner(binary, ["--version"]);
      if (r.exitCode === 0) {
        results.push({ tool, binary, installed: true, version: firstLine(r.stdout) ?? firstLine(r.stderr) });
      } else {
        results.push({ tool, binary, installed: false, reason: `${binary} --version 退出码 ${r.exitCode}` });
      }
    } catch {
      results.push({ tool, binary, installed: false, reason: `${binary} 未安装或不在 PATH 中` });
    }
  }
  return results;
}
