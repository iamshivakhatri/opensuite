"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider } from "@/lib/theme";
import { ToastProvider } from "@/lib/toast";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          {/*
            Service status polling stays on API-dependent surfaces only
            (`/app/*` and auth routes). Public marketing pages must work with
            the API offline, so they do not mount ServiceStatusProvider.
          */}
          {children}
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
