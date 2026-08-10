/**
 * TASK-27: ServeManager —— opencode serve 无头进程懒启动/健康探测/失败重拉（架构 5.4）
 *
 * 设计：daemon 侧按 binary+workspace 缓存 serve 进程；注入前 ensure() 返回服务 URL，
 * attach 回合直连；进程死亡/探测失败自动重拉；daemon stop 时统一回收。
 * spawn/probe 均依赖注入，测试不碰真实进程与网络。
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ServeManager, killServePort, listenersOnPort, makeDefaultSpawn, reclaimServePorts, windowsServeKill, type ServeHandle, type ServeSpawnSpec } from "../src/daemon/serve-manager.js";

/** 假 serve 子进程：stdout 可推数据、exit 可触发 */
function fakeHandle(): ServeHandle & { pushStdout(s: string): void; emitExit(code: number): void } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & { kill(sig?: string): boolean };
  child.kill = vi.fn(() => true);
  const handle = {
    stdout,
    stderr,
    child,
  } as unknown as ServeHandle;
  return Object.assign(handle, {
    pushStdout(s: string) {
      stdout.emit("data", Buffer.from(s, "utf-8"));
    },
    emitExit(code: number) {
      child.emit("exit", code);
    },
  });
}

function makeSpawn(handles: ReturnType<typeof fakeHandle>[]) {
  let i = 0;
  const spawn = vi.fn(async (_spec: ServeSpawnSpec) => handles[Math.min(i++, handles.length - 1)]! as ServeHandle);
  return spawn;
}

/** ensure 内部 await spawn 后才挂 stdout 监听：推数据前先让出微任务 */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("windowsServeKill（纯函数：taskkill 后固定端口无条件复查，TASK-27 实测残留修复）", () => {
  it("taskkill 成功且端口无监听：不额外杀", () => {
    const calls: string[] = [];
    windowsServeKill({
      pid: 123,
      port: 4599,
      runTaskkill: () => { calls.push("taskkill"); return true; },
      listenersOf: () => { calls.push("listeners"); return []; },
      killPid: () => { calls.push("killPid"); },
    });
    expect(calls).toEqual(["taskkill", "listeners"]);
  });

  it("taskkill 成功但端口仍被占（套壳孙进程残留）：按端口补杀", () => {
    const killed: number[] = [];
    windowsServeKill({
      pid: 123,
      port: 4599,
      runTaskkill: () => true,
      listenersOf: () => [789],
      killPid: (pid: number) => { killed.push(pid); },
    });
    expect(killed).toEqual([789]);
  });

  it("taskkill 失败：按端口找监听进程并杀", () => {
    const killed: number[] = [];
    windowsServeKill({
      pid: 123,
      port: 4599,
      runTaskkill: () => false,
      listenersOf: () => [789],
      killPid: (pid: number) => { killed.push(pid); },
    });
    expect(killed).toEqual([789]);
  });

  it("随机端口（port=0）：无端口可查，仅 taskkill", () => {
    const calls: string[] = [];
    windowsServeKill({
      pid: 123,
      port: 0,
      runTaskkill: () => { calls.push("taskkill"); return false; },
      listenersOf: () => { calls.push("listeners"); return [789]; },
      killPid: () => { calls.push("killPid"); },
    });
    expect(calls).toEqual(["taskkill"]);
  });

  it("无 pid 且无监听：静默无事发生", () => {
    const calls: string[] = [];
    windowsServeKill({
      pid: undefined,
      port: 4599,
      runTaskkill: () => { calls.push("taskkill"); return true; },
      listenersOf: () => { calls.push("listeners"); return []; },
      killPid: () => { calls.push("killPid"); },
    });
    expect(calls).toEqual(["listeners"]);
  });

  it("监听查询抛错（netstat 受限）：通知 onPortCheckFailed 且不抛", () => {
    const warned: Array<[number, string]> = [];
    const killed: number[] = [];
    windowsServeKill({
      pid: 123,
      port: 4599,
      runTaskkill: () => true,
      listenersOf: () => { throw new Error("拒绝访问"); },
      killPid: (pid: number) => { killed.push(pid); },
      onPortCheckFailed: (port: number, e: Error) => { warned.push([port, e.message]); },
    });
    expect(warned).toEqual([[4599, "拒绝访问"]]);
    expect(killed).toEqual([]);
  });

  it("监听查询抛错且无回调：静默不抛（向后兼容）", () => {
    expect(() =>
      windowsServeKill({
        pid: 123,
        port: 4599,
        runTaskkill: () => true,
        listenersOf: () => { throw new Error("拒绝访问"); },
        killPid: () => {},
      }),
    ).not.toThrow();
  });
});

