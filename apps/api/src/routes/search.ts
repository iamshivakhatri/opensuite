import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { SearchService } from "../documents/search.js";

const SearchQuery = z.object({
  q: z.string().trim().min(1, "Search query is required").max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

function unauthenticated() {
  return {
    error: {
      statusCode: 401 as const,
      message: "Unauthorized",
      code: "UNAUTHENTICATED" as const,
    },
  };
}

/**
 * Metadata search across owned active documents/workspaces.
 */
export function registerSearchRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  search: SearchService,
): void {
  app.get("/api/search", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }

    const parsed = SearchQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: parsed.error.issues[0]?.message ?? "Invalid search query",
          code: "INVALID_SEARCH_QUERY",
        },
      });
    }

    const results = await search.search({
      ownerUserId: user.id,
      query: parsed.data.q,
      limit: parsed.data.limit,
    });

    return reply.send(results);
  });
}
