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
    trustedOrigins: [config.webOrigin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
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
  });
}

export type Auth = ReturnType<typeof createAuth>;
