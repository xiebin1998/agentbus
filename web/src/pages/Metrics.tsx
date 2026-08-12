import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, RefreshCw, Trash2, Users } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  ConfirmDialog,
  Input, Label, Modal,
  Table, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { api, AgentEntry, MetricsPayload } from "@/lib/api";
import { useNs } from "@/context/NsContext";
import { useToast } from "@/components/Toaster";

const REFRESH_MS = 5000;
/** 名称上限（与后端 AGENT_NAME_MAX 对齐） */
const NAME_MAX = 50;

export function Metrics() {
  const { current, options } = useNs();
  const { toast } = useToast();

  const [payload, setPayload] = useState<MetricsPayload | null>(null);
  const [agents, setAgents] = useState<AgentEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<AgentEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      const [m, a] = await Promise.all([
        api.metrics(current), api.agents(current),
      ]);
      setPayload(m);
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
              <Users className="h-4 w-4 text-primary" />Agent 明细
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Agent ID</TH><TH>名称</TH><TH>能力</TH>
                  <TH>状态</TH><TH>操作</TH>
                </TR>
              </THead>
              <TBody>
                {(agents ?? []).length === 0 && (
                  <TR><TD colSpan={5} className="text-center text-muted-foreground py-6">该命名空间暂无 Agent</TD></TR>
                )}
                {(agents ?? []).map((a) => (
                  <AgentRow key={a.client_id} a={a} onEdit={() => setEditTarget(a)} onDelete={() => setDeleteTarget(a)} />
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* 编辑 Agent 档案弹窗 */}
      <EditAgentModal
        ns={current ?? ""}
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={async () => {
          setEditTarget(null);
          await load();
        }}
      />

      {/* 删除 Agent 档案 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={<>删除 Agent：<Badge variant="secondary">{deleteTarget?.client_id}</Badge></>}
        description={<p>将删除该 Agent 的档案。若该身份仍在线，下次上报会自动重建。</p>}
        confirmText="删除"
        busy={deleting}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void (async () => {
          if (!deleteTarget || !current) return;
          setDeleting(true);
          try {
            await api.deleteAgent(current, deleteTarget.client_id);
            toast(`Agent ${deleteTarget.client_id} 已删除`);
            setDeleteTarget(null);
            await load();
          } catch (e) {
            toast(e instanceof Error ? e.message : "删除失败", false);
          } finally {
            setDeleting(false);
          }
        })()}
      />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function AgentRow({ a, onEdit, onDelete }: { a: AgentEntry; onEdit: () => void; onDelete: () => void }) {
  return (
    <TR>
      <TD className="font-medium">{a.client_id}</TD>
      <TD>
        <div className="flex items-center gap-1.5">
          <span>{a.name ?? <span className="text-muted-foreground">-</span>}</span>
          {a.placeholder && <Badge variant="outline">待完善</Badge>}
        </div>
        {a.description && (
          <div className="text-xs text-muted-foreground max-w-[28ch] truncate" title={a.description}>
            {a.description}
          </div>
        )}
      </TD>
      <TD>
        <div className="flex flex-wrap gap-1">
          {a.capabilities.length === 0 && <span className="text-muted-foreground">-</span>}
          {a.capabilities.map((c) => <Badge key={c} variant="secondary">{c}</Badge>)}
        </div>
      </TD>
      <TD>
        <div className="flex items-center gap-1.5">
          {a.online
            ? <Badge variant="success">在线</Badge>
            : <Badge variant="secondary">离线</Badge>}
          {a.sse_connected && <Badge variant="outline">SSE</Badge>}
        </div>
      </TD>
      <TD>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />编辑
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />删除
          </Button>
        </div>
      </TD>
    </TR>
  );
}

/* 编辑 Agent 档案 */
function EditAgentModal({ ns, target, onClose, onSaved }: {
  ns: string;
  target: AgentEntry | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [caps, setCaps] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) {
      setName(target.name ?? "");
      setDescription(target.description ?? "");
      setCaps(target.capabilities.join(", "));
    }
  }, [target]);

  const nameTrimmed = name.trim();
  const overLimit = nameTrimmed.length > NAME_MAX;

  async function submit() {
    if (!target || overLimit) return;
    setBusy(true);
    try {
      await api.updateAgent(ns, target.client_id, {
        name: nameTrimmed,
        description: description.trim(),
        capabilities: caps.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      });
      toast(`Agent ${target.client_id} 档案已更新`);
      await onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败", false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!target} title={<>编辑 Agent：<Badge variant="secondary">{target?.client_id}</Badge></>} onClose={onClose}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="agent-name">名称</Label>
            <span className={`text-xs tabular-nums ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
              {nameTrimmed.length}/{NAME_MAX}
            </span>
          </div>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：支付助手"
            aria-invalid={overLimit}
          />
          {overLimit && <p className="text-xs text-destructive">名称须 ≤ {NAME_MAX} 字符</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-desc">描述</Label>
          <textarea
            id="agent-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="一句话说明这个 Agent 做什么"
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-caps">能力（逗号分隔）</Label>
          <Input
            id="agent-caps"
            value={caps}
            onChange={(e) => setCaps(e.target.value)}
            placeholder="如：代码评审, 接口联调"
          />
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
        <Button onClick={() => void submit()} disabled={busy || overLimit}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}保存
        </Button>
      </div>
    </Modal>
  );
}