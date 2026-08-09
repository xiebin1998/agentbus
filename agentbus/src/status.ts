/**
 * TASK-12: status 状态摘要（架构 6.1 —— daemon 状态 + 会话注册表摘要）
 * 只读操作；sessions.json 损坏时降级为空摘要（与 registry 的容错策略一致）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "./daemon/pid.js";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  /** pid 文件存在但进程不在 */
  stale?: boolean;
}

export function readDaemonStatus(workDir: string): DaemonStatus {
  let raw: string;
  try {
    raw = readFileSync(join(workDir, "daemon.pid"), "utf-8").trim();
  } catch {
    return { running: false };
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    return { running: true, pid };
  }
  return { running: false, stale: true };
}

export interface SessionsSummary {
  senderCount: number;
  senders: string[];
}

export function readSessionsSummary(workDir: string): SessionsSummary {
  try {
    const data = JSON.parse(readFileSync(join(workDir, "sessions.json"), "utf-8")) as {
      senders?: Record<string, unknown>;
    };
    const senders = data.senders && typeof data.senders === "object" ? Object.keys(data.senders) : [];
    return { senderCount: senders.length, senders };
  } catch {
    return { senderCount: 0, senders: [] };
  }
}
