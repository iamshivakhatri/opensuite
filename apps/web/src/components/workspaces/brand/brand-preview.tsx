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
  const secondary = /^#[0-9a-f]{6}$/i.test(data.colors.secondary ?? "")
    ? data.colors.secondary!
    : "#59666D";
  const accent = /^#[0-9a-f]{6}$/i.test(data.colors.accent ?? "") ? data.colors.accent! : "#687D8B";
  const headingStyle = {
    color: primary,
    fontFamily: data.typography.headingFont || "Arial, sans-serif",
  };
  return (
    <aside
      aria-label="Brand preview"
      className="min-w-0 space-y-3 lg:sticky lg:top-0 lg:self-start"
    >
      <p className="os-type-label text-ink-soft">Brand preview</p>
      <div
        className="space-y-6 rounded-[var(--radius-sm)] border border-line bg-white p-6 text-[#263238] sm:p-8"
        style={{ fontFamily: data.typography.bodyFont || "Arial, sans-serif" }}
      >
        <div className="flex flex-wrap items-center gap-3">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt="Organization logo"
              className="max-h-14 max-w-32 object-contain"
            />
          ) : null}
          <p className="break-words font-semibold" style={{ color: primary }}>
            {data.organization.name || "Your organization"}
          </p>
        </div>
        <div className="flex gap-2" aria-label="Brand colors">
          {[primary, secondary, accent].map((color, index) => (
            <span
              key={index}
              className="h-2 flex-1 rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <div>
          <h2 className="mb-3 text-2xl font-semibold" style={headingStyle}>
            Brand heading
          </h2>
          <p className="text-sm leading-relaxed">
            This preview shows how your organization’s fonts and colors could appear when branding
            is appropriate.
          </p>
        </div>
        <div>
          <h3 className="mb-2 font-semibold" style={headingStyle}>
            Section heading
          </h3>
          <p className="text-sm leading-relaxed">
            Clear priorities and a shared focus help bring an organization’s identity to life.
          </p>
        </div>
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr style={{ borderBottom: `2px solid ${accent}` }}>
              <th className="py-2">Priority</th>
              <th className="py-2">Focus</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[#E4E8EB]">
              <td className="py-3">Clarity</td>
              <td className="py-3">Make each message easy to understand</td>
            </tr>
            <tr>
              <td className="py-3">Consistency</td>
              <td className="py-3">Build a recognizable identity</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="os-type-meta text-ink-faint">
        Approximate brand preview. Document structure and branding usage depend on the document and
        request.
      </p>
    </aside>
  );
}
