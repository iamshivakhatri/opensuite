"use client";

import * as React from "react";

import { fetchApiHealth, type DatabaseReachability } from "@/lib/api-health";

const POLL_MS_HEALTHY = 30_000;
const POLL_MS_UNHEALTHY = 5_000;

export type ServiceStatus =
  | { readonly kind: "unknown" }
  | { readonly kind: "api_unreachable" }
  | {
      readonly kind: "ready";
      readonly database: DatabaseReachability;
    };

const ServiceStatusContext = React.createContext<ServiceStatus>({
  kind: "unknown",
});

/**
 * Polls `/health` once for the whole app so banners and auth gates share the
 * same outage/recovery signal. pg reconnects on the next checkout; we only
 * need to keep probing until `database` flips back to ok.
 */
export function ServiceStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = React.useState<ServiceStatus>({ kind: "unknown" });

  React.useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const schedule = (delayMs: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      const health = await fetchApiHealth();
      if (cancelled) {
        return;
      }
      if (!health) {
        setStatus({ kind: "api_unreachable" });
        schedule(POLL_MS_UNHEALTHY);
        return;
      }
      setStatus({ kind: "ready", database: health.database });
      schedule(
        health.database === "ok" ? POLL_MS_HEALTHY : POLL_MS_UNHEALTHY,
      );
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <ServiceStatusContext.Provider value={status}>
      {children}
    </ServiceStatusContext.Provider>
  );
}

export function useServiceStatus(): ServiceStatus {
  return React.useContext(ServiceStatusContext);
}

export function isDatabaseUnavailable(status: ServiceStatus): boolean {
  return (
    status.kind === "api_unreachable" ||
    (status.kind === "ready" && status.database === "unavailable")
  );
}
