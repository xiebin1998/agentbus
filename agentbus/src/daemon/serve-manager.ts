/**
 * TASK-27: ServeManager —— opencode serve 无头进程管理（架构 5.4 进阶通道）
 *
 * 语义：daemon 按 binary+workspace+port 缓存 serve 子进程；注入前 ensure() 返回服务 URL，
 * 适配器 attach 回合直连，免每回合冷启动。进程退出/探测失败自动重拉；daemon stop 统一回收。
 * spawn/probe 依赖注入（缺省真实实现），测试不碰进程与网络。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { escapeCmdArg, resolveSpawnTarget } from "../adapters/base.js";

/** 长活子进程句柄（与一次性 runCommand 不同：不等待退出，只收集流） */
export interface ServeHandle {
  stdout: NodeJS.EventEmitter;
  stderr: NodeJS.EventEmitter;
  child: ChildProcess;
}

export interface ServeSpawnSpec {
  cmd: string;
  args: string[];
  cwd: string;
}

export interface ServeSpec {
  binary: string;
  workspace: string;
  /** 固定监听端口（0 = 随机，从 stdout 解析实际地址） */
  port: number;
}

interface ServeEntry {
  url: string | null;
  alive: boolean;
  handle: ServeHandle | null;
  /** 监听端口（固定端口时用于 kill 兜底） */
  port: number;
  /** 启动中的等待者：就绪/失败时统一结算 */
  waiters: Array<{ resolve: (url: string) => void; reject: (e: Error) => void }>;
}

export interface ServeManagerOptions {
  spawn?: (spec: ServeSpawnSpec) => Promise<ServeHandle>;
  /** 健康探测（缺省 HTTP GET 服务根路径）；false → kill 重拉 */
  probe?: (url: string) => Promise<boolean>;
  /** 启动窗口超时（默认 30s：opencode 冷启动含插件加载） */
  readyTimeoutMs?: number;
  /** 告警输出（缺省 console.warn）：回收时端口复查失败等 */
  warn?: (msg: string) => void;
}

/** stdout/stderr 中解析服务地址（实测 opencode serve 打印形如 http://127.0.0.1:<port> 的行） */
function parseServeUrl(chunk: string): string | null {
  const m = chunk.match(/https?:\/\/[^\s"']+/);
  return m ? m[0] : null;
}

export class ServeManager {
  private entries = new Map<string, ServeEntry>();
  private spawnFn: (spec: ServeSpawnSpec) => Promise<ServeHandle>;
  private probeFn: (url: string) => Promise<boolean>;
  private readyTimeoutMs: number;
  private warnFn: (msg: string) => void;

  constructor(opts: ServeManagerOptions = {}) {
    this.spawnFn = opts.spawn ?? makeDefaultSpawn();
    this.probeFn = opts.probe ?? defaultProbe;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
    this.warnFn = opts.warn ?? ((msg) => console.warn(msg));
  }

  /** 确保 serve 就绪并返回服务 URL；启动失败抛错（调用方回退冷启动） */
  async ensure(spec: ServeSpec): Promise<string> {
    const key = `${spec.binary}|${spec.workspace}|${spec.port}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (!existing.url) {
        // 启动中：并入等待者；启动失败残留：清除后重拉（防挂起）
        if (existing.alive) return this.waitReady(existing);
        this.entries.delete(key);
      } else {
        // 已就绪：探测健康；死亡/僵死 → kill 重拉
        if (existing.alive && (await this.probeFn(existing.url))) return existing.url;
        this.teardown(key, existing);
      }
    }
    const entry: ServeEntry = { url: null, alive: true, handle: null, port: spec.port, waiters: [] };
    this.entries.set(key, entry);
    await this.launch(entry, spec);
    return this.waitReady(entry);
  }

  /** daemon stop：kill 所有存活 serve 进程 */
  stopAll(): void {
    for (const [key, entry] of [...this.entries]) {
      this.teardown(key, entry);
    }
  }

  private async launch(entry: ServeEntry, spec: ServeSpec): Promise<void> {
    let handle: ServeHandle;
    try {
      handle = await this.spawnFn({
        cmd: spec.binary,
        args: ["serve", "--port", String(spec.port), "--hostname", "127.0.0.1"],
        cwd: spec.workspace,
      });
    } catch (e) {
      this.settle(entry, new Error(`opencode serve 启动失败: ${(e as Error).message}`));
      return;
    }
    entry.handle = handle;
    let buffer = "";
    // 实测 opencode serve 服务地址打在 stderr（stdout 为空）→ 双流都解析
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      if (entry.url) return;
      const url = parseServeUrl(buffer);
      if (url) {
        entry.url = url;
        this.settle(entry, null);
      }
    };
    handle.stdout.on("data", onData);
    handle.stderr.on("data", onData);
    handle.child.on("exit", () => {
      entry.alive = false;
      if (!entry.url) this.settle(entry, new Error("opencode serve 启动窗口内退出"));
    });
    setTimeout(() => {
      if (!entry.url && entry.alive) {
        entry.alive = false;
        if (entry.handle) this.killChild(entry.handle, entry.port);
        this.settle(entry, new Error(`opencode serve 就绪超时（${this.readyTimeoutMs}ms）`));
      }
    }, this.readyTimeoutMs).unref();
  }

  private waitReady(entry: ServeEntry): Promise<string> {
    if (entry.url && entry.alive) return Promise.resolve(entry.url);
    return new Promise<string>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  }

  private settle(entry: ServeEntry, error: Error | null): void {
    const waiters = entry.waiters.splice(0);
    for (const w of waiters) {
      if (error) w.reject(error);
      else w.resolve(entry.url!);
    }
  }

  private teardown(key: string, entry: ServeEntry): void {
    this.entries.delete(key);
    entry.alive = false;
    if (entry.handle) this.killChild(entry.handle, entry.port);
    this.settle(entry, new Error("serve 进程已回收"));
  }

  /** Windows 下 cmd.exe 套壳的孙进程持服务，单杀 wrapper 无效 → taskkill /T 杀整棵树；失败按端口兜底（TASK-27 实测） */
  private killChild(handle: ServeHandle, port: number): void {
    if (process.platform === "win32" && handle.child.pid) {
      windowsServeKill({
        pid: handle.child.pid,
        port,
        runTaskkill: (pid) =>
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).status === 0,
        listenersOf: listenersOnPort,
        killPid: (pid) => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* 已退出 */
          }
        },
        onPortCheckFailed: (p, e) =>
          this.warnFn(`serve 端口 ${p} 复查失败（netstat/PowerShell 均不可用？），兜底补杀跳过：${e.message}`),
      });
      return;
    }
    void Promise.resolve(handle.child.kill()).catch(() => {});
  }
}

export interface WindowsServeKillDeps {
  pid: number | undefined;
  port: number;
  runTaskkill: (pid: number) => boolean;
  listenersOf: (port: number) => number[];
  killPid: (pid: number) => void;
  /** 监听查询失败（如受限环境 netstat 被拒）：通知调用方记日志，不抛 */
  onPortCheckFailed?: (port: number, error: Error) => void;
}

/** Windows serve 回收：taskkill /T 后固定端口无条件复查（实测 taskkill 成功仍可能残留套壳孙进程），
 * 端口仍被占则按监听 pid 补杀；随机端口（0）无端口可查，仅 taskkill */
export function windowsServeKill(deps: WindowsServeKillDeps): void {
  if (deps.pid !== undefined) deps.runTaskkill(deps.pid);
  if (deps.port <= 0) return;
  let pids: number[];
  try {
    pids = deps.listenersOf(deps.port);
  } catch (e) {
    deps.onPortCheckFailed?.(deps.port, e as Error);
    return;
  }
  for (const pid of pids) {
    deps.killPid(pid);
  }
}

/** 查指定端口的 LISTENING 属主 pid：netstat 优先，失败回退 PowerShell Get-NetTCPConnection
 *（TASK-27 实测：受限 sandbox 内 NETSTAT.EXE 被拒但 Get-NetTCPConnection 可用）；两者都失败则抛错 */
export function listenersOnPort(
  port: number,
  execNetstat: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: "utf-8", windowsHide: true }),
  execPwsh: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: "utf-8", windowsHide: true }),
): number[] {
  try {
    return parseNetstatOutput(execNetstat("netstat -ano -p TCP"), port);
  } catch (netstatErr) {
    try {
      return parsePwshOutput(execPwsh(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -Property OwningProcess | Format-Table -HideTableHeaders | Out-String"`), port);
    } catch {
      throw netstatErr;
    }
  }
}

