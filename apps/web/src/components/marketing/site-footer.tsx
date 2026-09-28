import Link from "next/link";

import { SiteWordmark } from "@/components/marketing/site-wordmark";
import {
  CONTRIBUTING_URL,
  ENGINE_GITHUB_URL,
  GITHUB_URL,
  SUPPORT_EMAIL,
} from "@/lib/site";
import { SITE_PRODUCT_LINKS } from "@/lib/site-nav";

const columns = [
  {
    label: "Product",
    links: SITE_PRODUCT_LINKS.map((link) => ({
      href: link.href,
      label: link.label,
    })),
  },
  {
    label: "Project",
    links: [
      { href: GITHUB_URL, label: "Application repository", external: true },
      { href: ENGINE_GITHUB_URL, label: "Document engine", external: true },
      { href: CONTRIBUTING_URL, label: "Contributing", external: true },
      { href: "/open-source", label: "Open source" },
    ],
  },
  {
    label: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: `mailto:${SUPPORT_EMAIL}`, label: "Contact" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-paper">
      <div className="os-container grid gap-12 py-14 sm:grid-cols-2 sm:gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-xs">
          <SiteWordmark />
          <p className="mt-3.5 text-[13.5px] leading-relaxed text-ink-soft">
            An open-source AI workspace for editing real Word documents
            through a deterministic document engine.
          </p>
        </div>

        {columns.map((column) => (
          <nav key={column.label} aria-label={column.label}>
            <h2 className="os-label">{column.label}</h2>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    {...("external" in link && link.external
                      ? { target: "_blank", rel: "noreferrer noopener" }
                      : null)}
                    className="text-[13.5px] text-ink-soft transition-colors hover:text-primary"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="os-container flex flex-col gap-2 border-t border-line py-7 text-[12.5px] text-ink-faint sm:flex-row sm:items-center sm:justify-between">
        <p>© {new Date().getFullYear()} OpenSuite. MIT licensed.</p>
        <p className="os-annot">
          <span className="text-secondary">Alpha</span>
          <span aria-hidden="true" className="px-2 text-[var(--rule)]">
            ·
          </span>
          DOCX editing
          <span aria-hidden="true" className="px-2 text-[var(--rule)]">
            ·
          </span>
          self-hostable
        </p>
      </div>
    </footer>
  );
}
