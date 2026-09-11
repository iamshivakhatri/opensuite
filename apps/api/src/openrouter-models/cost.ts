import { MICRO_USD_PER_USD } from "../model-usage/pricing.js";

/**
 * Marker stored in model_usage_event.cost_source for OpenRouter usage.cost.
 * This is the total amount charged to our OpenRouter account for the request
 * (not upstream_inference_cost).
 */
export const OPENROUTER_USAGE_COST_SOURCE = "openrouter_usage_cost";

/**
 * Convert a USD amount to integer micro-USD (1 USD = 1_000_000).
 *
 * Accepts number or decimal string. Rounds half-up to the nearest micro-USD
 * when the provider returns more than 6 fractional digits.
 * Missing / invalid / negative → null (never invent zero from absence).
 * Explicit 0 is preserved as 0.
 */
export function usdToCostMicros(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  let normalized: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    if (value === 0) {
      return 0;
    }
    // Deterministic decimal form (avoid locale / scientific notation surprises).
    normalized = trimTrailingZeros(value.toFixed(20));
  } else if (typeof value === "string") {
    normalized = value.trim();
    if (!normalized) {
      return null;
    }
  } else {
    return null;
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parts = normalized.split(".");
  const wholePart = parts[0] ?? "0";
  const fracPart = parts[1] ?? "";
  const microsDigits = fracPart.slice(0, 6).padEnd(6, "0");
  const seventhChar = fracPart.length > 6 ? fracPart.charAt(6) : "";
  const seventh = seventhChar === "" ? 0 : Number(seventhChar);
  if (!Number.isInteger(seventh)) {
    return null;
  }

  let micros = BigInt(wholePart) * BigInt(MICRO_USD_PER_USD) + BigInt(microsDigits);
  if (seventh >= 5) {
    micros += 1n;
  }

  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(micros);
}

function trimTrailingZeros(fixed: string): string {
  if (!fixed.includes(".")) {
    return fixed;
  }
  return fixed.replace(/\.?0+$/, "") || "0";
}
