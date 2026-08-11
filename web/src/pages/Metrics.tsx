import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2, RefreshCw, Users } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Table, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { api, AgentEntry, DaemonEntry, MetricSummary, MetricsPayload } from "@/lib/api";
import { useNs } from "@/context/NsContext";
import { useToast } from "@/components/Toaster";
import { formatTime } from "@/lib/utils";

const REFRESH_MS = 5000;

export function Metrics() {
  const { current, options } = useNs();
  const { toast } = useToast();

  const [payload, setPayload] = useState<MetricsPayload | null>(null);
  const [summary, setSummary] = useState<MetricSummary | null>(null);
  const [agents, setAgents] = useState<AgentEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      const [m, s, a] = await Promise.all([
        api.metrics(current), api.metricsSummary(current), api.agents(current),
      ]);
      setPayload(m);
      setSummary(s);
      setAgents(a.agents);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载失败", false);
    } finally {
      setLoading(false);
    }
  }, [current, toast]);

  useEffect(() => {
    if (!current) return;
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [current, load]);

  const daemonRows = Object.entries(payload?.daemons ?? {});
  const totals = summary?.totals;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <CardTitle>指标</CardTitle>
            {current && <Badge variant="secondary">{current}</Badge>}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            每 {REFRESH_MS / 1000}s 自动刷新
            <Button variant="ghost" size="icon" onClick={() => void load()} title="立即刷新" disabled={!current}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!current ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {options.length === 0 ? "当前账号未绑定任何命名空间" : "请在顶栏选择一个具体命名空间查看指标"}
            </p>
          ) : loading && !payload ? (
            <div className="flex items-center gap-2 text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="注入成功" value={totals?.injected_ok ?? 0} />
              <StatCard label="注入失败" value={totals?.injected_fail ?? 0} tone="danger" />
              <StatCard label="去重 / 丢弃" value={`${totals?.deduped ?? 0} / ${totals?.dropped ?? 0}`} />
              <StatCard label="队列积压" value={totals?.queued ?? 0} />
              <StatCard label="Daemon 数" value={summary?.daemon_count ?? 0} />
              <StatCard label="发送方数" value={summary?.total_senders ?? 0} />
              <StatCard label="在线 Agent" value={payload?.overview.online_agents.length ?? 0} />
              <StatCard label="已注册 Agent" value={payload?.overview.registered_agents.length ?? 0} />
            </div>
          )}
        </CardContent>
      </Card>

      {current && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />Daemon 明细
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Daemon ID</TH><TH className="text-right">注入成功</TH><TH className="text-right">注入失败</TH>
                  <TH className="text-right">丢弃</TH><TH className="text-right">去重</TH><TH className="text-right">积压</TH>
                  <TH className="text-right">发送方</TH><TH className="text-right">上报次数</TH><TH>最近上报</TH>
                </TR>
              </THead>
              <TBody>
                {daemonRows.length === 0 && (
                  <TR><TD colSpan={9} className="text-center text-muted-foreground py-6">该命名空间暂无 daemon 上报</TD></TR>
                )}
                {daemonRows.map(([id, d]) => <DaemonRow key={id} id={id} d={d} />)}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {current && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />Agent 明细
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Agent ID</TH><TH>名称</TH><TH>能力</TH><TH>注册状态</TH>
                  <TH>在线状态</TH><TH>最近上报</TH>
                </TR>
              </THead>
              <TBody>
                {(agents ?? []).length === 0 && (
                  <TR><TD colSpan={6} className="text-center text-muted-foreground py-6">该命名空间暂无 Agent（注册/在线/上报均无记录）</TD></TR>
                )}
                {(agents ?? []).map((a) => <AgentRow key={a.client_id} a={a} />)}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number | string; tone?: "danger" }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "danger" && value !== 0 ? "text-destructive" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function DaemonRow({ id, d }: { id: string; d: DaemonEntry }) {
  const m = d.metrics ?? {};
  return (
    <TR>
      <TD className="font-medium">{id}</TD>
      <TD className="text-right tabular-nums">{m.injected_ok ?? 0}</TD>
      <TD className="text-right tabular-nums">{m.injected_fail ?? 0}</TD>
      <TD className="text-right tabular-nums">{m.dropped ?? 0}</TD>
      <TD className="text-right tabular-nums">{m.deduped ?? 0}</TD>
      <TD className="text-right tabular-nums">{m.queued ?? 0}</TD>
      <TD className="text-right tabular-nums">{m.senders ?? 0}</TD>
      <TD className="text-right tabular-nums">{d.report_count ?? 0}</TD>
      <TD>
        {d.last_seen ? (
          <Badge variant="success">{formatTime(d.last_seen)}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TD>
    </TR>
  );
}

function AgentRow({ a }: { a: AgentEntry }) {
  return (
    <TR>
      <TD className="font-medium">{a.client_id}</TD>
      <TD>
        <div>{a.name ?? <span className="text-muted-foreground">-</span>}</div>
        {a.description && <div className="text-xs text-muted-foreground">{a.description}</div>}
      </TD>
      <TD>
        <div className="flex flex-wrap gap-1">
          {a.capabilities.length === 0 && <span className="text-muted-foreground">-</span>}
          {a.capabilities.map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
        </div>
      </TD>
      <TD>{a.registered ? <Badge variant="success">已注册</Badge> : <Badge variant="secondary">未注册</Badge>}</TD>
      <TD>{a.online ? <Badge variant="success">在线</Badge> : <Badge variant="secondary">离线</Badge>}</TD>
      <TD>
        {a.last_seen ? (
          <Badge variant="success">{formatTime(a.last_seen)}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TD>
    </TR>
  );
}
