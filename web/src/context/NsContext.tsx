import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import { api, Namespace } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const STORAGE_KEY = "agentbus.ns";

interface NsCtx {
  /** 当前选中的 ns id；超管下 "" 表示"全部命名空间" */
  current: string;
  setCurrent: (ns: string) => void;
  /** 可见的 ns 列表（服务端已按权限过滤） */
  options: Namespace[];
  /** 超管可选"全部" */
  isSuper: boolean;
  /** 重新拉取 ns 列表（增删 ns 后调用） */
  refresh: () => Promise<void>;
}

const Ctx = createContext<NsCtx | null>(null);

export function NsProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const isSuper = me?.role === "super_admin";
  const [options, setOptions] = useState<Namespace[]>([]);
  const [current, setCurrentRaw] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });

  const refresh = useCallback(async () => {
    if (!me) {
      setOptions([]);
      return;
    }
    try {
      setOptions(await api.listNamespaces());
    } catch {
      setOptions([]);
    }
  }, [me]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setCurrent = useCallback((ns: string) => {
    setCurrentRaw(ns);
    try {
      localStorage.setItem(STORAGE_KEY, ns);
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }, []);

  // 选中项失效（账号切换 / ns 被删 / 登出）时回退：优先保留 localStorage 值，否则取首个
  useEffect(() => {
    if (!me) return;
    const ids = options.map((o) => o.id);
    if (current === "" && isSuper) return; // 超管"全部"合法
    if (!ids.includes(current)) {
      const fallback = ids[0] ?? "";
      setCurrentRaw(fallback);
      try {
        localStorage.setItem(STORAGE_KEY, fallback);
      } catch {
        /* ignore */
      }
    }
  }, [me, options, current, isSuper]);

  return (
    <Ctx.Provider value={{ current, setCurrent, options, isSuper: !!isSuper, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useNs(): NsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNs 必须在 NsProvider 内使用");
  return v;
}
