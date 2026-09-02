import { betterAuth } from "better-auth";

/**
 * Minimal Better Auth config used only by the Better Auth CLI to generate
 * the Drizzle schema. Runtime auth uses `createAuth()` with the real DB.
 */
export const auth = betterAuth({
  secret: "cli-only-secret-that-is-at-least-32-characters-long",
  baseURL: "http://localhost:3000",
  emailAndPassword: {
    enabled: true,
  },
});
