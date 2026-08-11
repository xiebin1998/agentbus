import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Pencil, Trash2, Users, Loader2, Search } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, Input, Label, Modal,
  Table, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { api, Account, Namespace } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useNs } from "@/context/NsContext";
import { useToast } from "@/components/Toaster";

const EMPTY_FORM = { id: "", name: "", description: "", admin_username: "", admin_password: "" };

export function Namespaces() {
  const { me } = useAuth();
  const { refresh: refreshNs } = useNs();
  const { toast } = useToast();
  const isSuper = me?.role === "super_admin";

  const [list, setList] = useState<Namespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Namespace | null>(null);
  const [memberTarget, setMemberTarget] = useState<Namespace | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Namespace | null>(null);
  const [deleteMembers, setDeleteMembers] = useState<Account[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.listNamespaces());
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载失败", false);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // 管理权（与服务端 _can_manage_ns 对齐）：超管或 owner；历史 ns（owner 为空）回退旧规则
  const canManage = (n: Namespace) =>
    isSuper || n.owner === me?.username ||
    (n.owner == null && me?.role === "ns_admin" && (me?.namespaces ?? []).includes(n.id));

  // 删除前拉取成员清单，在确认弹窗展示影响面
  async function confirmDelete(n: Namespace) {
    setDeleteTarget(n);
    setDeleteMembers(null);
    try {
      setDeleteMembers(await api.listAccounts(n.id));
    } catch {
      setDeleteMembers([]);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.deleteNamespace(deleteTarget.id);
      toast(`已删除 ${deleteTarget.id}`);
      setDeleteTarget(null);
      await Promise.all([load(), refreshNs()]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", false);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>命名空间</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">ns 隔离由 broker ACL 强制；成员多对多绑定</span>
            {isSuper && (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />创建命名空间
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : (
            <Table>
              <THead>
                <TR><TH>ID</TH><TH>名称</TH><TH>拥有者</TH><TH>描述</TH><TH className="text-right">操作</TH></TR>
              </THead>
              <TBody>
                {list.length === 0 && (
                  <TR><TD colSpan={5} className="text-center text-muted-foreground py-6">暂无命名空间</TD></TR>
                )}
                {list.map((n) => (
                  <TR key={n.id}>
                    <TD className="font-medium">{n.id}</TD>
                    <TD>{n.name}</TD>
                    <TD>
                      {n.owner ? (
                        <span className="flex items-center gap-1.5">
                          <span>{n.owner_display_name || n.owner}</span>
                          {n.owner_display_name && <span className="text-xs text-muted-foreground">@{n.owner}</span>}
                          {n.owner === me?.username && <Badge variant="success">我</Badge>}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="text-muted-foreground">{n.description || "-"}</TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setMemberTarget(n)}>
                          <Users className="h-3.5 w-3.5" />成员
                        </Button>
                        {canManage(n) && (
                          <Button variant="outline" size="sm" onClick={() => setEditTarget(n)}>
                            <Pencil className="h-3.5 w-3.5" />编辑
                          </Button>
                        )}
                        {isSuper && (
                          <Button variant="destructive" size="sm" onClick={() => void confirmDelete(n)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 创建命名空间弹窗 */}
      <CreateNsModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await Promise.all([load(), refreshNs()]);
        }}
      />

      {/* 编辑命名空间弹窗（id 不可改） */}
      <EditNsModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={async () => {
          setEditTarget(null);
          await Promise.all([load(), refreshNs()]);
        }}
      />

      {/* 成员管理弹窗（非管理者只读） */}
      <MembersModal target={memberTarget} canManage={memberTarget ? canManage(memberTarget) : false} onClose={() => setMemberTarget(null)} />

      {/* 删除确认：展示受影响成员清单（账号保留，仅失去该 ns 访问权） */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除命名空间"
        description={
          <div className="space-y-2">
            <p>确认删除命名空间 <b>{deleteTarget?.id}</b>？将同时移除其 broker 组与角色。</p>
            {deleteMembers === null ? (
              <p className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在统计受影响成员…</p>
            ) : deleteMembers.length > 0 ? (
              <p>
                以下 <b>{deleteMembers.length}</b> 名成员将失去该命名空间访问权（账号本身保留）：
                <span className="mt-1 block">{deleteMembers.map((m) => m.username).join("、")}</span>
              </p>
            ) : (
              <p>该命名空间当前无成员。</p>
            )}
          </div>
        }
        confirmText="删除"
        busy={deleteBusy}
        onConfirm={() => void remove()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/* ── 创建命名空间（含 ns 管理员）── */
function CreateNsModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open]);

  async function submit() {
    if (!form.id || !form.admin_username || !form.admin_password) {
      toast("请填写 ns id、管理员账号与密码", false);
      return;
    }
    setBusy(true);
    try {
      await api.createNamespace(form);
      toast(`命名空间 ${form.id} 已创建`);
      await onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "创建失败", false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="创建命名空间" onClose={onClose} className="max-w-lg">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5"><Label>NS ID（创建后不可改）</Label>
          <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="pay" />
          <p className="text-xs text-muted-foreground">英文/数字开头，可含英文、数字、横杠（-）、下划线（_），不含 /</p></div>
        <div className="space-y-1.5"><Label>显示名称</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="支付" /></div>
        <div className="space-y-1.5 md:col-span-2"><Label>描述（可选）</Label>
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>管理员账号</Label>
          <Input value={form.admin_username} onChange={(e) => setForm({ ...form, admin_username: e.target.value })} placeholder="pay-admin" /></div>
        <div className="space-y-1.5"><Label>管理员密码</Label>
          <Input type="password" value={form.admin_password} onChange={(e) => setForm({ ...form, admin_password: e.target.value })} /></div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}创建
        </Button>
      </div>
    </Modal>
  );
}

/* ── 编辑命名空间（名称/描述；id 只读）── */
function EditNsModal({ target, onClose, onSaved }: {
  target: Namespace | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) {
      setName(target.name);
      setDescription(target.description);
    }
  }, [target]);

  async function submit() {
    if (!target) return;
    setBusy(true);
    try {
      await api.updateNamespace(target.id, { name, description });
      toast(`命名空间 ${target.id} 已更新`);
      await onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败", false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!target} title="编辑命名空间" onClose={onClose}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>NS ID（不可修改）</Label>
          <Input value={target?.id ?? ""} disabled />
        </div>
        <div className="space-y-1.5">
          <Label>显示名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>描述</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}保存
        </Button>
      </div>
    </Modal>
  );
}

/* ── 成员管理（检索账号 → 卡片展示 → 点 "+" 添加；检索不到可就地建号；非管理者只读）── */
function MembersModal({ target, canManage, onClose }: { target: Namespace | null; canManage: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [members, setMembers] = useState<Account[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Account[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  // 就地建号表单（检索无结果时展开）
  const [qcOpen, setQcOpen] = useState(false);
  const [qcPassword, setQcPassword] = useState("");
  const [qcDisplayName, setQcDisplayName] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMembers = useCallback(async (ns: string) => {
    try {
      setMembers(await api.listAccounts(ns));
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载成员失败", false);
    }
  }, [toast]);

  useEffect(() => {
    if (target) {
      setQuery("");
      setResults([]);
      setSearched(false);
      setQcOpen(false);
      setQcPassword("");
      setQcDisplayName("");
      void loadMembers(target.id);
    } else {
      setMembers([]);
    }
  }, [target, loadMembers]);

  // 输入防抖 300ms 检索账号（已存在成员不展示）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      setSearched(false);
      setQcOpen(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      api.searchAccounts(q)
        .then((hits) => {
          const joined = new Set(members.map((m) => m.username));
          setResults(hits.filter((h) => !joined.has(h.username)));
          setSearched(true);
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, members]);

  async function addMember(username: string) {
    if (!target) return;
    setBusy(true);
    try {
      await api.addMember(target.id, username);
      toast(`已将 ${username} 加入 ${target.id}`);
      setQuery("");
      setResults([]);
      await loadMembers(target.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加入失败", false);
    } finally {
      setBusy(false);
    }
  }

  // 检索无结果：就地创建普通账号并直接入组
  async function quickCreate() {
    if (!target) return;
    const username = query.trim();
    if (!qcPassword) {
      toast("请设置新账号密码", false);
      return;
    }
    setBusy(true);
    try {
      await api.createAccount({ username, password: qcPassword, display_name: qcDisplayName.trim(), ns: target.id });
      toast(`已创建 ${username} 并加入 ${target.id}`);
      setQuery("");
      setQcOpen(false);
      setQcPassword("");
      setQcDisplayName("");
      await loadMembers(target.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "创建失败", false);
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(username: string) {
    if (!target) return;
    try {
      await api.removeMember(target.id, username);
      toast(`已将 ${username} 移出 ${target.id}`);
      await loadMembers(target.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "移出失败", false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={<>成员管理：<Badge variant="secondary">{target?.id}</Badge></>}
      onClose={onClose}
      className="max-w-lg"
    >
      <div className="space-y-1.5">
        {canManage ? (
          <>
            <Label>检索账号</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="输入用户名/昵称检索，确认后点 + 添加"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">你只是该命名空间的成员，仅可查看名单，增删由拥有者/超管操作。</p>
        )}
        {canManage && query.trim() && (
          <div className="mt-2 space-y-1.5">
            {searching ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />检索中…
              </div>
            ) : results.length === 0 ? (
              searched ? (
                <div className="rounded-md border border-dashed p-3 space-y-2">
                  <p className="text-sm text-muted-foreground">未找到可添加的账号（不存在或已是成员）。</p>
                  {!qcOpen ? (
                    <Button variant="outline" size="sm" onClick={() => setQcOpen(true)}>
                      <Plus className="h-3.5 w-3.5" />创建“{query.trim()}”并加入
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">用户名</Label>
                        <Input value={query.trim()} disabled />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">初始密码</Label>
                        <Input type="password" value={qcPassword} onChange={(e) => setQcPassword(e.target.value)} placeholder="设置密码" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">昵称（可选，真实姓名）</Label>
                        <Input value={qcDisplayName} onChange={(e) => setQcDisplayName(e.target.value)} placeholder="如：张三" />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setQcOpen(false)}>取消</Button>
                        <Button size="sm" disabled={busy} onClick={() => void quickCreate()}>
                          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}创建并加入
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null
            ) : (
              results.map((a) => (
                <div key={a.username} className="flex items-center justify-between rounded-md border bg-background/50 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{a.username}</span>
                    {a.display_name && <span className="text-xs text-muted-foreground">{a.display_name}</span>}
                    <Badge variant={a.role === "super_admin" ? "default" : a.role === "ns_admin" ? "success" : "secondary"}>
                      {a.role}
                    </Badge>
                  </div>
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => void addMember(a.username)} disabled={busy} title={`将 ${a.username} 加入`}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="mt-4">
        <Table>
          <THead><TR><TH>账号</TH><TH>昵称</TH><TH>角色</TH>{canManage && <TH className="text-right">操作</TH>}</TR></THead>
          <TBody>
            {members.length === 0 && <TR><TD colSpan={canManage ? 4 : 3} className="text-center text-muted-foreground py-4">该命名空间暂无成员</TD></TR>}
            {members.map((m) => (
              <TR key={m.username}>
                <TD className="font-medium">{m.username}</TD>
                <TD className="text-muted-foreground">{m.display_name || "-"}</TD>
                <TD><Badge variant={m.role === "ns_admin" ? "default" : "secondary"}>{m.role}</Badge></TD>
                {canManage && (
                  <TD className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => void removeMember(m.username)}>移出</Button>
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </Modal>
  );
}
