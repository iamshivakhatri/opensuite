import type { EmailMessage } from "../types.js";

export interface ResetPasswordEmailParams {
  readonly name: string;
  readonly resetUrl: string;
}

/**
 * Renders the password-reset email. Same visual shell as the verification
 * email — keep both templates in sync when the brand changes.
 */
export function renderResetPasswordEmail(
  params: ResetPasswordEmailParams,
): Omit<EmailMessage, "to"> {
  const { name, resetUrl } = params;
  const firstName = name.trim().split(/\s+/)[0] || "there";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f6f8;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:18px;border:1px solid #e4e7ec;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 0 32px;">
                <div style="display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600;color:#14161a;">
                  <span style="display:inline-block;width:18px;height:18px;border-radius:6px;background:linear-gradient(145deg,#7374F4,#4E4FD0);vertical-align:middle;margin-right:8px;"></span>
                  OpenSuite
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 8px 32px;">
                <h1 style="margin:0;font-size:20px;line-height:1.3;color:#14161a;letter-spacing:-0.02em;">Reset your password</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#626773;">
                  Hi ${escapeHtml(firstName)}, we received a request to reset the password for your OpenSuite account.
                </p>
                <a href="${resetUrl}" style="display:inline-block;background-color:#5b5ce2;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 20px;border-radius:8px;">
                  Reset password
                </a>
                <p style="margin:24px 0 0 0;font-size:12px;line-height:1.6;color:#9297a3;">
                  This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `Hi ${firstName},`,
    "",
    "We received a request to reset the password for your OpenSuite account:",
    resetUrl,
    "",
    "This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.",
  ].join("\n");

  return {
    subject: "Reset your OpenSuite password",
    html,
    text,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
