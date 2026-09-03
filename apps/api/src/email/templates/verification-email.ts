import type { EmailMessage } from "../types.js";

export interface VerificationEmailParams {
  readonly name: string;
  readonly verificationUrl: string;
}

/**
 * Renders the account verification email. Kept as a plain function (not a
 * templating engine) — OpenSuite only sends a handful of transactional
 * emails; introduce a real template system if/when that changes.
 */
export function renderVerificationEmail(
  params: VerificationEmailParams,
): Omit<EmailMessage, "to"> {
  const { name, verificationUrl } = params;
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
                <h1 style="margin:0;font-size:20px;line-height:1.3;color:#14161a;letter-spacing:-0.02em;">Verify your email</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#626773;">
                  Hi ${escapeHtml(firstName)}, confirm this is your email address to finish setting up your OpenSuite account.
                </p>
                <a href="${verificationUrl}" style="display:inline-block;background-color:#5b5ce2;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 20px;border-radius:8px;">
                  Verify your email
                </a>
                <p style="margin:24px 0 0 0;font-size:12px;line-height:1.6;color:#9297a3;">
                  This link expires in 1 hour. If you didn't create an OpenSuite account, you can safely ignore this email.
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
    "Confirm this is your email address to finish setting up your OpenSuite account:",
    verificationUrl,
    "",
    "This link expires in 1 hour. If you didn't create an OpenSuite account, you can safely ignore this email.",
  ].join("\n");

  return {
    subject: "Verify your email for OpenSuite",
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
