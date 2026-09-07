import { AgentCoreError } from "./errors.js";

/**
 * Normalize model-facing optional semantic occurrence fields.
 *
 * Convention (version-local, 1-based when present):
 *   omitted / null / "" / 0  → undefined (default / first unique match)
 *   1, 2, 3, …               → kept
 *   negatives / floats / junk → invalid
 *
 * Apply BEFORE positive-integer validation so `0` never fails the tool.
 */
export function normalizeOptionalOccurrence(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value === 0) {
    return undefined;
  }
  return value;
}

/**
 * Parse optional 1-based occurrence for AgentTool inputs.
 * Returns undefined when the model sent a omit-sentinel.
 */
export function parseOptionalOccurrence(
  value: unknown,
  label: string,
): number | undefined {
  const normalized = normalizeOptionalOccurrence(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (
    typeof normalized !== "number" ||
    !Number.isInteger(normalized) ||
    normalized < 1
  ) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} must be a positive integer when provided (omit unless disambiguating; never send 0)`,
    );
  }
  return normalized;
}
