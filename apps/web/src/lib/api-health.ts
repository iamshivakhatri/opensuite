const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;

export type DatabaseReachability = "ok" | "unavailable";

export interface ApiHealth {
  readonly status: "ok" | "degraded";
  readonly uptimeSeconds: number;
  readonly database: DatabaseReachability;
}

/**
 * Process + database reachability. `/health` stays HTTP 200 while the API
 * process is up; read `database` / `status` for outage UI.
 */
export async function fetchApiHealth(
  init?: RequestInit,
): Promise<ApiHealth | null> {
  if (!apiBaseUrl) {
    return null;
  }
  try {
    const response = await fetch(`${apiBaseUrl}/health`, {
      ...init,
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Partial<ApiHealth>;
    if (body.database !== "ok" && body.database !== "unavailable") {
      return null;
    }
    return {
      status: body.status === "degraded" ? "degraded" : "ok",
      uptimeSeconds:
        typeof body.uptimeSeconds === "number" ? body.uptimeSeconds : 0,
      database: body.database,
    };
  } catch {
    return null;
  }
}
