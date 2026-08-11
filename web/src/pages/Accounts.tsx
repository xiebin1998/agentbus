import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, KeyRound, Loader2, UserPen } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, Input, Label, Modal, Select,
  Table, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { api, Account } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useNs } from "@/context/NsContext";
import { useToast } from "@/components/Toaster";

export function Accounts() {
  const { me } = useAuth();
  const { current, options, isSuper } = useNs();
  const { toast } = useToast();
  const isSuperUser = me?.role === "super_admin";

  const [list, setList] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [pwTarget, setPwTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Account | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 全局 ns：超管"全部"（""）→ 全量；否则按所选 ns 过滤
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.listAccounts(isSuper && current === "" ? undefined : current || undefined));
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载失败", false);
    } finally {
      setLoading(false);
    }
  }, [current, isSuper, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.deleteAccount(deleteTarget);
      toast(`已删除 ${deleteTarget}`);
      setDeleteTarget(null);
      await load();
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
          <CardTitle>
            账号
            {current && <Badge variant="secondary" className="ml-2 align-middle">{current}</Badge>}
          </CardTitle>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />创建账号
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : (
            <Table>
              <THead><TR><TH>用户名</TH><TH>昵称</TH><TH>角色</TH><TH className="text-right">操作</TH></TR></THead>
              <TBody>
                {list.length === 0 && <TR><TD colSpan={4} className="text-center text-muted-foreground py-6">暂无账号</TD></TR>}
                {list.map((a) => (
                  <TR key={a.username}>
                    <TD className="font-medium">{a.username}</TD>
                    <TD className="text-muted-foreground">{a.display_name || "-"}</TD>
                    <TD><Badge variant={a.role === "super_admin" ? "default" : a.role === "ns_admin" ? "success" : "secondary"}>{a.role}</Badge></TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setRenameTarget(a)} title="编辑昵称">
                          <UserPen className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPwTarget(a.username)}>
                          <KeyRound className="h-3.5 w-3.5" />改密
                        </Button>
                        {isSuperUser && (
                          <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(a.username)}>
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

      <CreateAccountModal
        open={createOpen}
        defaultNs={current}
        options={options.map((o) => o.id)}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await load();
        }}
      />

      <ResetPasswordModal
        target={pwTarget}
        onClose={() => setPwTarget(null)}
        onSaved={() => setPwTarget(null)}
      />

      <EditDisplayNameModal
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSaved={async () => {
          setRenameTarget(null);
          await load();
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除账号"
        description={<>确认删除账号 <b>{deleteTarget}</b>？其成员绑定与 broker client 一并移除。</>}
        confirmText="删除"
        busy={deleteBusy}
        onConfirm={() => void remove()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/* ── 创建账号 ── */
function CreateAccountModal({ open, defaultNs, options, onClose, onCreated }: {
  open: boolean;
  defaultNs: string;
  options: string[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({ username: "", password: "", ns: "", display_name: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setForm({ username: "", password: "", ns: defaultNs, display_name: "" });
  }, [open, defaultNs]);

  async function submit() {
    if (!form.username || !form.password) {
      toast("请填写用户名与密码", false);
      return;
    }
    setBusy(true);
    try {
      await api.createAccount({
        username: form.username, password: form.password,
        ns: form.ns || undefined, display_name: form.display_name.trim() || undefined,
      });
      toast(`账号 ${form.username} 已创建${form.ns ? ` 并加入 ${form.ns}` : ""}`);
      await onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "创建失败", false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="创建账号" onClose={onClose}>
      <div className="space-y-3">
        <div className="space-y-1.5"><Label>用户名</Label>
          <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>昵称（可选，真实姓名）</Label>
          <Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="如：张三" /></div>
        <div className="space-y-1.5"><Label>密码</Label>
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>入组 ns（可选）</Label>
          <Select value={form.ns} onChange={(e) => setForm({ ...form, ns: e.target.value })}>
            <option value="">不入组</option>
            {options.map((id) => <option key={id} value={id}>{id}</option>)}
          </Select></div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}<Plus className="h-4 w-4" />创建
        </Button>
      </div>
    </Modal>
  );
}

/* ── 重置密码 ── */
function ResetPasswordModal({ target, onClose, onSaved }: {
  target: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [newPw, setNewPw] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) setNewPw("");
  }, [target]);

  async function submit() {
    if (!target || !newPw) {
      toast("请输入新密码", false);
      return;
    }
    setBusy(true);
    try {
      await api.setPassword(target, newPw);
      toast(`已更新 ${target} 的密码`);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "更新失败", false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={<>重置密码：<Badge variant="secondary">{target}</Badge></>}
      onClose={onClose}
    >
      <div className="space-y-1.5">
        <Label>新密码</Label>
        <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
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

/* ── 编辑昵称（不参与登录，仅记录真实姓名）── */
function EditDisplayNameModal({ target, onClose, onSaved }: {
  target: Account | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) setName(target.display_name);
  }, [target]);

  async function submit() {
    if (!target) return;
    setBusy(true);
    try {
      await api.updateAccount(target.username, { display_name: name.trim() });
      toast(`已更新 ${target.username} 的昵称`);
      await onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败", false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={<>编辑昵称：<Badge variant="secondary">{target?.username}</Badge></>}
      onClose={onClose}
    >
      <div className="space-y-1.5">
        <Label>昵称（真实姓名，不用于登录）</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：张三" />
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
