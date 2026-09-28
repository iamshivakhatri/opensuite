import { Source_Serif_4 } from "next/font/google";

/**
 * Display serif for the public site only (landing, legal, auth, 404).
 *
 * Declared here rather than in the root layout so Next preloads it on public
 * routes and leaves the signed-in workspace shell on Inter alone. Consumed
 * through `--font-site-serif` by `.os-display` / `.os-prose h2` in
 * globals.css, so no component hard-codes a font family.
 */
export const siteSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-site-serif",
});
