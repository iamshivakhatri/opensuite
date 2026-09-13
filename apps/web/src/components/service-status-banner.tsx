"use client";

import {
  isDatabaseUnavailable,
  useServiceStatus,
} from "@/lib/service-status";

/**
 * Top strip when the API or Postgres is unreachable. Clears automatically once
 * `/health` reports database ok again.
 */
export function ServiceStatusBanner() {
  const status = useServiceStatus();

  if (!isDatabaseUnavailable(status)) {
    return null;
  }

  const message =
    status.kind === "api_unreachable"
      ? "OpenSuite can’t reach the API. We’ll reconnect automatically when it’s back."
      : "Database is temporarily unavailable. OpenSuite will reconnect automatically when Postgres is reachable again.";

  return (
    <div
      role="status"
      className="os-type-secondary border-b border-danger/20 bg-danger-soft px-4 py-2 text-center text-danger"
    >
      {message}
    </div>
  );
}
