import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, TerminalSquare, Loader2, Eye, EyeOff } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select,
} from "@/components/ui";
import { api, ConnectCommand, Namespace } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/Toaster";

export function Connect() {
  const { me } = useAuth();
  const { toast } = useToast();
  const isSuper = me?.role === "super_admin";

  const [allNs, setAllNs] = useState<Namespace[]>([]);
  const [ns, setNs] = useState("");
  const [cmd, setCmd] = useState<ConnectCommand | null>(null);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  const nsOptions = useMemo(
    () => (isSuper ? allNs.map((n) => n.id) : me?.namespaces ?? []),
    [isSuper, allNs, me],
  );

  useEffect(() => {
    if (isSuper) api.listNamespaces().then(setAllNs).catch(() => {});
  }, [isSuper]);

  useEffect(() => {
    if (!ns && nsOptions.length > 0) setNs(nsOptions[0]);
  }, [ns, nsOptions]);

  const load = useCallback(async (target: string) => {
    if (!target) return;
    setLoading(true);
    try {
      setCmd(await api.connectCommand(target));
    } catch (e) {
      setCmd(null);
      toast(e instanceof Error ? e.message : "加载失败", false);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load(ns);
  }, [ns, load]);

  // 模板中 <密码> 占位符替换为用户重输的密码（密码单向哈希，服务端不可回显）
  const fullCommand = cmd ? (password ? cmd.template.replace("<密码>", password) : cmd.template) : "";

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板");
    } catch {
      toast("复制失败，请手动选择复制", false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-primary" />接入命令
          </CardTitle>
          <Select value={ns} onChange={(e) => setNs(e.target.value)} className="w-44">
            {nsOptions.length === 0 && <option value="">无可见命名空间</option>}
            {nsOptions.map((id) => <option key={id} value={id}>{id}</option>)}
          </Select>
        </CardHeader>
        <CardContent className="space-y-4">
          {!ns ? (
            <p className="text-sm text-muted-foreground py-4 text-center">当前账号未绑定任何命名空间</p>
          ) : loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-4"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : !cmd ? (
            <p className="text-sm text-muted-foreground py-4 text-center">无法获取接入命令</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Info label="Broker 地址" value={cmd.broker} />
                <Info label="接入用户" value={cmd.user} />
                <div>
                  <div className="text-xs text-muted-foreground mb-1">命名空间</div>
                  <Badge variant="secondary">{cmd.ns}</Badge>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>你的账号密码（用于拼接完整命令，不会上传）</Label>
                <div className="flex max-w-md gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showPw ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="重输密码"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>初始化命令</Label>
                  <Button variant="outline" size="sm" onClick={() => void copy(fullCommand)}>
                    <Copy className="h-3.5 w-3.5" />一键复制
                  </Button>
                </div>
                <pre className="overflow-auto rounded-md border bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap break-all">
                  {fullCommand}
                </pre>
                <p className="text-xs text-muted-foreground">{cmd.note}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-sm font-medium font-mono">{value}</div>
    </div>
  );
}
