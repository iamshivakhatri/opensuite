import { renderResetPasswordEmail } from "./templates/reset-password-email.js";
import type { EmailSender } from "./types.js";

export interface SendResetPasswordEmailParams {
  readonly to: string;
  readonly name: string;
  readonly resetUrl: string;
}

/**
 * Sends the OpenSuite password-reset email through the configured
 * {@link EmailSender}. Better Auth only supplies the user + URL; this is
 * the only place that knows the email content.
 */
export async function sendResetPasswordEmail(
  sender: EmailSender,
  params: SendResetPasswordEmailParams,
): Promise<void> {
  const { subject, html, text } = renderResetPasswordEmail({
    name: params.name,
    resetUrl: params.resetUrl,
  });

  await sender.send({ to: params.to, subject, html, text });
}
