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

/** Tab 可见性按角色收敛：普通用户仅指标/接入；ns_admin 无账号 Tab；超管全部 */
export function tabsForRole(role?: string): Tab[] {
  if (role === "user") return ["metrics", "connect"];
  if (role === "ns_admin") return ["namespaces", "metrics", "connect"];
  return TABS.map((t) => t.id);
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

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/80 backdrop-blur">
        <div className="flex w-full items-center gap-4 px-6 py-3 lg:px-8">
          <div className="flex items-center gap-2 font-semibold">
            <Bus className="h-5 w-5 text-primary" />
            AgentBus 控制台
          </div>

          {/* 全局命名空间切换：pill 胶囊样式（原生 select 本体，图标叠层不拦截点击），与 logo 以分隔线视觉分离 */}
          <div className="flex h-5 items-center border-l pl-4">
            <div className="relative flex h-8 items-center">
              <Layers className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-primary" />
              <select
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                aria-label="切换命名空间"
                className="h-8 max-w-56 cursor-pointer appearance-none rounded-full bg-secondary pl-9 pr-8 text-sm font-medium leading-none transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {isSuper && <option value="">全部命名空间</option>}
                {options.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name ? `${n.name}（${n.id}）` : n.id}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
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
                <span className="font-medium">{me.display_name || me.username}</span>
                {me.display_name && <span className="text-xs text-muted-foreground">@{me.username}</span>}
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
