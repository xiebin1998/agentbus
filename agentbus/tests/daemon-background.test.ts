/** daemon start 后台化与 restart：spawn/isAlive/kill/sleep/pidOf 全注入 */
import { describe, expect, it } from "vitest";
import {
  restartDaemonBackground,
  startDaemonBackground,
  type BackgroundDeps,
  type BackgroundSpec,
} from "../src/daemon/background.js";

const SPEC: BackgroundSpec = {
  nodePath: "/usr/bin/node",
  binPath: "/app/agentbus/dist/bin.js",
  configPath: "/work/.agentbus/config.json",
};

function makeDeps(init: { pid?: number | null; alive?: number[]; pidSequence?: (number | null)[] } = {}) {
  const alive = new Set(init.alive ?? []);
  const spawns: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const kills: number[] = [];
  const sleeps: number[] = [];
  const seq = init.pidSequence ? [...init.pidSequence] : null;
  let pid = init.pid ?? null;
  const deps: BackgroundDeps = {
    pidOf: () => (seq ? (seq.length > 1 ? seq.shift()! : seq[0]) : pid),
    isAlive: (p) => alive.has(p),
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      pid = 555;
      alive.add(555); // 默认假 spawn 后子进程写出 pid 555
    },
    kill: (p) => { kills.push(p); alive.delete(p); },
    sleepMs: (ms) => { sleeps.push(ms); },
    pollIntervalMs: 100,
    startTimeoutMs: 300,
    stopTimeoutMs: 300,
  };
  return { deps, spawns, kills, sleeps };
}

describe("startDaemonBackground", () => {
  it("已在运行 → 不 spawn，返回 alreadyRunning", () => {
    const { deps, spawns } = makeDeps({ pid: 4242, alive: [4242] });
    const r = startDaemonBackground(SPEC, deps);
    expect(r.started).toBe(false);
    expect("alreadyRunning" in r && r.alreadyRunning).toBe(4242);
    expect(spawns).toHaveLength(0);
  });

  it("未运行 → detached spawn 前台子进程，pid 出现即成功", () => {
    const { deps, spawns } = makeDeps({ pidSequence: [null, 555] });
    const r = startDaemonBackground(SPEC, deps);
    expect(r.started).toBe(true);
    expect("pid" in r && r.pid).toBe(555);
    expect(spawns[0].cmd).toBe(SPEC.nodePath);
    expect(spawns[0].args).toEqual([SPEC.binPath, "daemon", "start", "--foreground", "-c", SPEC.configPath]);
    expect(spawns[0].opts).toMatchObject({ detached: true, stdio: "ignore" });
  });

  it("窗口内 pid 未出现 → 失败并提示看日志", () => {
    const { deps, sleeps } = makeDeps({ pidSequence: [null, null, null, null] });
    const r = startDaemonBackground(SPEC, deps);
    expect(r.started).toBe(false);
    expect("reason" in r && r.reason).toContain("daemon.log");
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
  });
});

describe("restartDaemonBackground", () => {
  it("有旧进程 → 先 kill 等退出再后台拉起", () => {
    const { deps, kills, spawns } = makeDeps({ pid: 4242, alive: [4242] });
    const r = restartDaemonBackground(SPEC, deps);
    expect(kills).toEqual([4242]);
    expect(spawns).toHaveLength(1);
    expect(r.started).toBe(true);
  });

  it("旧进程 kill 后仍存活 → 失败不 spawn", () => {
    const { deps, spawns } = makeDeps({ pid: 4242, alive: [4242] });
    deps.kill = () => {}; // kill 无效
    const r = restartDaemonBackground(SPEC, deps);
    expect(r.started).toBe(false);
    expect("reason" in r && r.reason).toContain("4242");
    expect(spawns).toHaveLength(0);
  });

  it("无旧进程 → 等价于 start", () => {
    const { deps, kills } = makeDeps({ pid: null });
    const r = restartDaemonBackground(SPEC, deps);
    expect(kills).toHaveLength(0);
    expect(r.started).toBe(true);
  });
});
