/**
 * daemon 后台启动/重启（纯逻辑，副作用全注入）：
 * spawn detached 前台子进程（daemon start --foreground）→ 轮询 daemon.pid 出现且存活即成功。
 * 父进程退出后子进程继续运行（Windows detached+stdio:ignore 实测存活）。
 */
export interface BackgroundSpec {
  nodePath: string;   // process.execPath
  binPath: string;    // CLI 入口脚本（process.argv[1]）
  configPath: string; // 绝对路径 config.json
}

export interface BackgroundDeps {
  /** 读 daemon.pid 当前内容；无文件/损坏返回 null */
  pidOf: () => number | null;
  isAlive: (pid: number) => boolean;
  spawn: (cmd: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => void;
  kill: (pid: number) => void;
  sleepMs: (ms: number) => void;
  pollIntervalMs?: number;  // 默认 100
  startTimeoutMs?: number;  // 默认 5000
  stopTimeoutMs?: number;   // 默认 5000
}

export type BackgroundResult =
  | { started: true; pid: number }
  | { started: false; reason: string; alreadyRunning?: number };

function waitPidAlive(deps: BackgroundDeps, timeoutMs: number): number | null {
  const step = deps.pollIntervalMs ?? 100;
  const attempts = Math.max(1, Math.ceil(timeoutMs / step));
  for (let i = 0; i < attempts; i += 1) {
    deps.sleepMs(step);
    const pid = deps.pidOf();
    if (pid && deps.isAlive(pid)) return pid;
  }
  return null;
}

export function startDaemonBackground(spec: BackgroundSpec, deps: BackgroundDeps): BackgroundResult {
  const existing = deps.pidOf();
  if (existing && deps.isAlive(existing)) {
    return { started: false, reason: `daemon 已在运行（pid ${existing}）`, alreadyRunning: existing };
  }
  deps.spawn(spec.nodePath, [spec.binPath, "daemon", "start", "--foreground", "-c", spec.configPath],
    { detached: true, stdio: "ignore" });
  const pid = waitPidAlive(deps, deps.startTimeoutMs ?? 5000);
  if (pid === null) {
    return { started: false, reason: "后台 daemon 未在窗口内写出有效 pid，请查看 logs/daemon.log 排查" };
  }
  return { started: true, pid };
}

export function restartDaemonBackground(spec: BackgroundSpec, deps: BackgroundDeps): BackgroundResult {
  const old = deps.pidOf();
  if (old && deps.isAlive(old)) {
    deps.kill(old);
    const step = deps.pollIntervalMs ?? 100;
    const attempts = Math.max(1, Math.ceil((deps.stopTimeoutMs ?? 5000) / step));
    let dead = false;
    for (let i = 0; i < attempts; i += 1) {
      deps.sleepMs(step);
      if (!deps.isAlive(old)) { dead = true; break; }
    }
    if (!dead) {
      return { started: false, reason: `旧 daemon（pid ${old}）停止超时，请手动处理后重试` };
    }
  }
  return startDaemonBackground(spec, deps);
}
