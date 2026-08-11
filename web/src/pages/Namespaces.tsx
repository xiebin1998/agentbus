import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Users, Loader2 } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label,
  Table, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { api, Account, Namespace } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/Toaster";

export function Namespaces() {
  const { me } = useAuth();
  const { toast } = useToast();
  const isSuper = me?.role === "super_admin";

  const [list, setList] = useState<Namespace[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<Account[]>([]);
  const [newMember, setNewMember] = useState("");
  const [form, setForm] = useState({ id: "", name: "", description: "", admin_username: "", admin_password: "" });
  const [busy, setBusy] = useState(false);

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

  const loadMembers = useCallback(async (ns: string) => {
    try {
      setMembers(await api.listAccounts(ns));
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载成员失败", false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selected) void loadMembers(selected);
    else setMembers([]);
  }, [selected, loadMembers]);

  async function create() {
    if (!form.id || !form.admin_username || !form.admin_password) {
      toast("请填写 ns id、管理员账号与密码", false);
      return;
    }
    setBusy(true);
    try {
      await api.createNamespace(form);
      toast(`命名空间 ${form.id} 已创建`);
      setForm({ id: "", name: "", description: "", admin_username: "", admin_password: "" });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "创建失败", false);
    } finally {
      setBusy(false);
    }
  }

  async function remove(ns: string) {
    if (!confirm(`确认删除命名空间 ${ns}？将同时移除其 broker 组与角色。`)) return;
    try {
      await api.deleteNamespace(ns);
      toast(`已删除 ${ns}`);
      if (selected === ns) setSelected(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", false);
    }
  }

  async function addMember() {
    if (!selected || !newMember.trim()) return;
    try {
      await api.addMember(selected, newMember.trim());
      toast(`已将 ${newMember} 加入 ${selected}`);
      setNewMember("");
      await loadMembers(selected);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加入失败", false);
    }
  }

  async function removeMember(username: string) {
    if (!selected) return;
    try {
      await api.removeMember(selected, username);
      toast(`已将 ${username} 移出 ${selected}`);
      await loadMembers(selected);
    } catch (e) {
      toast(e instanceof Error ? e.message : "移出失败", false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>命名空间</CardTitle>
          <span className="text-xs text-muted-foreground">ns 隔离由 broker ACL 强制；成员多对多绑定</span>
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
                        <Button variant="outline" size="sm" onClick={() => setSelected(selected === n.id ? null : n.id)}>
                          <Users className="h-3.5 w-3.5" />成员
                        </Button>
                        {isSuper && (
                          <Button variant="destructive" size="sm" onClick={() => void remove(n.id)}>
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

      {selected && (
        <Card>
          <CardHeader><CardTitle className="text-sm">成员管理：<Badge variant="secondary">{selected}</Badge></CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input placeholder="账号用户名" value={newMember} onChange={(e) => setNewMember(e.target.value)} className="max-w-xs" />
              <Button onClick={() => void addMember()}><Plus className="h-4 w-4" />加入</Button>
            </div>
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
          </CardContent>
        </Card>
      )}

      {isSuper && (
        <Card>
          <CardHeader><CardTitle className="text-sm">创建命名空间（含 ns 管理员）</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5"><Label>NS ID（英文，不含 /）</Label>
              <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="pay" /></div>
            <div className="space-y-1.5"><Label>显示名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="支付" /></div>
            <div className="space-y-1.5 md:col-span-2"><Label>描述（可选）</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>管理员账号</Label>
              <Input value={form.admin_username} onChange={(e) => setForm({ ...form, admin_username: e.target.value })} placeholder="pay-admin" /></div>
            <div className="space-y-1.5"><Label>管理员密码</Label>
              <Input type="password" value={form.admin_password} onChange={(e) => setForm({ ...form, admin_password: e.target.value })} /></div>
            <div className="md:col-span-2">
              <Button onClick={() => void create()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}创建
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
