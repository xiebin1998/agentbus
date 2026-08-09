/**
 * TASK-06: daemon.pid 生命周期 —— stale 检测与接管
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquirePidLock, isProcessAlive, releasePidLock } from "../src/daemon/pid.js";

let dir: string;
let pidFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentbus-pid-"));
  pidFile = join(dir, "daemon.pid");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isProcessAlive", () => {
  it("当前进程存活", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("不存在的 pid 判死", () => {
    expect(isProcessAlive(0x7ffffff0)).toBe(false); // 极大 pid，几乎不可能存在
  });
});

describe("acquirePidLock", () => {
  it("无 pid 文件 → 获取成功并写入自身 pid", () => {
    const result = acquirePidLock(pidFile);
    expect(result).toEqual({ acquired: true, staleTakenOver: null });
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
  });

  it("pid 文件指向活进程 → 拒绝获取（防双开）", () => {
    writeFileSync(pidFile, String(process.pid));
    const result = acquirePidLock(pidFile);
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.runningPid).toBe(process.pid);
  });

  it("stale pid（进程已死）→ 接管并记录旧 pid", () => {
    writeFileSync(pidFile, "4294967290"); // 几乎不可能存活的 pid
    const result = acquirePidLock(pidFile);
    expect(result).toEqual({ acquired: true, staleTakenOver: 4294967290 });
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
  });

  it("pid 文件内容损坏 → 按 stale 接管", () => {
    writeFileSync(pidFile, "not-a-number");
    const result = acquirePidLock(pidFile);
    expect(result.acquired).toBe(true);
  });
});

describe("releasePidLock", () => {
  it("pid 匹配才删除（不误删接管后的新锁）", () => {
    acquirePidLock(pidFile);
    releasePidLock(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("pid 不匹配时保留文件", () => {
    writeFileSync(pidFile, String(process.pid + 1));
    releasePidLock(pidFile);
    expect(existsSync(pidFile)).toBe(true);
  });
});
