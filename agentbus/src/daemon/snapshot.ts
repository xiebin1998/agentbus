/**
 * TASK-32 Task 8: daemon 同伴快照同步（架构：.agentbus/agents.json 为全系统 Agent 快照）
 *
 * 随指标周期 GET {hub}/api/agent/snapshot?ns=..（Basic=broker 凭证，同 init 注册上报）
 * → 原子写 workDir/agents.json（tmp+rename）；任何失败静默保留旧文件（快照是缓存，不是事实源）。
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotSyncOptions {
  workDir: string;
  /** hub 派生源（与 init 同口径：sse_url 去路径取 origin） */
  sseUrl: string;
  ns: string;
  username?: string;
  password?: string;
  fetcher?: (url: string, init: { headers: Record<string, string> }) =>
    Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export interface SnapshotSyncResult {
  ok: boolean;
}

export async function syncAgentsSnapshot(opts: SnapshotSyncOptions): Promise<SnapshotSyncResult> {
  // 无凭证无法调 hub（dynsec 强制认证）：静默跳过，不碰文件
  if (!opts.username || !opts.password) return { ok: false };
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
    JSON.parse(body); // 非法 JSON 视同失败，旧文件保留
    // 原子写：tmp+rename，避免回合中途读到半截快照
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
 * Plan 3 问题 1：按 client_id 查快照里的 Agent 名称（会话标题用名称而非裸 ID）。
 * 快照是缓存不是事实源：文件缺失/损坏/未命中/名称非法一律 null，调用方回退 client_id。
 */
export function lookupAgentName(workDir: string, clientId: string): string | null {
  try {
    const raw = readFileSync(join(workDir, "agents.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const agents = (parsed as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) return null;
    for (const entry of agents) {
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

/** Agent 快照条目（list_agents 返回用） */
export interface AgentSnapshotEntry {
  client_id: string;
  name?: string;
  description?: string;
  online: boolean;
  tools?: string[];
}

/**
 * 从 agents.json 快照读取全量 Agent 列表（list_agents IPC 工具用）。
 * 快照是缓存：文件缺失/损坏返回空数组。
 */
/**
 * 从云端 hub 实时查询 Agent 列表（list_agents IPC 工具用）。
 * 这是事实源，本地 agents.json 只是缓存。
 */
export interface FetchAgentsOptions {
  sseUrl: string;
  ns: string;
  username?: string;
  password?: string;
  fetcher?: (url: string, init: { headers: Record<string, string> }) =>
    Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export async function fetchAgentsFromHub(opts: FetchAgentsOptions): Promise<AgentSnapshotEntry[]> {
  if (!opts.username || !opts.password) return [];
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
 * 从本地 agents.json 快照读取 Agent 列表（降级方案：云端不可达时使用）。
 */
export function listAgentsFromSnapshot(workDir: string): AgentSnapshotEntry[] {
  try {
    const raw = readFileSync(join(workDir, "agents.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
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
