import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { Db } from "@opensuite/db";
import * as schema from "@opensuite/db/schema";

import type { AppConfig } from "../config/index.js";
import {
  sendResetPasswordEmail,
  sendVerificationEmail,
  type EmailSender,
} from "../email/index.js";

/**
 * Builds the Better Auth instance. Email verification is enforced here
 * (`emailAndPassword.requireEmailVerification`), not by the frontend —
 * unverified users cannot obtain a session. Verification and password-reset
 * tokens are Better Auth's own (signed JWTs / verification-table tokens);
 * no custom token logic. Delivery goes through the injected `EmailSender`
 * so Better Auth never talks to Resend (or any provider) directly.
 */
export function createAuth(config: AppConfig, db: Db, emailSender: EmailSender) {
  return betterAuth({
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    trustedOrigins: [...config.webOrigins],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      // Server-enforced gate — UI hiding alone is not enough.
      disableSignUp: !config.allowSignup,
      requireEmailVerification: true,
      // Invalidate existing sessions when a password is reset so a stolen
      // session cookie cannot outlive the credential change.
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await sendResetPasswordEmail(emailSender, {
          to: user.email,
          name: user.name,
          resetUrl: url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      async sendVerificationEmail({ user, url }) {
        await sendVerificationEmail(emailSender, {
          to: user.email,
          name: user.name,
          verificationUrl: url,
        });
      },
    },
    ...(config.google
      ? {
          socialProviders: {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
              // Keep the request to basic OpenID identity only.
              disableDefaultScope: true,
              scope: ["openid", "email", "profile"],
              accessType: "online",
              includeGrantedScopes: false,
              // Match the existing server-side invitation gate for new users.
              disableSignUp: !config.allowSignup,
            },
          },
          account: {
            accountLinking: {
              // Better Auth still requires the local email to be verified.
              // This trusts only Google's verified identity response.
              trustedProviders: ["google"],
            },
          },
        }
      : {}),
    ...(config.authCrossOrigin
      ? {
          advanced: {
            // A genuinely different-site frontend needs SameSite=None; Secure.
            // API must be served over HTTPS for browsers to accept the cookie.
            useSecureCookies: true,
            defaultCookieAttributes: {
              sameSite: "none" as const,
              secure: true,
              partitioned: true,
            },
          },
        }
      : {}),
  });
}

export type Auth = ReturnType<typeof createAuth>;
