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
import { Metrics } from "@/pages/Metrics";
import { Connect } from "@/pages/Connect";

function Shell() {
  const { me, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("namespaces");

  // 账号切换/登出后重置 tab，避免上一用户的选中项泄漏到新会话
  useEffect(() => {
    setTab(me ? tabsForRole(me.role)[0] : "namespaces");
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
