/**
 * Public-site navigation — single source for header, footer, and 404 links.
 * Paths are real App Router pages (no hash sliding).
 */

export const SITE_PRIMARY_NAV = [
  { href: "/product", label: "Product" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/open-source", label: "Open source" },
] as const;

export const SITE_PRODUCT_LINKS = [
  { href: "/product", label: "Workspace" },
  { href: "/how-it-works", label: "How a run works" },
  { href: "/principles", label: "Principles" },
  { href: "/architecture", label: "Architecture" },
  { href: "/scope", label: "Scope today" },
  { href: "/sign-in", label: "Sign in" },
] as const;
