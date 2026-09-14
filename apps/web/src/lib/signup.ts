/**
 * Build-time gate for the sign-up UI. Server still enforces ALLOW_SIGNUP —
 * this only hides links/forms so closed deploys do not advertise signup.
 *
 * Unset / anything other than "false" keeps signup visible (local default).
 */
export function isSignupAllowed(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_SIGNUP !== "false";
}
