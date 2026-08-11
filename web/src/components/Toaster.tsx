import { createContext, useCallback, useContext, useState, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Toast {
  id: number;
  text: string;
  ok: boolean;
}
interface ToastCtx {
  toast: (text: string, ok?: boolean) => void;
}

const Ctx = createContext<ToastCtx | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const toast = useCallback((text: string, ok = true) => {
    const id = ++seq;
    setItems((prev) => [...prev, { id, text, ok }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3800);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "rounded-lg border bg-card px-4 py-2.5 text-sm shadow-lg max-w-sm",
              t.ok ? "border-emerald-500/50" : "border-destructive/60",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast 必须在 ToastProvider 内使用");
  return v;
}
