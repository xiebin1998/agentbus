import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/components/Toaster";
import { Layout, Tab } from "@/components/Layout";
import { Login } from "@/pages/Login";
import { Namespaces } from "@/pages/Namespaces";
import { Accounts } from "@/pages/Accounts";
import { Metrics } from "@/pages/Metrics";
import { Connect } from "@/pages/Connect";

function Shell() {
  const { me, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("namespaces");

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (!me) return <Login />;

  return (
    <Layout tab={tab} onTab={setTab}>
      {tab === "namespaces" && <Namespaces />}
      {tab === "accounts" && <Accounts />}
      {tab === "metrics" && <Metrics />}
      {tab === "connect" && <Connect />}
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
