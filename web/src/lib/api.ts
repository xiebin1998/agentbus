// AgentBus 控制台 API v4 客户端（session cookie 鉴权，credentials: include）
export type Role = "super_admin" | "ns_admin" | "user";

export interface Me {
  username: string;
  role: Role;
  namespaces: string[];
}
export interface Namespace {
  id: string;
  name: string;
  description: string;
}
export interface Account {
  username: string;
  role: Role;
}
export interface ConnectCommand {
  broker: string;
  user: string;
  ns: string;
  template: string;
  note: string;
}
export interface MetricTotals {
  injected_ok: number;
  injected_fail: number;
  dropped: number;
  deduped: number;
  queued: number;
}
export interface MetricSummary {
  daemon_count: number;
  totals: MetricTotals;
  total_senders: number;
}
export interface DaemonEntry {
  metrics?: Partial<MetricTotals> & { senders?: number; uptime_s?: number };
  report_count?: number;
  last_seen?: string;
}
export interface MetricsPayload {
  daemons: Record<string, DaemonEntry>;
  overview: { online_agents: string[]; registered_agents: string[]; total_messages: number };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (data && typeof data === "object" && "error" in data) {
      msg = String((data as Record<string, unknown>).error);
    }
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  login: (username: string, password: string) =>
    http<Me>("/api/auth/login", json({ username, password })),
  logout: () => http<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => http<Me>("/api/me"),

  listNamespaces: () => http<Namespace[]>("/api/console/namespaces"),
  createNamespace: (b: {
    id: string;
    name: string;
    description?: string;
    admin_username: string;
    admin_password: string;
  }) => http<{ ok: boolean }>("/api/console/namespaces", json(b)),
  deleteNamespace: (ns: string) =>
    http<{ ok: boolean }>(`/api/console/namespaces/${encodeURIComponent(ns)}`, { method: "DELETE" }),

  addMember: (ns: string, username: string) =>
    http<{ ok: boolean }>(
      `/api/console/namespaces/${encodeURIComponent(ns)}/members/${encodeURIComponent(username)}`,
      { method: "PUT" },
    ),
  removeMember: (ns: string, username: string) =>
    http<{ ok: boolean }>(
      `/api/console/namespaces/${encodeURIComponent(ns)}/members/${encodeURIComponent(username)}`,
      { method: "DELETE" },
    ),

  listAccounts: (ns?: string) =>
    http<Account[]>(`/api/console/accounts${ns ? `?ns=${encodeURIComponent(ns)}` : ""}`),
  createAccount: (b: { username: string; password: string; ns?: string }) =>
    http<{ ok: boolean }>("/api/console/accounts", json(b)),
  deleteAccount: (username: string) =>
    http<{ ok: boolean }>(`/api/console/accounts/${encodeURIComponent(username)}`, { method: "DELETE" }),
  setPassword: (username: string, password: string) =>
    http<{ ok: boolean }>(`/api/console/accounts/${encodeURIComponent(username)}/password`, json({ password })),

  connectCommand: (ns: string) =>
    http<ConnectCommand>(`/api/console/connect-command?ns=${encodeURIComponent(ns)}`),

  metrics: (ns: string) => http<MetricsPayload>(`/api/console/metrics?ns=${encodeURIComponent(ns)}`),
  metricsSummary: (ns: string) =>
    http<MetricSummary>(`/api/console/metrics/summary?ns=${encodeURIComponent(ns)}`),
};
