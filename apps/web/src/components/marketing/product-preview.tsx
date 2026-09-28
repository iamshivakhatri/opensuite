/**
 * Reconstruction of the OpenSuite workspace — explorer, document canvas,
 * agent panel — built from the same tokens as the real shell rather than an
 * invented marketing dashboard. Presentational only: real strings, no live
 * data, no interactivity.
 *
 * The frame is aria-hidden; the visible <figcaption> in the landing page
 * carries the meaning for assistive technology.
 */

const explorerFiles = [
  { name: "Monthly-Report.docx", active: true },
  { name: "Onboarding-Guide.docx", active: false },
  { name: "Q3-Plan.docx", active: false },
];

const tableRows = [
  { item: "Revenue", before: "412,900", after: "468,300" },
  { item: "New accounts", before: "138", after: "171" },
  { item: "Churn", before: "2.1%", after: "1.8%" },
];

const activity = [
  "Read document structure",
  "Found 6 mentions of August",
  "Replaced 6 values in the table",
  "Re-checked totals after saving",
];

export function ProductPreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[6px] border border-[var(--rule)] bg-surface shadow-[0_1px_1px_rgba(25,25,23,0.03),0_24px_60px_-30px_rgba(25,25,23,0.22)]"
    >
      {/* Top rail — document tabs, matching the workspace rail height. */}
      <div className="flex h-10 items-center gap-1 border-b border-line bg-surface pr-3 pl-2">
        <div className="flex h-7 items-center gap-2 rounded-[3px] border border-line bg-paper px-2.5">
          <DocGlyph className="h-3 w-3 text-primary" />
          <span className="text-[11.5px] font-medium text-ink">
            Monthly-Report.docx
          </span>
        </div>
        <div className="hidden h-7 items-center gap-2 px-2.5 sm:flex">
          <DocGlyph className="h-3 w-3 text-ink-faint" />
          <span className="text-[11.5px] text-ink-faint">Q3-Plan.docx</span>
        </div>
        <div className="ml-auto os-annot text-[11px]">v7 · saved</div>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Explorer */}
        <div className="hidden w-[176px] shrink-0 flex-col gap-4 border-r border-line bg-sidebar px-2.5 py-3.5 lg:flex">
          <div>
            <div className="os-label px-1.5 text-[10.5px]">Workspace</div>
            <div className="mt-2.5 flex flex-col gap-0.5">
              {explorerFiles.map((file) => (
                <div
                  key={file.name}
                  className={
                    "flex items-center gap-2 rounded-[3px] px-1.5 py-1.5 text-[11.5px] " +
                    (file.active
                      ? "bg-primary-soft font-medium text-ink"
                      : "text-ink-soft")
                  }
                >
                  <DocGlyph
                    className={
                      "h-3 w-3 " +
                      (file.active ? "text-primary" : "text-ink-faint")
                    }
                  />
                  <span className="truncate">{file.name}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="os-label px-1.5 text-[10.5px]">Versions</div>
            <div className="mt-2.5 flex flex-col gap-1.5 px-1.5 os-annot text-[11px]">
              <span className="text-ink">v7 · just now</span>
              <span>v6 · Aug 4</span>
              <span>v5 · Jul 2</span>
            </div>
          </div>
        </div>

        {/* Document canvas */}
        <div className="min-w-0 flex-1 bg-[var(--canvas)] px-5 py-6 sm:px-8 sm:py-8">
          <div className="mx-auto max-w-[420px] bg-white px-7 py-7 shadow-[0_1px_2px_rgba(25,25,23,0.06),0_10px_30px_-18px_rgba(25,25,23,0.25)]">
            <p className="text-[8px] uppercase tracking-[0.14em] text-[#9a968c]">
              Internal · Finance
            </p>
            <h3 className="mt-2 text-[13px] font-semibold tracking-[-0.01em] text-[#1d1d1a]">
              Monthly Report — September
            </h3>
            <p className="mt-2.5 text-[8.5px] leading-[1.75] text-[#4a4a44]">
              Performance held through the quarter. Revenue and account growth
              both improved against the prior month, and churn continued to
              fall for the third consecutive period.
            </p>

            <table className="mt-4 w-full border-collapse text-[8.5px]">
              <thead>
                <tr className="border-b border-[#ddd9cf] text-left text-[7.5px] uppercase tracking-[0.1em] text-[#8a867c]">
                  <th className="py-1.5 font-medium">Line item</th>
                  <th className="py-1.5 font-medium">August</th>
                  <th className="py-1.5 font-medium">September</th>
                </tr>
              </thead>
              <tbody className="text-[#31312c]">
                {tableRows.map((row) => (
                  <tr key={row.item} className="border-b border-[#eeebe2]">
                    <td className="py-1.5">{row.item}</td>
                    <td className="py-1.5 text-[#75736a]">{row.before}</td>
                    <td className="bg-primary-soft py-1.5 pl-1.5 font-medium text-primary">
                      {row.after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-4 text-[8.5px] leading-[1.75] text-[#4a4a44]">
              Headcount, pricing, and the regional breakdown are unchanged from
              the August edition of this report.
            </p>
          </div>
        </div>

        {/* Agent panel */}
        <div className="flex w-full shrink-0 flex-col border-t border-line bg-surface md:w-[240px] md:border-t-0 md:border-l lg:w-[268px]">
          <div className="flex h-9 items-center justify-between border-b border-line px-3">
            <span className="text-[11.5px] font-medium text-ink">Agent</span>
            <span className="os-annot text-[11px]">run 7</span>
          </div>

          <div className="flex-1 space-y-3 px-3 py-3.5">
            <p className="rounded-[4px] bg-sunken px-2.5 py-2 text-[11.5px] leading-[1.6] text-ink">
              Update this monthly report with the September numbers.
            </p>

            <ul className="space-y-2">
              {activity.map((step) => (
                <li
                  key={step}
                  className="flex items-start gap-2 text-[11.5px] leading-[1.55] text-ink-soft"
                >
                  <CheckGlyph className="mt-[3px] h-2.5 w-2.5 shrink-0 text-primary" />
                  {step}
                </li>
              ))}
            </ul>

            <p className="text-[11.5px] leading-[1.6] text-ink">
              Updated the three September figures in the summary table and left
              the rest of the report untouched.
            </p>

            <div className="flex items-center gap-2 border-t border-line pt-3 os-annot text-[11px]">
              <span className="text-ink">Updated document · 19s</span>
            </div>
          </div>

          <div className="m-3 mt-0 rounded-[4px] border border-line bg-paper px-2.5 py-2">
            <span className="text-[11.5px] text-ink-faint">Ask OpenSuite…</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DocGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden="true">
      <rect
        x="1.75"
        y="0.75"
        width="8.5"
        height="10.5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path
        d="M4 4h4M4 6h4M4 8h2.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckGlyph({ className }: { className?: string }) {
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
