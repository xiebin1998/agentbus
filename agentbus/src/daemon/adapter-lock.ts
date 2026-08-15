/**
 * 跨进程适配器级文件锁（kilo/opencode 全局 SQLite DB 串行化）
 *
 * kilo 和 opencode 共享全局 SQLite DB（~/.local/share/kilo/kilo.db /
 * ~/.local/share/opencode/opencode.db）。同机测试时多个 daemon 进程并发调用，
 * 多进程抢同一把 DB 写锁导致续接超时。
 *
 * 本模块基于 fs.mkdir 原子性实现跨进程互斥锁：
 * - mkdir 在目录已存在时抛 EEXIST，语义在所有平台上都是原子的
 * - 零外部依赖
 * - 带超时机制防止死锁
 * - 仅 kilo/opencode 族使用，其他工具不受影响
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** 锁目录路径（全局唯一，kilo/opencode 共用） */
const LOCK_DIR = join(homedir(), ".local", "share", "agentbus", ".adapter-lock");

/** 锁内 PID 文件 */
const PID_FILE = join(LOCK_DIR, "pid");

/** 确保锁的父目录存在 */
function ensureParentDir(): void {
  mkdirSync(dirname(LOCK_DIR), { recursive: true });
}

/** 轮询间隔（ms） */
const POLL_INTERVAL = 200;

/** 默认超时（ms） */
const DEFAULT_TIMEOUT = 600_000;

/** Stale 检测：锁存在超过此时长且持有进程已死，强制接管（ms） */
const STALE_THRESHOLD = 30_000;

/** 检查 pid 对应进程是否存活 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 尝试检测并接管 stale 锁（持有进程已死且超过阈值） */
function tryReapStaleLock(): boolean {
  try {
    if (!existsSync(PID_FILE)) return false;
    const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (isProcessAlive(pid)) return false;
    // 进程已死：检查锁年龄
    const st = statSync(LOCK_DIR);
    if (Date.now() - st.mtimeMs < STALE_THRESHOLD) return false;
    // Stale：强制接管
    rmSync(LOCK_DIR, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 非阻塞尝试获取锁：锁空闲则获取并返回 true；已被占用则立即返回 false（不排队等待）
 * 用于并发场景：正在处理消息时新请求直接拒绝，返回"对方正忙"
 */
export async function tryAcquireAdapterLock(): Promise<boolean> {
  ensureParentDir();
  // 先尝试接管 stale 锁
  tryReapStaleLock();
  try {
    mkdirSync(LOCK_DIR, { recursive: false });
    try { writeFileSync(PID_FILE, String(process.pid)); } catch { /* best effort */ }
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") return false; // 锁被占用
    throw e; // 其他错误正常抛出
  }
}

/**
 * 获取跨进程适配器锁（阻塞等待直到获取成功或超时）
 * @param timeoutMs 最大等待时间，默认 600s
 */
export async function acquireAdapterLock(timeoutMs: number = DEFAULT_TIMEOUT): Promise<void> {
  ensureParentDir();
  const start = Date.now();
  const myPid = process.pid;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(LOCK_DIR, { recursive: false });
      // 获取锁成功：写入 PID
      try { writeFileSync(PID_FILE, String(myPid)); } catch { /* best effort */ }
      return;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e; // 非锁竞争错误直接抛出
      // 尝试接管 stale 锁
      if (tryReapStaleLock()) continue;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`adapter lock timeout after ${timeoutMs}ms`);
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }
}

/**
 * 释放跨进程适配器锁
 */
export async function releaseAdapterLock(): Promise<void> {
  try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}
