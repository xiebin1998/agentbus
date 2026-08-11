import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";

export type Accent = "blue" | "violet";
interface ThemeCtx {
  dark: boolean;
  accent: Accent;
  toggleDark: () => void;
  toggleAccent: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const KEY_DARK = "agentbus.theme.dark";
const KEY_ACCENT = "agentbus.theme.accent";

function readDark(): boolean {
  const s = localStorage.getItem(KEY_DARK);
  if (s !== null) return s === "1";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}
function readAccent(): Accent {
  return localStorage.getItem(KEY_ACCENT) === "violet" ? "violet" : "blue";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState<boolean>(readDark);
  const [accent, setAccent] = useState<Accent>(readAccent);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.setAttribute("data-accent", accent);
    localStorage.setItem(KEY_DARK, dark ? "1" : "0");
    localStorage.setItem(KEY_ACCENT, accent);
  }, [dark, accent]);

  const toggleDark = useCallback(() => setDark((d) => !d), []);
  const toggleAccent = useCallback(() => setAccent((a) => (a === "blue" ? "violet" : "blue")), []);

  return <Ctx.Provider value={{ dark, accent, toggleDark, toggleAccent }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return v;
}
