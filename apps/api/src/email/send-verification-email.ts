import { renderVerificationEmail } from "./templates/verification-email.js";
import type { EmailSender } from "./types.js";

export interface SendVerificationEmailParams {
  readonly to: string;
  readonly name: string;
  readonly verificationUrl: string;
}

/**
 * Sends the OpenSuite account-verification email through the configured
 * {@link EmailSender}. This is the only place that knows the verification
 * email's content — Better Auth just calls this with a user + URL.
 */
export async function sendVerificationEmail(
  sender: EmailSender,
  params: SendVerificationEmailParams,
): Promise<void> {
  const { subject, html, text } = renderVerificationEmail({
    name: params.name,
    verificationUrl: params.verificationUrl,
  });

  await sender.send({ to: params.to, subject, html, text });
}
