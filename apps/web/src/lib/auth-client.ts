import { createAuthClient } from "better-auth/react";

/**
 * apps/web (Next.js/Vercel) and apps/api (Fastify) are separate origins even
 * in local development (different ports on localhost). This client talks to
 * the API's Better Auth handler at `${NEXT_PUBLIC_API_URL}/api/auth/*`.
 * Better Auth's client automatically sends `credentials: "include"`, and the
 * API's CORS + `trustedOrigins` config (see apps/api/src/app.ts) is what
 * allows the session cookie to flow across origins.
 */
const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;

if (!apiBaseUrl) {
  throw new Error(
    "NEXT_PUBLIC_API_URL is not set. Copy apps/web/.env.example to apps/web/.env.local and set it to the apps/api base URL.",
  );
}

export const authClient = createAuthClient({
  baseURL: apiBaseUrl,
});

export const { signIn, signUp, signOut, useSession } = authClient;
