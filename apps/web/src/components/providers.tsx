"use client";

import { ThemeProvider } from "@/lib/theme";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
