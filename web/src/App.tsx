import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { NsProvider } from "@/context/NsContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/components/Toaster";
import { Layout, Tab, tabsForRole } from "@/components/Layout";
import { Login } from "@/pages/Login";
import { Namespaces } from "@/pages/Namespaces";
import { Accounts } from "@/pages/Accounts";
import { Graph } from "@/pages/Graph";
import { Metrics } from "@/pages/Metrics";
import { Connect } from "@/pages/Connect";

function Shell() {
  const { me, loading } = useAuth();
  const [tab, setTabRaw] = useState<Tab>(() => loadStoredTab(""));

  // Tab 持久化：按账号分 key，刷新/账号切换后回到用户上次的页面（对齐 NsContext STORAGE_KEY 模式）
  function loadStoredTab(username: string): Tab {
    try {
      const v = localStorage.getItem("agentbus.tab." + username);
      if (v === "namespaces" || v === "accounts" || v === "graph" || v === "metrics" || v === "connect") return v;
    } catch {
      /* 隐私模式等场景忽略 */
    }
    return "namespaces";
  }

  function setTab(t: Tab) {
    setTabRaw(t);
    try {
      localStorage.setItem("agentbus.tab." + (me?.username ?? ""), t);
    } catch {
      /* ignore */
    }
  }

  // 账号切换/登出后加载该用户的持久 Tab；不可见项由下方 active 收敛逻辑回退
  useEffect(() => {
    setTabRaw(loadStoredTab(me?.username ?? ""));
  }, [me?.username]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!me) return <Login />;

  // 角色可见 Tab 收敛：当前 tab 不可见时回退到首个可见项（如普通用户 → 指标）
  const visible = tabsForRole(me.role);
  const active: Tab = visible.includes(tab) ? tab : visible[0];

  return (
    <Layout tab={active} onTab={setTab}>
      {active === "namespaces" && <Namespaces />}
      {active === "accounts" && <Accounts />}
      {active === "graph" && <Graph />}
      {active === "metrics" && <Metrics />}
      {active === "connect" && <Connect />}
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <NsProvider>
            <Shell />
          </NsProvider>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
