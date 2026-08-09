/**
 * TASK-06: sessions.json 注册表（架构 4.3）
 *
 * 崩溃恢复语义：
 * - 原子写：先写 <file>.tmp 再 rename，目标文件在任意时刻都是完整 JSON
 * - 读损坏：不抛异常、不带病运行；备份为 <file>.corrupt-<ts> 供人工恢复，返回空注册表
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SessionEntry {
  sessionId: string;
  tool: string;
  createdAt: number;
  lastActive: number;
}

/** sender → tool → 会话条目 */
export interface RegistryData {
  version: number;
  senders: Record<string, Record<string, SessionEntry>>;
}

export function emptyRegistry(): RegistryData {
  return { version: 1, senders: {} };
}

export function loadRegistry(path: string): RegistryData {
  if (!existsSync(path)) return emptyRegistry();
  const raw = readFileSync(path, "utf-8");
  try {
    const parsed = JSON.parse(raw) as RegistryData;
    if (!parsed || typeof parsed !== "object" || typeof parsed.senders !== "object" || parsed.senders === null) {
      throw new Error("结构非法");
    }
    return parsed;
  } catch {
    // 半写/损坏：保留现场备份，从空注册表重新开始（会话可重建，文件不可带病）
    renameSync(path, `${path}.corrupt-${Date.now()}`);
    return emptyRegistry();
  }
}

export function saveRegistry(path: string, data: RegistryData): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path); // POSIX/NTFS 上 rename 是原子的
}

/**
 * 查询/创建发件人在指定工具上的会话。
 * @param genId 仅在需要新建时调用（避免无谓生成）
 */
export function touchSession(
  reg: RegistryData,
  sender: string,
  tool: string,
  genId: () => string,
  now: number,
): { entry: SessionEntry; isNew: boolean } {
  const perTool = reg.senders[sender] ?? (reg.senders[sender] = {});
  const existing = perTool[tool];
  if (existing) {
    existing.lastActive = now;
    return { entry: existing, isNew: false };
  }
  const entry: SessionEntry = { sessionId: genId(), tool, createdAt: now, lastActive: now };
  perTool[tool] = entry;
  return { entry, isNew: true };
}

export function knownSenders(reg: RegistryData): Set<string> {
  return new Set(Object.keys(reg.senders));
}
