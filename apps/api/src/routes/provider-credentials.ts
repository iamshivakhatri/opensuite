import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getRequestUser, type SessionAuth } from "../auth/session.js";
import type { ProviderCredentialService } from "../credentials/service.js";
import {
  providerCredentialProviders,
  type ProviderCredentialMetadata,
} from "../credentials/types.js";

const ProviderSchema = z.enum(providerCredentialProviders);

const ConnectBody = z.object({
  provider: ProviderSchema,
  apiKey: z
    .string()
    .trim()
    .min(1, "API key is required"),
});

const ProviderParams = z.object({
  provider: ProviderSchema,
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

function unsupportedProvider(message: string) {
  return {
    error: {
      statusCode: 400 as const,
      message,
      code: "UNSUPPORTED_PROVIDER" as const,
    },
  };
}

function invalidApiKey(message: string) {
  return {
    error: {
      statusCode: 400 as const,
      message,
      code: "INVALID_API_KEY" as const,
    },
  };
}

function credentialNotFound() {
  return {
    error: {
      statusCode: 404 as const,
      message: "Provider credential not found",
      code: "CREDENTIAL_NOT_FOUND" as const,
    },
  };
}

function credentialsUnconfigured() {
  return {
    error: {
      statusCode: 503 as const,
      message: "Provider credentials are not configured on this server",
      code: "CREDENTIALS_UNCONFIGURED" as const,
    },
  };
}

/** Browser-facing credential status — never includes secrets or ciphertext. */
function toPublicCredential(meta: ProviderCredentialMetadata) {
  return {
    provider: meta.provider,
    connected: meta.connected,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

/**
 * Authenticated BYOK provider credential lifecycle.
 * Ownership is always scoped to `getRequestUser(...).id`.
 */
export function registerProviderCredentialRoutes(
  app: FastifyInstance,
  auth: SessionAuth,
  credentials: ProviderCredentialService | null,
): void {
  app.get("/api/provider-credentials", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }
    if (!credentials) {
      return reply.status(503).send(credentialsUnconfigured());
    }

    const list = await credentials.listMetadata({ userId: user.id });
    return reply.send({
      credentials: list.map(toPublicCredential),
    });
  });

  app.put("/api/provider-credentials", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }
    if (!credentials) {
      return reply.status(503).send(credentialsUnconfigured());
    }

    const parsed = ConnectBody.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path[0];
      if (path === "provider") {
        return reply
          .status(400)
          .send(unsupportedProvider(issue?.message ?? "Unsupported provider"));
      }
      return reply
        .status(400)
        .send(invalidApiKey(issue?.message ?? "Invalid API key"));
    }

    const credential = await credentials.save({
      userId: user.id,
      provider: parsed.data.provider,
      secret: parsed.data.apiKey,
    });

    return reply.send({
      credential: toPublicCredential(credential),
    });
  });

  app.delete("/api/provider-credentials/:provider", async (request, reply) => {
    const user = await getRequestUser(auth, request);
    if (!user) {
      return reply.status(401).send(unauthenticated());
    }
    if (!credentials) {
      return reply.status(503).send(credentialsUnconfigured());
    }

    const params = ProviderParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .status(400)
        .send(
          unsupportedProvider(
            params.error.issues[0]?.message ?? "Unsupported provider",
          ),
        );
    }

    const deleted = await credentials.delete({
      userId: user.id,
      provider: params.data.provider,
    });
    if (!deleted) {
      return reply.status(404).send(credentialNotFound());
    }

    return reply.status(204).send();
  });
}
