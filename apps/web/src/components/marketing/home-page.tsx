import Link from "next/link";

import { GitHubMark } from "@/components/marketing/github-mark";
import { MarketingClose } from "@/components/marketing/marketing-close";
import { ProductPreview } from "@/components/marketing/product-preview";
import { SiteButton } from "@/components/marketing/site-button";
import { SiteShell } from "@/components/marketing/site-shell";
import { GITHUB_URL } from "@/lib/site";
import { isSignupAllowed } from "@/lib/signup";

const heroFacts = ["MIT licensed", "Self-hostable", "Bring your own model key"];

export function HomePage() {
  const startHref = isSignupAllowed() ? "/sign-up" : "/sign-in";

  return (
    <SiteShell>
      <section className="os-container pt-16 pb-14 sm:pt-24 sm:pb-16">
        <p className="os-label">
          <span className="text-primary">Open source</span>
          <span aria-hidden="true" className="px-2.5 text-[var(--rule)]">
            ·
          </span>
          DOCX
          <span aria-hidden="true" className="px-2.5 text-[var(--rule)]">
            ·
          </span>
          Alpha
        </p>
        <h1 className="os-display mt-6 max-w-[15em] text-[36px] leading-[1.06] sm:text-[48px] lg:text-[56px]">
          An agent that edits the document, not a copy of it.
        </h1>
        <p className="os-lead mt-7 max-w-[52ch]">
          OpenSuite opens your real .docx, reads its structure, and makes the
          change you asked for through typed operations in a deterministic
          document engine. What you didn&apos;t ask about stays exactly as it
          was.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <SiteButton href={startHref}>Try OpenSuite</SiteButton>
          <SiteButton href="/how-it-works" variant="outline">
            How a run works
          </SiteButton>
          <SiteButton href={GITHUB_URL} variant="ghost" external>
            <GitHubMark className="h-4 w-4" />
            Source
          </SiteButton>
        </div>

        <ul className="mt-12 flex flex-col gap-2.5 border-t border-line pt-5 sm:flex-row sm:items-center sm:gap-0">
          {heroFacts.map((fact, index) => (
            <li
              key={fact}
              className={
                "os-label " +
                (index === 0 ? "sm:pr-6" : "sm:border-l sm:border-line sm:px-6")
              }
            >
              {fact}
            </li>
          ))}
        </ul>
      </section>

      <section className="os-container pb-20 sm:pb-24">
        <figure>
          <ProductPreview />
          <figcaption className="mt-4 flex flex-col justify-between gap-1 os-annot sm:flex-row sm:items-baseline">
            <span>
              Fig. 1 — The workspace: file explorer, the open DOCX, and the
              agent panel that ran the change.
            </span>
            <Link
              href="/product"
              className="shrink-0 text-[12px] text-secondary transition-colors hover:text-primary"
            >
              Product details →
            </Link>
          </figcaption>
        </figure>
      </section>

      <MarketingClose />
    </SiteShell>
  );
}
