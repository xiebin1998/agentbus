/**
 * TASK-32 Task 8: daemon 同伴快照同步（架构：.agentbus/agents.json 为全系统 Agent 快照）
 *
 * 随指标周期 GET {hub}/api/agent/snapshot?ns=..（Basic=broker 凭证，同 init 注册上报）
 * → 原子写 workDir/agents.json（tmp+rename）；任何失败静默保留旧文件（快照是缓存，不是事实源）。
 */
import { renameSync, writeFileSync } from "node:fs";
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
