"use client";

import { ThemeProvider } from "@/lib/theme";
import { ToastProvider } from "@/lib/toast";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
