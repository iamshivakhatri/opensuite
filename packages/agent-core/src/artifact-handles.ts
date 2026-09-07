/**
 * Run-local opaque artifact-handle lifetime.
 *
 * Structural handles are positional and version-bound. The registry maps
 * handle → originating versionId. It does not parse handle syntax.
 *
 * Global capabilities are separate and not refreshed on N→N+1.
 */

import { AgentCoreError } from "./errors.js";
import type { ToolExecutionContext } from "./model.js";

/** handle → versionId that last returned this opaque handle via inspection. */
export class ArtifactHandleRegistry {
  private readonly originByHandle = new Map<string, string>();

  /** Associate an opaque handle with the version that produced it. */
  register(handle: string, versionId: string): void {
    if (!handle) return;
    this.originByHandle.set(handle, versionId);
  }

  registerAll(versionId: string, handles: readonly string[]): void {
    for (const handle of handles) {
      this.register(handle, versionId);
    }
  }

  /** Originating versionId, or undefined if never observed in this run. */
  origin(handle: string): string | undefined {
    return this.originByHandle.get(handle);
  }

  get size(): number {
    return this.originByHandle.size;
  }
}

/**
 * Collect opaque `handle` strings from an inspection payload (or any JSON-like tree).
 * Does not interpret handle syntax or document structure — only property name `handle`.
 */
export function collectOpaqueHandles(value: unknown): string[] {
  const found = new Set<string>();
  walkForHandles(value, found, "inspect");
  return [...found];
}

/**
 * Collect opaque handles from tool input.
 * Includes `handle` and `*Handle` keys (e.g. afterColumnHandle) without parsing values.
 */
export function collectOpaqueHandlesFromToolInput(value: unknown): string[] {
  const found = new Set<string>();
  walkForHandles(value, found, "input");
  return [...found];
}

function walkForHandles(
  value: unknown,
  found: Set<string>,
  mode: "inspect" | "input",
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkForHandles(item, found, mode);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isHandlePropertyKey(key, mode) && typeof child === "string" && child) {
      found.add(child);
    } else {
      walkForHandles(child, found, mode);
    }
  }
}

function isHandlePropertyKey(key: string, mode: "inspect" | "input"): boolean {
  if (key === "handle") {
    return true;
  }
  // Tool inputs may use afterColumnHandle, etc. Inspection payloads use `handle` only.
  return mode === "input" && key.endsWith("Handle");
}

/**
 * Ensure every structural handle in tool input was observed from the current
 * RunDocumentState version. Semantic-only inputs (no handles) pass through.
 */
export function requireCurrentArtifactHandles(
  ctx: ToolExecutionContext,
  toolInput: unknown,
): void {
  const handles = collectOpaqueHandlesFromToolInput(toolInput);
  if (handles.length === 0) {
    return;
  }

  const document = ctx.primaryDocument;
  if (!document) {
    throw handleError("UNKNOWN_HANDLE", handles[0]!);
  }

  const registry = ctx.handles;
  if (!registry) {
    throw handleError("UNKNOWN_HANDLE", handles[0]!);
  }

  for (const handle of handles) {
    const origin = registry.origin(handle);
    if (origin === undefined) {
      throw handleError("UNKNOWN_HANDLE", handle);
    }
    if (origin !== document.versionId) {
      throw handleError("STALE_HANDLE", handle);
    }
  }
}

function handleError(
  code: "STALE_HANDLE" | "UNKNOWN_HANDLE",
  handle: string,
): AgentCoreError {
  const message =
    code === "STALE_HANDLE"
      ? "Structural handle is stale for the current document version; re-inspect before using handles again"
      : "Structural handle was not returned by inspection in this run; inspect before using handles";
  return new AgentCoreError(code, message, {
    diagnostic: {
      code,
      severity: "error",
      message,
      // Opaque handle only — never expose version UUIDs to the model.
      details: { handle },
    },
  });
}
