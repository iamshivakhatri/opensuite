const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;

export interface Me {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Calls the OpenSuite-owned `GET /api/me` (not a Better Auth endpoint) to
 * prove the backend recognizes the current session. `credentials: "include"`
 * is required because apps/web and apps/api are different origins.
 */
export async function fetchMe(): Promise<Me | null> {
  const response = await fetch(`${apiBaseUrl}/api/me`, {
    credentials: "include",
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GET /api/me failed with status ${response.status}`);
  }

  const body = (await response.json()) as { user: Me };
  return body.user;
}
