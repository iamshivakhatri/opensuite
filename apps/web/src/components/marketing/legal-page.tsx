import type { ReactNode } from "react";

import { SiteShell } from "@/components/marketing/site-shell";

export type LegalSection = {
  /** Anchor id — also used by the contents list. */
  id: string;
  title: string;
  body: ReactNode;
};

/**
 * Legal documents are typeset as documents: one narrow measure, serif
 * section titles, hairline rules, and a contents list in the margin on wide
 * screens. No cards, no marketing type.
 */
export function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <SiteShell>
      <header className="border-b border-line">
        <div className="os-container py-14 sm:py-20">
          <p className="os-label">Legal</p>
          <h1 className="os-display mt-5 text-[32px] leading-[1.1] sm:text-[40px]">
            {title}
          </h1>
          <p className="os-annot mt-4">Last updated {updated}</p>
        </div>
      </header>

      <div className="os-container grid gap-12 py-14 sm:py-16 lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-16">
        <article className="max-w-[40rem]">
          <div className="os-prose">{intro}</div>

          {sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="mt-12 scroll-mt-28 border-t border-line pt-8"
            >
              <h2 className="os-display text-[21px] leading-[1.25]">
                {section.title}
              </h2>
              <div className="os-prose mt-3.5">{section.body}</div>
            </section>
          ))}
        </article>

        {/* Contents — margin navigation on wide screens only. */}
        <nav
          aria-label="Contents"
          className="hidden lg:sticky lg:top-28 lg:block lg:self-start"
        >
          <h2 className="os-label">Contents</h2>
          <ol className="mt-4 space-y-2.5">
            {sections.map((section, index) => (
              <li key={section.id} className="flex gap-3">
                <span className="os-annot shrink-0 pt-[3px] text-[11px]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <a
                  href={`#${section.id}`}
                  className="text-[13.5px] leading-[1.5] text-ink-soft transition-colors hover:text-ink"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </SiteShell>
  );
}
