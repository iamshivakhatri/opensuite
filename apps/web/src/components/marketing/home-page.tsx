import Link from "next/link";

import { BrandStyleSection } from "@/components/marketing/brand-style-section";
import { GitHubMark } from "@/components/marketing/github-mark";
import { MarketingClose } from "@/components/marketing/marketing-close";
import { CheckGlyph } from "@/components/marketing/page-section";
import { ProductDemo } from "@/components/marketing/product-demo";
import { SiteButton } from "@/components/marketing/site-button";
import { SiteShell } from "@/components/marketing/site-shell";
import { GITHUB_URL } from "@/lib/site";
import { isSignupAllowed } from "@/lib/signup";

const heroFacts = ["MIT licensed", "Self-hostable", "Bring your own model key"];

const trust = [
  {
    title: "It edits your file, not a copy",
    body: "OpenSuite opens the real .docx and changes only what you asked for, through typed operations. Layout, numbering, headers, and anything it doesn’t support stay as they were.",
  },
  {
    title: "Every run is a version",
    body: "A run saves once, as a new version. Read the result, open any of the latest five versions, or restore one as current.",
  },
  {
    title: "Open, and yours to run",
    body: "MIT licensed, with the document engine in its own public repository. Use your own OpenAI, Anthropic, or OpenRouter key, on your own infrastructure.",
  },
];

const worksToday = [
  "Create, edit, download, and version DOCX files",
  "Targeted edits to text, formatting, and tables",
  "Styles, headers and footers, comments, tracked changes",
  "Brand and saved styles applied by the agent",
];

const notYet = [
  "Editing slides and sheets — PPTX and XLSX are storable only",
  "Full fidelity on complex or unusual source documents",
  "A one-command local stack for self-hosting",
];

export function HomePage() {
  const startHref = isSignupAllowed() ? "/sign-up" : "/sign-in";

  return (
    <SiteShell>
      <section className="os-container pt-16 pb-12 sm:pt-24 sm:pb-14">
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
          Ask for a change to a Word document. OpenSuite reads its structure,
          makes the edit through a deterministic document engine, and saves the
          result as a new version. What you didn&apos;t ask about stays exactly
          as it was.
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
        <ProductDemo />
      </section>

      <section className="os-container pb-20 sm:pb-24">
        <div className="border-t border-[var(--rule)] pt-14 sm:pt-16">
          <p className="os-label text-primary">Why you can trust the result</p>
          <h2 className="os-display mt-5 max-w-[24ch] text-[26px] leading-[1.15] sm:text-[32px]">
            Built so a change on page nine doesn&apos;t reformat page one.
          </h2>
          <ul className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-3">
            {trust.map((item, index) => (
              <li key={item.title} className="border-t border-line pt-5">
                <span className="os-label text-primary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-3 text-[17px] font-medium tracking-[-0.01em] text-ink">
                  {item.title}
                </h3>
                <p className="mt-2.5 text-[14.5px] leading-[1.65] text-ink-soft">
                  {item.body}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-10 text-[14px]">
            <Link
              href="/principles"
              className="text-primary underline-offset-2 hover:underline"
            >
              Read the principles →
            </Link>
          </p>
        </div>
      </section>

      <BrandStyleSection />

      <section className="os-container py-20 sm:py-24">
        <div className="border-t border-[var(--rule)] pt-14 sm:pt-16">
          <p className="os-label text-primary">Where it stands</p>
          <h2 className="os-display mt-5 max-w-[24ch] text-[26px] leading-[1.15] sm:text-[32px]">
            Alpha, and honest about it.
          </h2>
          <div className="mt-10 grid gap-10 lg:grid-cols-2 lg:gap-14">
            <div>
              <h3 className="os-label">Works today</h3>
              <ul className="mt-4 border-t border-line">
                {worksToday.map((item) => (
                  <li
                    key={item}
                    className="flex gap-3 border-b border-line py-3.5 text-[14.5px] leading-[1.6] text-ink-soft"
                  >
                    <CheckGlyph className="mt-[7px] h-2.5 w-2.5 shrink-0 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="os-label">Not yet</h3>
              <ul className="mt-4 border-t border-line">
                {notYet.map((item) => (
                  <li
                    key={item}
                    className="flex gap-3 border-b border-line py-3.5 text-[14.5px] leading-[1.6] text-ink-faint"
                  >
                    <span
                      className="mt-[11px] h-px w-2.5 shrink-0 bg-[var(--rule)]"
                      aria-hidden="true"
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-8 text-[14px]">
            <Link
              href="/scope"
              className="text-primary underline-offset-2 hover:underline"
            >
              The full list →
            </Link>
          </p>
        </div>
      </section>

      <MarketingClose />
    </SiteShell>
  );
}
