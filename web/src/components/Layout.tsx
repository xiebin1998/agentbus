import { ReactNode } from "react";
import { Bus, Sun, Moon, Palette, LogOut, Layers, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useNs } from "@/context/NsContext";
import { useTheme } from "@/context/ThemeContext";
import { cn } from "@/lib/utils";

export type Tab = "namespaces" | "accounts" | "metrics" | "connect";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "namespaces", label: "命名空间" },
  { id: "accounts", label: "账号" },
  { id: "metrics", label: "指标" },
  { id: "connect", label: "接入命令" },
];

/** 普通用户仅可见指标/接入命令；管理员见全部 */
export function tabsForRole(role?: string): Tab[] {
  return role === "user" ? ["metrics", "connect"] : TABS.map((t) => t.id);
}

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
  const { current, setCurrent, options, isSuper } = useNs();
  const { dark, accent, toggleDark, toggleAccent } = useTheme();

  const visibleTabs = TABS.filter((t) => tabsForRole(me?.role).includes(t.id));
  const currentLabel =
    current === "" ? "全部命名空间" : options.find((n) => n.id === current)?.name || current || "选择命名空间";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/80 backdrop-blur">
        <div className="flex w-full items-center gap-4 px-6 py-3 lg:px-8">
          <div className="flex items-center gap-2 font-semibold">
            <Bus className="h-5 w-5 text-primary" />
            AgentBus 控制台
          </div>

          {/* 全局命名空间切换：pill 胶囊样式，与 logo 以分隔线视觉分离 */}
          <div className="h-5 border-l pl-4">
            <label className="group flex h-8 cursor-pointer items-center gap-2 rounded-full bg-secondary px-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground">
              <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="max-w-40 truncate font-medium">{currentLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-focus-within:rotate-180" />
              <select
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="absolute h-0 w-0 opacity-0"
                aria-label="切换命名空间"
              >
                {isSuper && <option value="">全部命名空间</option>}
                {options.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name ? `${n.name}（${n.id}）` : n.id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <nav className="ml-2 flex gap-1">
            {visibleTabs.map((t) => (
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
      <main className="w-full flex-1 px-6 py-6 lg:px-8">{children}</main>
    </div>
  );
}