function parseNetstatOutput(out: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    if (!line.includes("LISTENING")) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] ?? "";
    const pid = Number(parts[4]);
    if (local.endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Get-NetTCPConnection 表格输出：取每行最后一个字段（OwningProcess 列），表头/分隔行非数字自然跳过 */
function parsePwshOutput(out: string, _port: number): number[] {
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** 从 config.tools 提取固定 serve 端口（serve=true 且 serve_port>0）；随机端口无从定向回收 */
export function reclaimServePorts(
  tools: Record<string, Record<string, unknown>> | undefined,
  kill: (port: number) => void,
): void {
  for (const cfg of Object.values(tools ?? {})) {
    if (cfg?.serve === true && typeof cfg.serve_port === "number" && cfg.serve_port > 0) {
      kill(cfg.serve_port);
    }
  }
}

export interface KillServePortDeps {
  listenersOf?: (port: number) => number[];
  killPid?: (pid: number) => void;
  warn?: (msg: string) => void;
}

/** 无 daemon pid 上下文的定向回收（Windows 下 daemon stop 为强杀，孤儿 serve 只能按端口杀） */
export function killServePort(port: number, deps: KillServePortDeps = {}): void {
  windowsServeKill({
    pid: undefined,
    port,
    runTaskkill: () => true,
    listenersOf: deps.listenersOf ?? listenersOnPort,
    killPid:
      deps.killPid ??
      ((pid) => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }),
    onPortCheckFailed: (p, e) =>
      (deps.warn ?? console.warn)(`serve 端口 ${p} 复查失败（netstat/PowerShell 均不可用？），兜底补杀跳过：${e.message}`),
  });
}

/** 缺省 spawn：复用 base.ts 的 Windows 裸名/.cmd shim 解析（TASK-16 实测 spawn 裸名 EINVAL/ENOENT） */
export function makeDefaultSpawn(
  platform: NodeJS.Platform = process.platform,
): (spec: ServeSpawnSpec) => Promise<ServeHandle> {
  return async (spec) => {
    const { cmd, prefix, verbatim } = resolveSpawnTarget(spec.cmd, platform);
    const args = verbatim ? spec.args.map(escapeCmdArg) : spec.args;
    const child = spawn(cmd, [...prefix, ...args], {
      cwd: spec.cwd,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout: child.stdout!, stderr: child.stderr!, child };
  };
}

/** 缺省探测：HTTP GET 服务根路径，任何响应（含 404）视为活着 */
async function defaultProbe(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    void resp.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
