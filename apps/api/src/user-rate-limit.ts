import type { FastifyReply } from "fastify";

/**
 * Alpha limits for authenticated, high-cost writes. This state is process-local
 * and resets when the API restarts; move it to shared storage only when the API
 * runs more than one instance.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const alphaUserRateLimits = {
  agentRun: [
    { limit: 10, windowMs: HOUR_MS },
    { limit: 40, windowMs: DAY_MS },
  ],
  documentWrite: [{ limit: 20, windowMs: HOUR_MS }],
  workspaceCreate: [{ limit: 10, windowMs: DAY_MS }],
} as const;

export type UserRateLimitName = keyof typeof alphaUserRateLimits;
export type UserRateLimitPolicy = Record<
  UserRateLimitName,
  readonly { readonly limit: number; readonly windowMs: number }[]
>;

export interface UserRateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface UserRateLimiter {
  consume(userId: string, name: UserRateLimitName): UserRateLimitResult;
}

export function sendRateLimit(
  reply: FastifyReply,
  result: UserRateLimitResult,
) {
  return reply
    .header("Retry-After", String(result.retryAfterSeconds))
    .status(429)
    .send({
      error: {
        statusCode: 429,
        message: "Too many requests. Try again later.",
        code: "RATE_LIMITED",
      },
    });
}

interface Entry {
  timestamps: number[];
  lastSeenAt: number;
}

export function createUserRateLimiter(
  policy: UserRateLimitPolicy = alphaUserRateLimits,
  now: () => number = Date.now,
): UserRateLimiter {
  const entries = new Map<string, Entry>();
  const longestWindowMs = Math.max(
    ...Object.values(policy).flatMap((rules) =>
      rules.map((rule) => rule.windowMs),
    ),
  );

  function cleanup(currentTime: number): void {
    for (const [key, entry] of entries) {
      if (entry.lastSeenAt <= currentTime - longestWindowMs) entries.delete(key);
    }
  }

  return {
    consume(userId, name) {
      const currentTime = now();
      cleanup(currentTime);
      const key = `${name}:${userId}`;
      const entry = entries.get(key) ?? { timestamps: [], lastSeenAt: currentTime };
      entry.timestamps = entry.timestamps.filter(
        (timestamp) => timestamp > currentTime - longestWindowMs,
      );
      entry.lastSeenAt = currentTime;
      entries.set(key, entry);

      let retryAt = 0;
      for (const rule of policy[name]) {
        const timestamps = entry.timestamps.filter(
          (timestamp) => timestamp > currentTime - rule.windowMs,
        );
        if (timestamps.length >= rule.limit) {
          retryAt = Math.max(retryAt, timestamps[timestamps.length - rule.limit]! + rule.windowMs);
        }
      }
      if (retryAt) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((retryAt - currentTime) / 1000)),
        };
      }

      entry.timestamps.push(currentTime);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
