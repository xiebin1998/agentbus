/**
 * TASK-32: Agent 列表查询（云端实时查询）
 *
 * Agent 列表和状态信息来源于云端 hub（/api/agent/snapshot API）。
 * 本地不存储 Agent 快照，只有自己的注册信息（config.json）。
 */

/**
 * TASK-32: Agent 列表查询（云端实时查询）
 *
 * Agent 列表和状态信息来源于云端 hub（/api/agent/snapshot API）。
 * 本地不存储 Agent 快照，只有自己的注册信息（config.json）。
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Agent 条目（list_agents 返回用） */
export interface AgentSnapshotEntry {
  client_id: string;
  name?: string;
  description?: string;
  online: boolean;
  tools?: string[];
}

/**
 * 从云端 hub 实时查询 Agent 列表（list_agents IPC 工具用）。
 */
export interface FetchAgentsOptions {
  sseUrl?: string;
  ns: string;
  username?: string;
  password?: string;
  fetcher?: (url: string, init: { headers: Record<string, string> }) =>
    Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export async function fetchAgentsFromHub(opts: FetchAgentsOptions): Promise<AgentSnapshotEntry[]> {
  if (!opts.username || !opts.password || !opts.sseUrl) return [];
  let hub: string;
  try {
    hub = new URL(opts.sseUrl).origin;
  } catch {
    return [];
  }
  const doFetch =
    opts.fetcher ??
    (async (url, init) => {
      const r = await globalThis.fetch(url, { method: "GET", headers: init.headers });
      return { ok: r.ok, status: r.status, text: () => r.text() };
    });
  try {
    const resp = await doFetch(`${hub}/api/agent/snapshot?ns=${encodeURIComponent(opts.ns)}`, {
      headers: {
        "Authorization": `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`,
      },
    });
    if (!resp.ok) return [];
    const body = await resp.text();
    const parsed: unknown = JSON.parse(body);
    const agents = (parsed as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) return [];
    const result: AgentSnapshotEntry[] = [];
    for (const entry of agents) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as {
        client_id?: unknown;
        name?: unknown;
        description?: unknown;
        online?: unknown;
        tools?: unknown;
      };
      if (typeof e.client_id !== "string" || !e.client_id.trim()) continue;
      result.push({
        client_id: e.client_id.trim(),
        ...(typeof e.name === "string" ? { name: e.name.trim() } : {}),
        ...(typeof e.description === "string" ? { description: e.description.trim() } : {}),
        online: e.online === true,
        ...(Array.isArray(e.tools) ? { tools: e.tools.filter((t): t is string => typeof t === "string") } : {}),
      });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * TASK-32: 快照同步 —— 从云端 hub 拉取 Agent 列表并原子写入 agents.json
 * 失败静默保留旧文件（不阻断 daemon 运行）
 */
export interface SyncSnapshotOptions {
  workDir: string;
  sseUrl?: string;
  ns: string;
  username?: string;
  password?: string;
  fetcher?: (url: string, init: { headers: Record<string, string> }) =>
    Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export async function syncAgentsSnapshot(opts: SyncSnapshotOptions): Promise<{ ok: boolean }> {
  if (!opts.username || !opts.password || !opts.sseUrl) return { ok: false };
  let hub: string;
  try {
    hub = new URL(opts.sseUrl).origin;
  } catch {
    return { ok: false };
  }
  const doFetch =
    opts.fetcher ??
    (async (url, init) => {
      const r = await globalThis.fetch(url, { method: "GET", headers: init.headers });
      return { ok: r.ok, status: r.status, text: () => r.text() };
    });
  try {
    const resp = await doFetch(`${hub}/api/agent/snapshot?ns=${encodeURIComponent(opts.ns)}`, {
      headers: {
        "Authorization": `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`,
      },
    });
    if (!resp.ok) return { ok: false };
    const body = await resp.text();
    const target = join(opts.workDir, "agents.json");
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, target);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 从本地 agents.json 查找指定 client_id 的档案名称。
 * 文件缺失/损坏/无此身份/名称为空 → 一律 null（调用方回退 client_id）。
 */
export function lookupAgentName(workDir: string, clientId: string): string | null {
  try {
    const raw = readFileSync(join(workDir, "agents.json"), "utf-8");
    const parsed = JSON.parse(raw) as { agents?: unknown[] };
    if (!Array.isArray(parsed.agents)) return null;
    for (const entry of parsed.agents) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { client_id?: unknown; name?: unknown };
      if (e.client_id === clientId && typeof e.name === "string" && e.name.trim()) {
        return e.name.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}
