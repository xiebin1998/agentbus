import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, KeyRound, Loader2 } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label,
  Select, Table, TBody, TD, TH, THead, TR,
} from "@/components/ui";
import { api, Account, Namespace } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/Toaster";

export function Accounts() {
  const { me } = useAuth();
  const { toast } = useToast();
  const isSuper = me?.role === "super_admin";

  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [filterNs, setFilterNs] = useState("");
  const [list, setList] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ username: "", password: "", ns: "" });
  const [busy, setBusy] = useState(false);
  const [pwTarget, setPwTarget] = useState<string | null>(null);
  const [newPw, setNewPw] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.listAccounts(filterNs || undefined));
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载失败", false);
    } finally {
      setLoading(false);
    }
  }, [filterNs, toast]);

  useEffect(() => {
    api.listNamespaces().then(setNamespaces).catch(() => {});
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!form.username || !form.password) {
      toast("请填写用户名与密码", false);
      return;
    }
    setBusy(true);
    try {
      await api.createAccount({ username: form.username, password: form.password, ns: form.ns || undefined });
      toast(`账号 ${form.username} 已创建${form.ns ? ` 并加入 ${form.ns}` : ""}`);
      setForm({ username: "", password: "", ns: "" });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "创建失败", false);
    } finally {
      setBusy(false);
    }
  }

  async function remove(username: string) {
    if (!confirm(`确认删除账号 ${username}？`)) return;
    try {
      await api.deleteAccount(username);
      toast(`已删除 ${username}`);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", false);
    }
  }

  async function savePassword() {
    if (!pwTarget || !newPw) return;
    try {
      await api.setPassword(pwTarget, newPw);
      toast(`已更新 ${pwTarget} 的密码`);
      setPwTarget(null);
      setNewPw("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "更新失败", false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>账号</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={filterNs} onChange={(e) => setFilterNs(e.target.value)} className="w-44">
              <option value="">全部命名空间</option>
              {namespaces.map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : (
            <Table>
              <THead><TR><TH>用户名</TH><TH>角色</TH><TH className="text-right">操作</TH></TR></THead>
              <TBody>
                {list.length === 0 && <TR><TD colSpan={3} className="text-center text-muted-foreground py-6">暂无账号</TD></TR>}
                {list.map((a) => (
                  <TR key={a.username}>
                    <TD className="font-medium">{a.username}</TD>
                    <TD><Badge variant={a.role === "super_admin" ? "default" : a.role === "ns_admin" ? "success" : "secondary"}>{a.role}</Badge></TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="outline" size="sm" onClick={() => { setPwTarget(a.username); setNewPw(""); }}>
                          <KeyRound className="h-3.5 w-3.5" />改密
                        </Button>
                        {(isSuper || a.username !== me?.username) && (
                          <Button variant="destructive" size="sm" onClick={() => void remove(a.username)}>
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

      {pwTarget && (
        <Card>
          <CardHeader><CardTitle className="text-sm">重置密码：<Badge variant="secondary">{pwTarget}</Badge></CardTitle></CardHeader>
          <CardContent className="flex gap-2 items-end">
            <div className="space-y-1.5 flex-1 max-w-xs">
              <Label>新密码</Label>
              <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            </div>
            <Button onClick={() => void savePassword()}>保存</Button>
            <Button variant="ghost" onClick={() => setPwTarget(null)}>取消</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">创建账号</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4 items-end">
          <div className="space-y-1.5"><Label>用户名</Label>
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>密码</Label>
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>入组 ns（可选）</Label>
            <Select value={form.ns} onChange={(e) => setForm({ ...form, ns: e.target.value })}>
              <option value="">不入组</option>
              {namespaces.map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}
            </Select></div>
          <Button onClick={() => void create()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}<Plus className="h-4 w-4" />创建
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
