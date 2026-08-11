// AgentBus 控制台 API v4 客户端（session cookie 鉴权，credentials: include）
export type Role = "super_admin" | "ns_admin" | "user";

export interface Me {
  username: string;
  role: Role;
  display_name: string;
  namespaces: string[];
}
export interface Namespace {
  id: string;
  name: string;
  description: string;
  /** 拥有者（创建时指定的 ns 管理员账号）；历史数据可能为 null */
  owner: string | null;
  /** 拥有者昵称（后端附带，可能为空串） */
  owner_display_name: string;
}
export interface Account {
  username: string;
  role: Role;
  display_name: string;
}
export interface ConnectCommand {
  broker: string;
  user: string;
  ns: string;
  /** 已选接入工具（空 = 客户端自动探测全部已装 AI CLI） */
  tools: string[];
  /** 可选工具清单（服务端白名单，渲染选择控件用） */
  tools_options: string[];
  template: string;
  /** 一键安装脚本（Windows PowerShell，无凭证裸下载） */
  install_ps1: string;
  /** 一键安装脚本（macOS / Linux，无凭证裸下载） */
  install_sh: string;
  /** 一行式完整命令（Windows PowerShell，预置环境变量，密码为 <密码> 占位） */
  install_cmd_ps1: string;
  /** 一行式完整命令（macOS / Linux，预置环境变量，密码为 <密码> 占位） */
  install_cmd_sh: string;
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
/** TASK-31：Agent 明细（注册信息 × 在线状态 × daemon 指标 三源合并） */
export interface AgentEntry {
  client_id: string;
  name: string | null;
  description: string | null;
  capabilities: string[];
  registered: boolean;
  online: boolean;
  last_seen: string | null;
  report_count: number;
  metrics: Partial<MetricTotals> & { senders?: number; uptime_s?: number };
  /** TASK-32：注册工具（config.tools 键列表） */
  tools: string[];
  /** TASK-32：注册时间（ISO；未注册为 null） */
  registered_at: string | null;
  /** TASK-32：档案归属账号（可能为空串） */
  owner: string;
  /** TASK-32：归属账号昵称（后端附带，可能为空串） */
  owner_display_name: string;
  /** TASK-32：占位行（注册上报前仅有身份，名称待完善） */
  placeholder: boolean;
}
export interface AgentsPayload {
  agents: AgentEntry[];
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
  updateNamespace: (ns: string, b: { name?: string; description?: string }) =>
    http<{ ok: boolean }>(`/api/console/namespaces/${encodeURIComponent(ns)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    }),

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
  searchAccounts: (q: string) =>
    http<Account[]>(`/api/console/accounts/search?q=${encodeURIComponent(q)}`),
  createAccount: (b: { username: string; password: string; ns?: string; display_name?: string }) =>
    http<{ ok: boolean }>("/api/console/accounts", json(b)),
  deleteAccount: (username: string) =>
    http<{ ok: boolean }>(`/api/console/accounts/${encodeURIComponent(username)}`, { method: "DELETE" }),
  updateAccount: (username: string, b: { display_name: string }) =>
    http<{ ok: boolean }>(`/api/console/accounts/${encodeURIComponent(username)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    }),
  setPassword: (username: string, password: string) =>
    http<{ ok: boolean }>(`/api/console/accounts/${encodeURIComponent(username)}/password`, json({ password })),

  connectCommand: (ns: string, tools?: string[]) => {
    const t = tools && tools.length > 0 ? `&tools=${encodeURIComponent(tools.join(","))}` : "";
    return http<ConnectCommand>(`/api/console/connect-command?ns=${encodeURIComponent(ns)}${t}`);
  },

  metrics: (ns: string) => http<MetricsPayload>(`/api/console/metrics?ns=${encodeURIComponent(ns)}`),
  metricsSummary: (ns: string) =>
    http<MetricSummary>(`/api/console/metrics/summary?ns=${encodeURIComponent(ns)}`),
  agents: (ns: string) => http<AgentsPayload>(`/api/console/agents?ns=${encodeURIComponent(ns)}`),
  /** TASK-32：编辑 Agent 档案（name/description/capabilities 直写 DB） */
  updateAgent: (ns: string, cid: string, patch: { name?: string; description?: string; capabilities?: string[] }) =>
    http<{ status: string; client_id: string }>(
      `/api/console/agents/${encodeURIComponent(cid)}?ns=${encodeURIComponent(ns)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    ),
  /** Plan 3 问题 4：删除 Agent 档案（DB 行 + 内存指标/注册态连带清除） */
  deleteAgent: (ns: string, cid: string) =>
    http<{ status: string; client_id: string }>(
      `/api/console/agents/${encodeURIComponent(cid)}?ns=${encodeURIComponent(ns)}`,
      { method: "DELETE" },
    ),
};
