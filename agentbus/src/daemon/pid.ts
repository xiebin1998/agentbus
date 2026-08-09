/**
 * TASK-06: daemon.pid 生命周期（防双开 + stale 接管）
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** 进程存活探测：signal 0 不真正发信号；EPERM 视为存在 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type PidLockResult =
  | { acquired: true; staleTakenOver: number | null }
  | { acquired: false; runningPid: number };

/**
 * 获取 pid 锁：
 * - 无文件 → 写入自身 pid
 * - 文件指向活进程 → 拒绝（防双开）
 * - stale（进程已死/内容损坏）→ 接管，staleTakenOver 记录旧 pid（损坏时为 null 以外的原值解析失败返 0）
 */
export function acquirePidLock(pidFile: string): PidLockResult {
  if (existsSync(pidFile)) {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const oldPid = Number.parseInt(raw, 10);
    if (Number.isInteger(oldPid) && oldPid > 0 && isProcessAlive(oldPid)) {
      return { acquired: false, runningPid: oldPid };
    }
    // stale：接管
    writeFileSync(pidFile, String(process.pid), "utf-8");
    return { acquired: true, staleTakenOver: Number.isInteger(oldPid) && oldPid > 0 ? oldPid : 0 };
  }
  writeFileSync(pidFile, String(process.pid), "utf-8");
  return { acquired: true, staleTakenOver: null };
}

/** 仅当 pid 文件记录的是自身时才删除（防止误删接管后的新锁） */
export function releasePidLock(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const raw = readFileSync(pidFile, "utf-8").trim();
  if (raw === String(process.pid)) {
    unlinkSync(pidFile);
  }
}
