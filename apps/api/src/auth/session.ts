import type { FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";

/**
 * The subset of a Better Auth user we are willing to expose from OpenSuite
 * product endpoints. Deliberately excludes session/account internals.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Minimal structural type for the part of the Better Auth instance needed to
 * resolve a session from request headers. The real `Auth` returned by
 * `createAuth` satisfies this without modification.
 */
export interface SessionAuth {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: AuthenticatedUser;
      session: Record<string, unknown>;
    } | null>;
  };
}

/**
 * Resolves the authenticated user (if any) for a Fastify request, using
 * Better Auth's session/cookie handling. Returns `null` when there is no
 * valid session — callers decide how to respond (e.g. 401).
 *
 * This is the single place protected routes should go through to read the
 * current user, so the shape of "authenticated user" stays consistent and
 * we never leak the full Better Auth session/account object by accident.
 */
export async function getRequestUser(
  auth: SessionAuth,
  request: FastifyRequest,
): Promise<AuthenticatedUser | null> {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });

  if (!result) {
    return null;
  }

  const { id, name, email } = result.user;
  return { id, name, email };
}
