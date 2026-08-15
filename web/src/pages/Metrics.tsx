import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowRight, Clock, Loader2, Pencil, RefreshCw, Trash2, Users } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle,
  ConfirmDialog,
  Input, Label, Modal,
  Table, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { api, AgentEntry, GraphEdge, GraphNode, MetricsPayload } from "@/lib/api";
import { useNs } from "@/context/NsContext";
import { useToast } from "@/components/Toaster";

const REFRESH_MS = 5000;
/** 名称上限（与后端 AGENT_NAME_MAX 对齐） */
const NAME_MAX = 50;
/** 图谱高度 */
const GRAPH_HEIGHT = 400;

// ─── 图谱：横向布局 + 拖拽 ───────────────────────────────────────────────────

interface NodePosition { x: number; y: number }

/** 横向分层布局：有连线的节点尽量靠近，无连线的均匀散布 */
function layoutHorizontal(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
  if (nodes.length === 0) return positions;
  if (nodes.length === 1) {
    positions.set(nodes[0].id, { x: width / 2, y: height / 2 });
    return positions;
  }

  // BFS 分层：以第一个节点为根
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    adj.get(e.agents[0])?.add(e.agents[1]);
    adj.get(e.agents[1])?.add(e.agents[0]);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [nodes[0].id];
  depth.set(nodes[0].id, 0);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) ?? []) {
      if (!depth.has(nb)) { depth.set(nb, depth.get(cur)! + 1); queue.push(nb); }
    }
  }
  // 未连通的孤立节点统一放最后一层
  const maxDepth = Math.max(0, ...[...depth.values()]);
  for (const n of nodes) { if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1); }
  const finalMax = Math.max(0, ...[...depth.values()]);

  // 按层分组
  const layers: GraphNode[][] = [];
  for (let d = 0; d <= finalMax; d++) layers.push([]);
  for (const n of nodes) layers[depth.get(n.id)!].push(n);

  const numLayers = layers.length;
  const padX = 80, padY = 50;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;
  const layerGap = numLayers > 1 ? usableW / (numLayers - 1) : 0;

  for (let li = 0; li < numLayers; li++) {
    const layer = layers[li];
    const x = numLayers > 1 ? padX + li * layerGap : width / 2;
    const nodeGap = layer.length > 1 ? usableH / (layer.length - 1) : 0;
    const startY = layer.length > 1 ? padY : height / 2;
    for (let ni = 0; ni < layer.length; ni++) {
      const y = layer.length > 1 ? startY + ni * nodeGap : startY;
      positions.set(layer[ni].id, { x, y });
    }
  }
  return positions;
}

