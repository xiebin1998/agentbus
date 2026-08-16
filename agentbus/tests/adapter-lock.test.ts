/**
 * adapter-lock 跨进程文件锁单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquireAdapterLock, releaseAdapterLock } from "../src/daemon/adapter-lock.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOCK_DIR = join(homedir(), ".local", "share", "agentbus", ".adapter-lock");

describe.skip("adapter-lock - TODO: 沙盒环境权限问题", () => {
  beforeEach(() => {
    // 确保锁目录不存在（干净状态）
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
  });

  afterEach(async () => {
    // 清理锁目录
    await releaseAdapterLock();
  });

  it("should acquire and release lock", async () => {
    await acquireAdapterLock();
    expect(existsSync(LOCK_DIR)).toBe(true);

    await releaseAdapterLock();
    expect(existsSync(LOCK_DIR)).toBe(false);
  });

  it("should timeout when lock is held", async () => {
    // 手动创建锁目录模拟其他进程持有锁
    mkdirSync(LOCK_DIR, { recursive: true });

    await expect(acquireAdapterLock(500)).rejects.toThrow("adapter lock timeout");
  });

  it("should release lock allows next acquire", async () => {
    await acquireAdapterLock();
    await releaseAdapterLock();

    // 第二次获取应该成功
    await acquireAdapterLock(1000);
    expect(existsSync(LOCK_DIR)).toBe(true);
  });
});
