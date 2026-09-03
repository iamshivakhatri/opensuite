import { Resend } from "resend";

import type { EmailMessage, EmailSender } from "./types.js";

export interface ResendEmailSenderConfig {
  readonly apiKey: string;
  readonly from: string;
}

/**
 * Resend-backed implementation of {@link EmailSender}. Delivery failures
 * throw with Resend's error message so callers (e.g. Better Auth hooks)
 * can surface a generic failure without exposing provider internals to
 * end users.
 */
export function createResendEmailSender(
  config: ResendEmailSenderConfig,
): EmailSender {
  const client = new Resend(config.apiKey);

  return {
    async send(message: EmailMessage): Promise<void> {
      const result = await client.emails.send({
        from: config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      if (result.error) {
        throw new Error(`Resend failed to send email: ${result.error.message}`);
      }
    },
  };
}
