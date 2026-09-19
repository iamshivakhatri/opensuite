"use client";

import {
  isDatabaseUnavailable,
  useServiceStatus,
} from "@/lib/service-status";

/**
 * Calm top strip when the API or Postgres is unreachable. Clears once `/health`
 * reports database ok again. Intentionally not danger-styled — outages should
 * feel recoverable, not catastrophic.
 */
export function ServiceStatusBanner() {
  const status = useServiceStatus();

  if (!isDatabaseUnavailable(status)) {
    return null;
  }

  const message =
    status.kind === "api_unreachable"
      ? "Can't reach the API — retrying automatically."
      : "No connection with the database — changes won't save until it's back.";

  return (
    <div
      role="status"
      className="os-type-secondary border-b border-line bg-sunken px-4 py-2 text-center text-ink-soft"
    >
      {message}
    </div>
  );
}
