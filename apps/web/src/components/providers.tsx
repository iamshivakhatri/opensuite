"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ServiceStatusBanner } from "@/components/service-status-banner";
import { ServiceStatusProvider } from "@/lib/service-status";
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
          <ServiceStatusProvider>
            <ServiceStatusBanner />
            {children}
          </ServiceStatusProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
