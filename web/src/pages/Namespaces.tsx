import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Users, Loader2 } from "lucide-react";
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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
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

  // ns_admin 可管理自己所属的 ns（与服务端 _can_manage_ns 对齐）
  const canManage = (ns: string) =>
    isSuper || (me?.role === "ns_admin" && (me?.namespaces ?? []).includes(ns));

  async function remove() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.deleteNamespace(deleteTarget);
      toast(`已删除 ${deleteTarget}`);
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
                <TR><TH>ID</TH><TH>名称</TH><TH>描述</TH><TH className="text-right">操作</TH></TR>
              </THead>
              <TBody>
                {list.length === 0 && (
                  <TR><TD colSpan={4} className="text-center text-muted-foreground py-6">暂无命名空间</TD></TR>
                )}
                {list.map((n) => (
                  <TR key={n.id}>
                    <TD className="font-medium">{n.id}</TD>
                    <TD>{n.name}</TD>
                    <TD className="text-muted-foreground">{n.description || "-"}</TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setMemberTarget(n)}>
                          <Users className="h-3.5 w-3.5" />成员
                        </Button>
                        {canManage(n.id) && (
                          <Button variant="outline" size="sm" onClick={() => setEditTarget(n)}>
                            <Pencil className="h-3.5 w-3.5" />编辑
                          </Button>
                        )}
                        {isSuper && (
                          <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(n.id)}>
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

      {/* 成员管理弹窗 */}
      <MembersModal target={memberTarget} onClose={() => setMemberTarget(null)} />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除命名空间"
        description={<>确认删除命名空间 <b>{deleteTarget}</b>？将同时移除其 broker 组与角色，成员绑定一并清除。</>}
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
        <div className="space-y-1.5"><Label>NS ID（英文，不含 /，创建后不可改）</Label>
          <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="pay" /></div>
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

/* ── 成员管理 ── */
function MembersModal({ target, onClose }: { target: Namespace | null; onClose: () => void }) {
  const { toast } = useToast();
  const [members, setMembers] = useState<Account[]>([]);
  const [newMember, setNewMember] = useState("");
  const [busy, setBusy] = useState(false);

  const loadMembers = useCallback(async (ns: string) => {
    try {
      setMembers(await api.listAccounts(ns));
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载成员失败", false);
    }
  }, [toast]);

  useEffect(() => {
    if (target) {
      setNewMember("");
      void loadMembers(target.id);
    } else {
      setMembers([]);
    }
  }, [target, loadMembers]);

  async function addMember() {
    if (!target || !newMember.trim()) return;
    setBusy(true);
    try {
      await api.addMember(target.id, newMember.trim());
      toast(`已将 ${newMember} 加入 ${target.id}`);
      setNewMember("");
      await loadMembers(target.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加入失败", false);
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
      <div className="flex gap-2">
        <Input placeholder="账号用户名" value={newMember} onChange={(e) => setNewMember(e.target.value)} />
        <Button onClick={() => void addMember()} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}<Plus className="h-4 w-4" />加入
        </Button>
      </div>
      <div className="mt-4">
        <Table>
          <THead><TR><TH>账号</TH><TH>角色</TH><TH className="text-right">操作</TH></TR></THead>
          <TBody>
            {members.length === 0 && <TR><TD colSpan={3} className="text-center text-muted-foreground py-4">该命名空间暂无成员</TD></TR>}
            {members.map((m) => (
              <TR key={m.username}>
                <TD className="font-medium">{m.username}</TD>
                <TD><Badge variant={m.role === "ns_admin" ? "default" : "secondary"}>{m.role}</Badge></TD>
                <TD className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => void removeMember(m.username)}>移出</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </Modal>
  );
}
