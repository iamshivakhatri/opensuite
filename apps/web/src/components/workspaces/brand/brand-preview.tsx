import type { WorkspaceBrandData } from "@/lib/brand-api";

export function BrandPreview({
  data,
  logoUrl,
}: {
  data: WorkspaceBrandData;
  logoUrl: string | null;
}) {
  const primary = /^#[0-9a-f]{6}$/i.test(data.colors.primary ?? "")
    ? data.colors.primary!
    : "#263D50";
  const accent = /^#[0-9a-f]{6}$/i.test(data.colors.accent ?? "") ? data.colors.accent! : "#687D8B";
  return (
    <aside
      aria-label="Brand preview"
      className="min-w-0 space-y-3 lg:sticky lg:top-0 lg:self-start"
    >
      <p className="os-type-label text-ink-soft">Document preview</p>
      <div
        className="flex min-h-[560px] flex-col border border-line bg-white p-6 text-[#263238] shadow-[var(--elevation-xs)] sm:p-8"
        style={{ fontFamily: data.typography.bodyFont || "Arial, sans-serif" }}
      >
        <div className="mb-8 border-b pb-4" style={{ borderColor: accent }}>
          {data.document.showLogo && logoUrl ? (
            <img
              src={logoUrl}
              alt="Organization logo"
              className="mb-3 max-h-14 max-w-40 object-contain"
            />
          ) : null}
          {data.document.showOrganizationName ? (
            <p className="font-semibold" style={{ color: primary }}>
              {data.organization.name || "Your organization"}
            </p>
          ) : null}
          <p className="mt-1 whitespace-pre-wrap text-xs">{data.document.headerText}</p>
          <p className="mt-1 whitespace-pre-wrap text-xs text-[#59666D]">
            {[
              data.organization.website,
              data.organization.email,
              data.organization.phone,
              data.organization.address,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <h2
          className="mb-5 text-2xl font-semibold"
          style={{
            color: primary,
            fontFamily: data.typography.headingFont || "Arial, sans-serif",
          }}
        >
          Quarterly overview
        </h2>
        <h3
          className="mb-2 font-semibold"
          style={{
            color: primary,
            fontFamily: data.typography.headingFont || "Arial, sans-serif",
          }}
        >
          Our next chapter
        </h3>
        <p className="text-sm leading-relaxed">
          We are building on this quarter’s progress with clear priorities and a shared plan. This
          sample shows how your organization’s identity could feel on a document.
        </p>
        <table className="my-6 w-full border-collapse text-left text-xs">
          <thead>
            <tr style={{ borderBottom: `2px solid ${accent}` }}>
              <th className="py-2">Priority</th>
              <th className="py-2">Focus</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[#E4E8EB]">
              <td className="py-3">Customer experience</td>
              <td className="py-3">Make every step simpler</td>
            </tr>
            <tr>
              <td className="py-3">Team progress</td>
              <td className="py-3">Share what we learn</td>
            </tr>
          </tbody>
        </table>
        <footer
          className="mt-auto flex justify-between gap-3 border-t pt-3 text-[10px]"
          style={{ borderColor: accent }}
        >
          <span className="whitespace-pre-wrap">{data.document.footerText}</span>
          {data.document.showPageNumbers ? <span>1</span> : null}
        </footer>
      </div>
      <p className="os-type-meta text-ink-faint">
        Approximate preview. Preferences are saved for future use; documents are not changed. Fonts
        depend on what is installed.
      </p>
    </aside>
  );
}
