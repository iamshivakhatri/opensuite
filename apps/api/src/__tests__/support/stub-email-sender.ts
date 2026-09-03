import type { EmailMessage, EmailSender } from "../../email/index.js";

/**
 * Captures sent messages instead of calling a real provider. Used by tests
 * that need to exercise the real Better Auth verification flow (token
 * generation, `/verify-email`, sign-in gating) without a live Resend API
 * key or network access.
 */
export function createStubEmailSender(): EmailSender & {
  readonly sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];

  return {
    sent,
    async send(message: EmailMessage): Promise<void> {
      sent.push(message);
    },
  };
}

/**
 * Extracts the action URL Better Auth embedded in an email body
 * (`href="..."` in the HTML part), so tests can "click" verification or
 * password-reset links.
 */
export function extractEmailActionUrl(message: EmailMessage): string {
  const match = /href="([^"]+)"/.exec(message.html);
  if (!match?.[1]) {
    throw new Error("No action URL found in email message");
  }
  return match[1];
}

/** @deprecated Prefer {@link extractEmailActionUrl}. */
export const extractVerificationUrl = extractEmailActionUrl;