describe("listenersOnPort（netstat 输出解析，exec 注入不碰真实命令）", () => {
  const NETSTAT_SAMPLE = [
    "活动连接",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       992",
    "  TCP    127.0.0.1:4599         0.0.0.0:0              LISTENING       27512",
    "  TCP    [::]:4599              [::]:0                 LISTENING       27512",
    "  TCP    127.0.0.1:50000        127.0.0.1:4599         ESTABLISHED     30000",
  ].join("\n");

  it("解析 LISTENING 行按本地端口匹配并去重", () => {
    expect(listenersOnPort(4599, () => NETSTAT_SAMPLE)).toEqual([27512]);
  });

  it("无匹配端口：空数组", () => {
    expect(listenersOnPort(4600, () => NETSTAT_SAMPLE)).toEqual([]);
  });

  it("exec 失败且无回退：抛错不吞（调用方决定兜底路径）", () => {
    expect(() =>
      listenersOnPort(4599, () => { throw new Error("拒绝访问"); }, () => { throw new Error("pwsh 不可用"); }),
    ).toThrow("拒绝访问");
  });

  it("netstat 失败后走 PowerShell 回退路径（TASK-27 实测 sandbox 内 netstat 被拒）", () => {
    const psOut = [
      "LocalPort OwningProcess",
      "--------- -------------",
      "     4599         27512",
    ].join("\n");
    const pids = listenersOnPort(
      4599,
      () => { throw new Error("NETSTAT.EXE failed to run: 拒绝访问"); },
      () => psOut,
    );
    expect(pids).toEqual([27512]);
  });

  it("netstat 与 PowerShell 都失败：抛 netstat 原错", () => {
    expect(() =>
      listenersOnPort(
        4599,
        () => { throw new Error("netstat 拒绝访问"); },
        () => { throw new Error("pwsh 不可用"); },
      ),
    ).toThrow();
  });
});

describe("reclaimServePorts（daemon stop 后按 config 定向回收孤儿 serve：Windows SIGTERM 实测为强杀，优雅回收不会运行）", () => {
  it("只挑 serve=true 且 serve_port>0 的工具，逐端口回调 kill", () => {
    const ports: number[] = [];
    reclaimServePorts(
      {
        opencode: { serve: true, serve_port: 4599 },
        other: { serve: true, serve_port: 0 },
        cold: { workspace: "x" },
        broken: { serve: true, serve_port: "4599" },
      },
      (p) => ports.push(p),
    );
    expect(ports).toEqual([4599]);
  });

  it("tools 缺失/空：不回调", () => {
    const ports: number[] = [];
    reclaimServePorts(undefined, (p) => ports.push(p));
    reclaimServePorts({}, (p) => ports.push(p));
    expect(ports).toEqual([]);
  });
});

describe("killServePort（无 daemon pid 上下文：纯按端口查监听并杀，deps 注入）", () => {
  it("端口有监听：逐个 killPid", () => {
    const killed: number[] = [];
    killServePort(4599, { listenersOf: () => [111, 222], killPid: (p) => killed.push(p) });
    expect(killed).toEqual([111, 222]);
  });

  it("监听查询失败：走 warn 不抛", () => {
    const warned: string[] = [];
    killServePort(4599, {
      listenersOf: () => { throw new Error("拒绝访问"); },
      warn: (m) => warned.push(m),
    });
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain("4599");
  });
});

describe("makeDefaultSpawn（真实子进程：Windows 裸名解析 + stderr 收集）", () => {
  it("spawn 裸名 node 并从 stderr 收到服务地址行", async () => {
    const spawnFn = makeDefaultSpawn();
    const h = await spawnFn({
      cmd: "node",
      args: ["-e", "console.error('opencode server listening on http://127.0.0.1:4599')"],
      cwd: process.cwd(),
    });
    const text = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("stderr 超时")), 10_000);
      h.stderr.on("data", (c: Buffer) => {
        buf += c.toString("utf-8");
        clearTimeout(timer);
        resolve(buf);
      });
    });
    expect(text).toContain("http://127.0.0.1:4599");
    h.child.kill();
  });
});

