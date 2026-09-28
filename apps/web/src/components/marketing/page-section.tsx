import type { ReactNode } from "react";

/**
 * Shared header rhythm for every public content page: mono index and label,
 * serif statement, lead — left-aligned to the page grid.
 */
export function PageSection({
  index,
  label,
  title,
  lead,
  children,
}: {
  index: string;
  label: string;
  title: string;
  lead: string;
  children?: ReactNode;
}) {
  return (
    <section>
      <div className="os-container py-20 sm:py-24">
        <p className="os-label">
          <span className="text-primary">{index}</span>
          <span aria-hidden="true" className="px-2.5 text-[var(--rule)]">
            /
          </span>
          {label}
        </p>
        <h1 className="os-display mt-5 max-w-[24ch] text-[26px] leading-[1.15] sm:text-[32px]">
          {title}
        </h1>
        <p className="os-lead mt-4 max-w-[54ch] text-[16px] sm:text-[16.5px]">
          {lead}
        </p>
        {children}
      </div>
    </section>
  );
}

export function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 10" className={className} aria-hidden="true">
      <path
        d="M1.5 5.4 3.7 7.6 8.5 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
