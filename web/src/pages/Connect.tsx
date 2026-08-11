import { useEffect, useState } from "react";
import { Copy, TerminalSquare, Loader2, Eye, EyeOff, Sparkles, Download, Stethoscope } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Modal,
} from "@/components/ui";
import { api, ConnectCommand } from "@/lib/api";
import { useNs } from "@/context/NsContext";
import { useToast } from "@/components/Toaster";
import { cn } from "@/lib/utils";

/** CLI 手动安装命令（与 README 一致） */
const INSTALL_CMD = "npm i -g @xiebin1998/agentbus";

export function Connect() {
  const { current, options } = useNs();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-primary" />接入命令
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            接入命令用于在你的项目目录一键初始化 AgentBus 客户端（写配置、注册 MCP、拉起 daemon）。
            命令模板由服务端按当前命名空间生成；密码单向哈希存储，需在弹窗内重输后本地拼接完整命令。
          </p>
          <div className="flex items-center gap-3">
            <Button onClick={() => setOpen(true)} disabled={!current}>
              <Sparkles className="h-4 w-4" />生成接入命令
            </Button>
            {current ? (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                当前命名空间：<Badge variant="secondary">{current}</Badge>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                {options.length === 0 ? "当前账号未绑定任何命名空间" : "请先在顶栏选择命名空间"}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <ConnectCommandModal ns={current} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/* ── 接入命令弹窗：双安装方式 + 密码重输 + 命令展示 + 一键复制 ── */
type InstallMethod = "script" | "npm";

function ConnectCommandModal({ ns, open, onClose }: { ns: string; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [cmd, setCmd] = useState<ConnectCommand | null>(null);
  const [loading, setLoading] = useState(false);
  const [method, setMethod] = useState<InstallMethod>("script");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    if (!open || !ns) return;
    setPassword("");
    setShowPw(false);
    setMethod("script");
    setLoading(true);
    api.connectCommand(ns)
      .then(setCmd)
      .catch((e) => {
        setCmd(null);
        toast(e instanceof Error ? e.message : "加载失败", false);
      })
      .finally(() => setLoading(false));
  }, [open, ns, toast]);

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
    <Modal open={open} title="接入命令" onClose={onClose} className="max-w-xl">
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-4"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
      ) : !cmd ? (
        <p className="text-sm text-muted-foreground py-4 text-center">无法获取接入命令</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Info label="Broker 地址" value={cmd.broker} />
            <Info label="接入用户" value={cmd.user} />
            <div>
              <div className="text-xs text-muted-foreground mb-1">命名空间</div>
              <Badge variant="secondary">{cmd.ns}</Badge>
            </div>
          </div>

          {/* 第 1 步：安装 CLI（两种方式） */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge className="h-5 w-5 justify-center rounded-full p-0">1</Badge>
              <Label className="flex items-center gap-1.5"><Download className="h-3.5 w-3.5" />安装 AgentBus CLI（全局一次）</Label>
            </div>

            {/* 方式切换 */}
            <div className="flex gap-2" role="tablist" aria-label="安装方式">
              {(["script", "npm"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={method === m}
                  onClick={() => setMethod(m)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    method === m
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {m === "script" ? "一键脚本（推荐）" : "npm 手动"}
                </button>
              ))}
            </div>

            {method === "script" ? (
              <div className="space-y-3">
                <CmdBlock label="Windows PowerShell" text={cmd.install_ps1} onCopy={copy} />
                <CmdBlock label="macOS / Linux" text={cmd.install_sh} onCopy={copy} />
                <p className="text-xs text-muted-foreground">
                  脚本自动完成：Node 环境检查 → 安装 CLI → 交互式初始化（init）→ 体检（doctor）。
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-end">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void copy(INSTALL_CMD)}>
                    <Copy className="h-3.5 w-3.5" />复制
                  </Button>
                </div>
                <pre className="-mt-1 overflow-auto rounded-md border bg-muted/50 p-3 text-sm font-mono">{INSTALL_CMD}</pre>
              </div>
            )}
          </div>

          {/* 第 2 步：仅 npm 手动方式需要（脚本方式自带 init） */}
          {method === "npm" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge className="h-5 w-5 justify-center rounded-full p-0">2</Badge>
              <Label>在你的项目目录执行初始化</Label>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">你的账号密码（用于拼接完整命令，不会上传）</Label>
              <div className="relative">
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

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">初始化命令</Label>
                <Button variant="outline" size="sm" onClick={() => void copy(fullCommand)}>
                  <Copy className="h-3.5 w-3.5" />一键复制
                </Button>
              </div>
              <pre className="overflow-auto rounded-md border bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap break-all">
                {fullCommand}
              </pre>
              <p className="text-xs text-muted-foreground">{cmd.note}</p>
            </div>
          </div>
          )}

          {/* 第 3 步（npm 方式）：接入后体检 */}
          {method === "npm" && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Badge className="h-5 w-5 justify-center rounded-full p-0">3</Badge>
                <Label className="flex items-center gap-1.5"><Stethoscope className="h-3.5 w-3.5" />验证接入（可选）</Label>
                <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => void copy("agentbus doctor")}>
                  <Copy className="h-3.5 w-3.5" />复制
                </Button>
              </div>
              <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-sm font-mono">agentbus doctor</pre>
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>关闭</Button>
          </div>
        </div>
      )}
    </Modal>
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

/* ── 命令块：标签 + 命令 + 复制按钮 ── */
function CmdBlock({ label, text, onCopy }: { label: string; text: string; onCopy: (t: string) => void }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onCopy(text)}>
          <Copy className="h-3.5 w-3.5" />复制
        </Button>
      </div>
      <pre className="overflow-auto rounded-md border bg-muted/50 p-3 text-sm font-mono whitespace-pre-wrap break-all">{text}</pre>
    </div>
  );
}
