import {
  AgentCoreError,
  buildDocumentAgentSystemPrompt,
  shapeDiagnosticForToolResult,
} from "@opensuite/agent-core";
import type { ModelMessage, ModelRequest } from "@opensuite/agent-core";

/**
 * Resolve the effective system prompt for a model turn.
 * Prefer run capabilities so mutation/authoring guidance matches the tool catalog.
 * Static `override` is only for explicit test injection.
 */
export function resolveAgentSystemPrompt(
  request: Pick<ModelRequest, "capabilities">,
  override?: string,
): string {
  if (override !== undefined) {
    return override;
  }
  return buildDocumentAgentSystemPrompt(request.capabilities);
}

/** @deprecated Prefer resolveAgentSystemPrompt(request) — static prompt omits mutate guidance. */
export const DEFAULT_AGENT_SYSTEM = buildDocumentAgentSystemPrompt();

export function cancelledError(cause?: unknown): AgentCoreError {
  return new AgentCoreError("CANCELLED", "Model call aborted", {
    diagnostic: {
      code: "CANCELLED",
      severity: "error",
      message: "Model call aborted",
    },
    cause,
  });
}

export function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  return (
    name === "AbortError" ||
    name === "APIUserAbortError" ||
    ("code" in error && error.code === "CANCELLED")
  );
}

/**
 * Map provider exceptions to AgentCoreError without leaking raw payloads/keys.
 */
export function normalizeProviderError(
  error: unknown,
  providerLabel: string,
): AgentCoreError {
  if (error instanceof AgentCoreError) {
    return error;
  }

  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : undefined;

  const rawMessage =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";

  // Some OpenRouter / OSS models reject tools — surface that safely.
  if (
    /tool/i.test(rawMessage) &&
    /(not supported|unsupported|does not support|no tool)/i.test(rawMessage)
  ) {
    const message = `${providerLabel} model does not support tool calling`;
    return new AgentCoreError("MODEL_FAILURE", message, {
      diagnostic: {
        code: "MODEL_FAILURE",
        severity: "error",
        message,
      },
      cause: error,
    });
  }

  let message = `${providerLabel} model request failed`;
  if (status === 401 || status === 403) {
    message = `${providerLabel} authentication failed`;
  } else if (status === 429) {
    message = `${providerLabel} rate limit exceeded`;
  } else if (status !== undefined && status >= 500) {
    message = `${providerLabel} service unavailable`;
  }

  return new AgentCoreError("MODEL_FAILURE", message, {
    diagnostic: {
      code: "MODEL_FAILURE",
      severity: "error",
      message,
    },
    cause: error,
  });
}

export function formatToolResultContent(
  message: Extract<ModelMessage, { role: "tool" }>,
): string {
  const parts: string[] = [];
  parts.push(`status=${message.status}`);
  if (message.summary) {
    parts.push(message.summary);
  }
  if (message.output !== undefined) {
    try {
      parts.push(JSON.stringify(message.output));
    } catch {
      parts.push(String(message.output));
    }
  }
  if (message.diagnostic) {
    try {
      parts.push(JSON.stringify(shapeDiagnosticForToolResult(message.diagnostic)));
    } catch {
      parts.push(message.diagnostic.message);
    }
  }
  return parts.join("\n").slice(0, 8_000);
}

export function ensureObjectSchema(
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const schema: Record<string, unknown> =
    inputSchema && typeof inputSchema === "object" ? { ...inputSchema } : {};
  if (schema.type === undefined) {
    schema.type = "object";
  }
  return schema;
}
