import Link from "next/link";

import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { ProductPreview } from "@/components/marketing/product-preview";
import { isSignupAllowed } from "@/lib/signup";
import { GITHUB_URL } from "@/lib/site";

const values = [
  {
    title: "Works with the real document",
    body: "The agent inspects and edits your actual DOCX through a document engine — not a copy pasted into a chat window.",
  },
  {
    title: "Preservation-first editing",
    body: "Supported edits use typed operations, and each saved change becomes a new document version.",
  },
  {
    title: "Open source",
    body: "The engine and application are developed in the open. Read the code, self-host it, or contribute.",
  },
];

const roadmap = [
  { name: "Word", status: "Available now", available: true },
  { name: "Slides", status: "Coming later", available: false },
  { name: "Sheets", status: "Coming later", available: false },
];

export function LandingPage() {
  return (
    <div className="os-theme-dark min-h-screen overflow-x-hidden bg-paper text-ink">
      <SiteHeader />

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-5 pt-16 pb-14 sm:px-8 sm:pt-24 sm:pb-20">
        <div className="max-w-2xl">
          <p className="mb-5 text-[13px] font-medium text-primary">
            Open-source AI workspace · DOCX today
          </p>
          <h1 className="text-[34px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[44px]">
            An open-source AI workspace for editing real Word documents.
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-soft sm:text-[16px]">
            Open a DOCX, then ask an agent to inspect it and make supported,
            targeted changes. Slides and Sheets are planned, not available yet.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={isSignupAllowed() ? "/sign-up" : "/sign-in"}
              className="rounded-[var(--radius-sm)] bg-primary px-5 py-2.5 text-[14px] font-medium text-on-ink transition-colors hover:bg-primary-hover"
            >
              Get started
            </Link>
            <Link
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-[var(--radius-sm)] border border-line px-5 py-2.5 text-[14px] font-medium text-ink-soft transition-colors hover:border-primary-line hover:text-ink"
            >
              View on GitHub
            </Link>
          </div>
        </div>
      </section>

      {/* Product visual */}
      <section id="product" className="px-5 pb-20 sm:px-8">
        <ProductPreview />
      </section>

      {/* Value */}
      <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-3 sm:gap-8">
          {values.map((value) => (
            <div key={value.title}>
              <h3 className="text-[16px] font-medium text-ink">
                {value.title}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
                {value.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Roadmap */}
      <section className="mx-auto max-w-6xl border-t border-line/70 px-5 py-16 sm:px-8">
        <h2 className="text-[13px] font-medium uppercase tracking-wide text-ink-faint">
          Product roadmap
        </h2>
        <div className="mt-6 divide-y divide-line/70 border-y border-line/70">
          {roadmap.map((item) => (
            <div
              key={item.name}
              className="flex items-center justify-between py-4"
            >
              <span className="text-[16px] font-medium text-ink">
                {item.name}
              </span>
              <span
                className={
                  "text-[13px] " +
                  (item.available ? "font-medium text-primary" : "text-ink-faint")
                }
              >
                {item.status}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Open source / trust */}
      <section
        id="open-source"
        className="mx-auto max-w-6xl px-5 py-16 sm:px-8"
      >
        <div className="max-w-2xl">
          <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-ink">
            Built in the open
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
            OpenSuite's application and document engine are developed
            publicly. Read the source, follow the roadmap, or run it
            yourself.
          </p>
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-primary hover:text-primary-hover"
          >
            View the repository on GitHub →
          </Link>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-line/70 px-5 py-20 text-center sm:px-8">
        <h2 className="text-[26px] font-semibold tracking-[-0.01em] text-ink">
          Try OpenSuite
        </h2>
        <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-ink-soft">
          Bring a Word document and see the agent work with it directly.
        </p>
        <div className="mt-7">
          <Link
            href={isSignupAllowed() ? "/sign-up" : "/sign-in"}
            className="inline-flex rounded-[var(--radius-sm)] bg-primary px-6 py-2.5 text-[14px] font-medium text-on-ink transition-colors hover:bg-primary-hover"
          >
            Get started
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
