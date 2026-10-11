import type { InfraRetryPolicy } from "./types.js";

/**
 * Transient-error retry is delegated to the AI SDK's provider-aware
 * `maxRetries` (see `streamTurn`). This module only holds the default budget
 * and the abort helper the loop needs.
 */
export const DEFAULT_INFRA_RETRY: InfraRetryPolicy = {
  maxRetries: 2,
};

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Agent run aborted");
}