function displayName(node: GraphNode): string {
  return node.name || node.id.split("/").pop() || node.id;
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export function Metrics() {
  const { current, options } = useNs();
  const { toast } = useToast();

  const [payload, setPayload] = useState<MetricsPayload | null>(null);
  const [agents, setAgents] = useState<AgentEntry[] | null>(null);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState<AgentEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [windowHours, setWindowHours] = useState(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dims, setDims] = useState({ w: 800, h: GRAPH_HEIGHT });

  // 响应式宽度
  useEffect(() => {
    const update = () => {
      if (containerRef.current) {
        setDims({ w: Math.max(containerRef.current.clientWidth - 32, 300), h: GRAPH_HEIGHT });
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // 图谱位置（支持拖拽覆盖）
  const [posOverrides, setPosOverrides] = useState<Map<string, NodePosition>>(new Map());
  const basePositions = layoutHorizontal(graphNodes, graphEdges, dims.w, dims.h);
  // 合并：拖拽覆盖 > 初始布局
  const positions = new Map(basePositions);
  for (const [k, v] of posOverrides) positions.set(k, v);

  // 数据刷新时清除拖拽偏移（节点集合变了就重置）
  const prevNodeIds = useRef<string>("");
  useEffect(() => {
    const ids = graphNodes.map(n => n.id).sort().join(",");
    if (ids !== prevNodeIds.current) { prevNodeIds.current = ids; setPosOverrides(new Map()); }
  }, [graphNodes]);

  // ── 拖拽逻辑 ──
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);

  const onNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pos = positions.get(nodeId);
    if (!pos) return;
    dragRef.current = { nodeId, offsetX: mx - pos.x, offsetY: my - pos.y };
  }, [positions]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setPosOverrides(prev => {
        const next = new Map(prev);
        next.set(dragRef.current!.nodeId, { x: mx - dragRef.current!.offsetX, y: my - dragRef.current!.offsetY });
        return next;
      });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      const [m, a, g] = await Promise.all([
        api.metrics(current),
        api.agents(current),
        api.graph(current, windowHours),
      ]);
      setPayload(m);
      setAgents(a.agents);
      setGraphNodes(g.nodes);
      setGraphEdges(g.edges);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载失败", false);
    } finally {
      setLoading(false);
    }
  }, [current, windowHours, toast]);

  useEffect(() => {
    if (!current) return;
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [current, load]);

  const totalMessages = graphEdges.reduce((s, e) => s + Object.values(e.counts).reduce((a: number, b: number) => a + b, 0), 0);

  return (
    <div className="space-y-6">
      {/* 统计卡 */}
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
              <StatCard label="沟通连线" value={graphEdges.length} />
              <StatCard label="消息总数" value={totalMessages} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* 沟通图谱 */}
      {current && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />沟通图谱
            </CardTitle>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />{graphNodes.length} Agent
              </span>
              <span className="flex items-center gap-1">
                <ArrowRight className="h-3.5 w-3.5" />{totalMessages} 消息
              </span>
              <div className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                <select
                  value={windowHours}
                  onChange={(e) => setWindowHours(Number(e.target.value))}
                  className="rounded border bg-background px-1.5 py-0.5 text-xs"
                >
                  <option value={1}>1h</option>
                  <option value={6}>6h</option>
                  <option value={12}>12h</option>
                  <option value={24}>24h</option>
                </select>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {graphNodes.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">暂无 Agent，注册后将显示在图谱中</p>
            ) : (
              <div ref={containerRef} className="w-full">
                <svg ref={svgRef} width={dims.w} height={dims.h} className="overflow-visible select-none">
                  <defs>
                    {/* 发光滤镜 */}
                    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                  </defs>
                  {/* 边：贝塞尔曲线 */}
                  {graphEdges.map((edge, i) => {
                    const [fromId, toId] = edge.agents;
                    const from = positions.get(fromId);
                    const to = positions.get(toId);
                    if (!from || !to) return null;
                    const dx = to.x - from.x;
                    // 控制点偏移（横向布局用水平曲线）
                    const cx1 = from.x + dx * 0.4;
                    const cy1 = from.y;
                    const cx2 = to.x - dx * 0.4;
                    const cy2 = to.y;
                    const fwd = edge.counts[`${fromId}→${toId}`] ?? 0;
                    const rev = edge.counts[`${toId}→${fromId}`] ?? 0;
                    const sw = 1.5 + Math.min(Math.log2(fwd + rev + 1), 3);
                    const mx = (from.x + to.x) / 2;
                    const my = (from.y + to.y) / 2;
                    return (
                      <g key={`e-${i}`}>
                        <path
                          d={`M ${from.x} ${from.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${to.x} ${to.y}`}
                          fill="none"
                          stroke="hsl(var(--muted-foreground) / 0.2)"
                          strokeWidth={sw}
                          strokeLinecap="round"
                          className="transition-colors hover:stroke-primary/50"
                        />
                        {/* 消息数标签 */}
                        {(fwd > 0 || rev > 0) && (
                          <g transform={`translate(${mx}, ${my})`}>
                            <rect x={-26} y={-12} width={52} height={20} rx={10}
                              fill="hsl(var(--card))" className="stroke-border" strokeWidth={0.5} />
                            <text textAnchor="middle" dominantBaseline="middle" y={-2}
                              className="fill-foreground text-[10px] font-medium">
                              {fwd}↗ {rev}↙
                            </text>
                          </g>
                        )}
                      </g>
                    );
                  })}
                  {/* 节点：可拖拽 */}
                  {graphNodes.map((node) => {
                    const pos = positions.get(node.id);
                    if (!pos) return null;
                    const label = displayName(node);
                    const short = label.length > 6 ? label.slice(0, 5) + "…" : label;
                    return (
                      <g
                        key={node.id}
                        transform={`translate(${pos.x}, ${pos.y})`}
                        onMouseDown={(e) => onNodeMouseDown(e, node.id)}
                        style={{ cursor: "grab" }}
                      >
                        {/* 在线节点光晕 */}
                        {node.online && (
                          <circle r={26} fill="hsl(var(--primary) / 0.12)" />
                        )}
                        {/* 节点圆 */}
                        <circle
                          r={22}
                          fill={node.online ? "hsl(var(--primary))" : "hsl(var(--muted))"}
                          stroke={node.online ? "hsl(var(--primary) / 0.6)" : "hsl(var(--muted-foreground) / 0.3)"}
                          strokeWidth={2}
                          filter={node.online ? "url(#glow)" : undefined}
                        />
                        {/* 在线指示绿点 */}
                        {node.online && (
                          <circle r={5} cx={16} cy={-16}
                            fill="#22c55e" stroke="hsl(var(--card))" strokeWidth={2} />
                        )}
                        {/* 名称 */}
                        <text textAnchor="middle" dominantBaseline="middle"
                          fill={node.online ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))"}
                          className="text-[11px] font-semibold pointer-events-none">
                          {short}
                        </text>
                        {/* 名称标签（节点下方） */}
                        <text textAnchor="middle" y={36}
                          className="fill-foreground/70 text-[10px] pointer-events-none">
                          {label.length > 10 ? label.slice(0, 9) + "…" : label}
                        </text>
                        <title>{label} ({node.online ? "在线" : "离线"})</title>
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Agent 明细表 */}
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

// ─── 子组件 ───────────────────────────────────────────────────────────────────

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
          {a.capabilities.map((c: string) => <Badge key={c} variant="secondary">{c}</Badge>)}
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
