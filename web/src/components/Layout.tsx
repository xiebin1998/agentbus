import { ReactNode } from "react";
import { Bus, Sun, Moon, Palette, LogOut } from "lucide-react";
import { Button } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { cn } from "@/lib/utils";

export type Tab = "namespaces" | "accounts" | "metrics" | "connect";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "namespaces", label: "命名空间" },
  { id: "accounts", label: "账号" },
  { id: "metrics", label: "指标" },
  { id: "connect", label: "接入命令" },
];

const roleLabel: Record<string, string> = {
  super_admin: "超级管理员",
  ns_admin: "命名空间管理员",
  user: "普通用户",
};

export function Layout({
  tab,
  onTab,
  children,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  children: ReactNode;
}) {
  const { me, logout } = useAuth();
  const { dark, accent, toggleDark, toggleAccent } = useTheme();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Bus className="h-5 w-5 text-primary" />
            AgentBus 控制台
          </div>
          <nav className="ml-6 flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => onTab(t.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  tab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={toggleAccent} title={`强调色：${accent === "blue" ? "蓝" : "紫"}（点击切换）`}>
              <Palette className="h-4 w-4" style={{ color: accent === "blue" ? "#3b82f6" : "#8b5cf6" }} />
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleDark} title="明暗切换">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            {me && (
              <div className="flex items-center gap-2 pl-2 text-sm">
                <span className="font-medium">{me.username}</span>
                <span className="text-xs text-muted-foreground">{roleLabel[me.role] ?? me.role}</span>
                <Button variant="ghost" size="icon" onClick={() => void logout()} title="退出登录">
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
