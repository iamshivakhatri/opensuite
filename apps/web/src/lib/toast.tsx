"use client";

import * as React from "react";

export type ToastTone = "success" | "error" | "info";

export type ToastInput = {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  readonly durationMs?: number;
};

type ToastItem = ToastInput & {
  readonly id: string;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}

/**
 * Minimal non-blocking toasts. Errors linger longer; successes auto-dismiss.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const recentKeys = React.useRef<Map<string, number>>(new Map());

  const dismiss = React.useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: ToastInput) => {
      const key = `${input.tone ?? "info"}:${input.title}:${input.description ?? ""}`;
      const now = Date.now();
      const last = recentKeys.current.get(key) ?? 0;
      if (now - last < 1200) return;
      recentKeys.current.set(key, now);

      const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      const durationMs =
        input.durationMs ??
        (input.tone === "error" ? 5200 : input.tone === "info" ? 3200 : 2600);
      setItems((current) => [...current.slice(-4), { ...input, id }]);
      window.setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(360px,calc(100vw-24px))] flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={
              "pointer-events-auto rounded-[12px] border px-3.5 py-2.5 shadow-[0_10px_30px_rgba(15,18,24,0.12)] " +
              (item.tone === "error"
                ? "border-danger/20 bg-danger-soft text-danger"
                : item.tone === "success"
                  ? "border-success/20 bg-success-soft text-success"
                  : "border-line bg-surface text-ink")
            }
            role="status"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold tracking-[-0.01em]">
                  {item.title}
                </div>
                {item.description ? (
                  <div className="mt-0.5 text-[11px] leading-relaxed opacity-90">
                    {item.description}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-[12px] opacity-60 hover:opacity-100"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
