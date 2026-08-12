/**
 * TASK-07: Adapter 执行框架 —— spawn 一次性 CLI 回合（架构 4.6 代回支点）
 *
 * 语义：子进程跑完一回合 → 输出打到 stdout → 退出；本层只负责收集，
 * 结构化提取由各适配器实现（对 daemon 统一为 turn.output）。
 */
import { spawn, spawnSync } from "node:child_process";
import { extname } from "node:path";

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

/**
 * Windows 命令解析（TASK-16 实测：codex/qodercli/kilo 均为 npm .cmd shim，spawn 裸名 EINVAL/ENOENT）：
 * - 无扩展名：where.exe 按 PATHEXT 解析全路径（用调用方 env，兼容 PATH 注入）
 * - .cmd/.bat：经 cmd.exe /d /s /c 执行（cross-spawn 同款），参数逐引号转义后原样传递
 */
function resolveWindowsCmd(cmd: string, env: Record<string, string | undefined>): { cmd: string; prefix: string[]; verbatim: boolean } {
  let resolved = cmd;
  if (!extname(cmd)) {
    const found = spawnSync("where.exe", [cmd], { encoding: "utf-8", windowsHide: true, env });
    const lines = (found.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // 实测：npm 全局目录同名存在无扩展 sh 脚本与 .cmd，spawn 无扩展文件 ENOENT——优先取带可执行扩展名的候选
    const preferred = lines.find((l) => /\.(cmd|bat|exe|com)$/i.test(l));
    const first = preferred ?? lines[0];
    if (first) resolved = first;
  }
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return { cmd: "cmd.exe", prefix: ["/d", "/s", "/c", escapeCmdArg(resolved)], verbatim: true };
  }
  return { cmd: resolved, prefix: [], verbatim: false };
}

/**
 * TASK-27 抽出的纯解析（长活进程 spawn 复用）：
 * 非 win32 原样返回；win32 裸名经 where.exe 解析全路径，.cmd/.bat 经 cmd.exe 套壳。
 */
export function resolveSpawnTarget(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { cmd: string; prefix: string[]; verbatim: boolean } {
  if (platform !== "win32") return { cmd, prefix: [], verbatim: false };
  return resolveWindowsCmd(cmd, env);
}

/** cmd 元字符：未引用时会被 cmd.exe 解析（分隔/重定向/变量展开） */
const CMD_META = /[ \t&|<>^%!()"]/;

/**
 * cmd.exe 参数引用转义（TASK-22 实测：sse_url 中 & 被当命令分隔符导致 codex mcp add 恒失败）：
 * 含元字符时整体加引号（引号内 & 等为字面量），内部引号与尾部反斜杠按 Windows argv 规则翻倍转义；
 * 无元字符不加引号（避免破坏 echo %1 类 shim 的既有行为）。配合 windowsVerbatimArguments 防 libuv 二次加引号。
 * 换行先压平为空格：实测 cmd.exe 遇换行即断命令（引号内也不例外）——多行信封经 .cmd shim
 * 时首行之后的指令行与正文会整体丢失（收件方只看到信封头）。cmd 命令行物理上无法承载嵌入换行。
 */
export function escapeCmdArg(arg: string): string {
  const flat = arg.replace(/\r?\n/g, " ");
  if (!CMD_META.test(flat)) return flat;
  const escaped = flat.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/** spawn + stdout/stderr 收集 + 超时 kill；一切异常收敛进返回值 */
export function runCommand(spec: SpawnSpec): Promise<RunnerResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const env = spec.env ? { ...process.env, ...spec.env } : process.env;
    const { cmd, prefix, verbatim } = resolveSpawnTarget(spec.cmd, process.platform, env);
    // cmd.exe 路径下参数已自行引号转义；非 cmd 路径仍由 libuv 默认加引号
    const args = verbatim ? spec.args.map(escapeCmdArg) : spec.args;

    const child = spawn(cmd, [...prefix, ...args], {
      cwd: spec.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });

    const finish = (result: RunnerResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    // TASK-16 实测：codex 在 stdin 为未关闭管道时阻塞等 EOF——注入回合无 stdin 输入，立即关闭
    child.stdin?.end();

    child.on("error", (err) => {
      finish({ exitCode: -1, stdout, stderr, timedOut: false, error: `spawn 失败: ${err.message}` });
    });

    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut: false });
    });

    timer = setTimeout(() => {
      if (settled) return;
      if (process.platform === "win32") {
        // 实测：.cmd 套壳的孙进程持 stdio 管道，单杀 wrapper 无效——taskkill /T 杀整棵树
        if (child.pid) {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        }
      } else {
        child.kill("SIGTERM");
        // 宽限后仍不退出则强杀
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }
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