describe("ServeManager", () => {
  it("ensure：从 stdout 解析服务 URL 并返回", async () => {
    const h = fakeHandle();
    const mgr = new ServeManager({ spawn: makeSpawn([h]), probe: async () => true });
    const p = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h.pushStdout("opencode server listening on http://127.0.0.1:4096\n");
    await expect(p).resolves.toBe("http://127.0.0.1:4096");
  });

  it("ensure：stderr 中解析服务 URL（实测 opencode serve 地址打在 stderr）", async () => {
    const h = fakeHandle();
    const mgr = new ServeManager({ spawn: makeSpawn([h]), probe: async () => true });
    const p = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4599 });
    await tick();
    h.stderr.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:4599\n", "utf-8"));
    await expect(p).resolves.toBe("http://127.0.0.1:4599");
  });

  it("ensure：同 key 二次调用复用已就绪进程（不再 spawn）", async () => {
    const h = fakeHandle();
    const spawn = makeSpawn([h]);
    const mgr = new ServeManager({ spawn, probe: async () => true });
    const p1 = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h.pushStdout("listening on http://127.0.0.1:4096\n");
    await p1;
    await expect(mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 })).resolves.toBe("http://127.0.0.1:4096");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("ensure：启动窗口内进程退出 → 抛错且不残留（下次重新拉起）", async () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const spawn = makeSpawn([h1, h2]);
    const mgr = new ServeManager({ spawn, probe: async () => true, readyTimeoutMs: 5000 });
    const p1 = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h1.emitExit(1);
    await expect(p1).rejects.toThrow(/serve/);
    // 第二次 ensure 重新 spawn
    const p2 = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h2.pushStdout("listening on http://127.0.0.1:5000\n");
    await expect(p2).resolves.toBe("http://127.0.0.1:5000");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("ensure：就绪后进程退出，下次 ensure 探测失败 → 自动重拉", async () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const spawn = makeSpawn([h1, h2]);
    const mgr = new ServeManager({ spawn, probe: async () => true });
    const p1 = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h1.pushStdout("listening on http://127.0.0.1:4096\n");
    await p1;
    h1.emitExit(0); // serve 进程死亡
    const p2 = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h2.pushStdout("listening on http://127.0.0.1:4097\n");
    await expect(p2).resolves.toBe("http://127.0.0.1:4097");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("ensure：已就绪但探测失败（僵死）→ kill 后重拉", async () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const spawn = makeSpawn([h1, h2]);
    let probeCount = 0;
    const probe = vi.fn(async () => ++probeCount > 1); // 第一次探测失败，重拉后成功
    const mgr = new ServeManager({ spawn, probe });
    const p1 = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h1.pushStdout("listening on http://127.0.0.1:4096\n");
    await p1;
    const p2 = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h2.pushStdout("listening on http://127.0.0.1:4098\n");
    await expect(p2).resolves.toBe("http://127.0.0.1:4098");
    expect(h1.child.kill).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("stopAll：kill 所有存活 serve 进程并清空缓存", async () => {
    const h = fakeHandle();
    const mgr = new ServeManager({ spawn: makeSpawn([h]), probe: async () => true });
    const p = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4096 });
    await tick();
    h.pushStdout("listening on http://127.0.0.1:4096\n");
    await p;
    mgr.stopAll();
    expect(h.child.kill).toHaveBeenCalled();
  });

  it("spawn 参数：serve 子命令 + 固定端口 + workspace 作为 cwd", async () => {
    const h = fakeHandle();
    const spawn = makeSpawn([h]);
    const mgr = new ServeManager({ spawn, probe: async () => true });
    const p = mgr.ensure({ binary: "opencode", workspace: "/ws", port: 4321 });
    await tick();
    h.pushStdout("listening on http://127.0.0.1:4321\n");
    await p;
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "opencode",
        args: ["serve", "--port", "4321", "--hostname", "127.0.0.1"],
        cwd: "/ws",
      }),
    );
  });
});
