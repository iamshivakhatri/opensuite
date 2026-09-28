/**
 * Public-site constants — single source of truth for marketing pages
 * (`/`, `/product`, `/how-it-works`, `/privacy`, `/terms`, …).
 */

/** Real repository URL — do not invent a different one. */
export const GITHUB_URL = "https://github.com/iamshivakhatri/opensuite";

/** Separate Rust document engine repository (see docs/architecture.md). */
export const ENGINE_GITHUB_URL = "https://github.com/opensuite/opensuite-engine";

/** Contribution guide that ships in this repository. */
export const CONTRIBUTING_URL = `${GITHUB_URL}/blob/main/CONTRIBUTING.md`;

/** Clone command shown verbatim in the open-source section. */
export const CLONE_COMMAND = `git clone ${GITHUB_URL}.git`;

/** Canonical public domain referenced in copy per product decision. */
export const SITE_URL = "https://opensuite.tech";

/** Public support/contact address shown on every legal + footer surface. */
export const SUPPORT_EMAIL = "support@opensuite.tech";
