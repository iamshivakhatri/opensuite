"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BrandPreview } from "./brand-preview";
import type { WorkspaceBrandData } from "@/lib/brand-api";
import { useBrand } from "./use-brand";

const fonts = [
  "Arial",
  "Calibri",
  "Aptos",
  "Times New Roman",
  "Georgia",
  "Verdana",
  "Tahoma",
  "Cambria",
];
const companyFields = [
  { key: "name", label: "Company / organization name", max: 160, type: "text" },
  { key: "website", label: "Website (optional)", max: 500, type: "url" },
  { key: "email", label: "Email (optional)", max: 254, type: "email" },
  { key: "phone", label: "Phone (optional)", max: 80, type: "tel" },
  { key: "address", label: "Address / location (optional)", max: 1000, type: "text" },
] as const;

function TextField({ label, ...props }: React.ComponentProps<typeof Input> & { label: string }) {
  return (
    <label className="block space-y-1.5 text-xs text-ink-soft">
      <span>{label}</span>
      <Input {...props} />
    </label>
  );
}

export function BrandForm({
  workspaceId,
  onDirtyChange,
}: {
  workspaceId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const brand = useBrand(workspaceId);
  const { data, setData } = brand;
  React.useEffect(() => {
    onDirtyChange(brand.dirty || brand.busy);
  }, [brand.dirty, brand.busy, onDirtyChange]);
  React.useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  if (brand.loading)
    return (
      <p role="status" className="text-ink-soft">
        Loading brand settings…
      </p>
    );
  if (brand.loadFailed)
    return (
      <div role="alert" className="space-y-3">
        <p className="text-danger">{brand.error}</p>
        <Button variant="outline" onClick={brand.retry}>
          Retry
        </Button>
      </div>
    );
  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
      <form
        className="min-w-0 space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void brand.save();
        }}
      >
        <fieldset disabled={brand.busy} className="min-w-0 space-y-6 disabled:opacity-70">
          <section className="space-y-3">
            <h2 className="font-medium text-ink">Company</h2>
            {companyFields.map((field) => (
              <TextField
                key={field.key}
                label={field.label}
                required={field.key === "name"}
                type={field.type}
                maxLength={field.max}
                value={data.organization[field.key]}
                onChange={(event) =>
                  setData({
                    ...data,
                    organization: { ...data.organization, [field.key]: event.target.value },
                  })
                }
              />
            ))}
          </section>
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="font-medium text-ink">Logo</h2>
            {brand.logoUrl ? (
              <img
                src={brand.logoUrl}
                alt="Current organization logo"
                className="max-h-20 max-w-48 rounded-[var(--radius-sm)] border border-line bg-white p-2 object-contain"
              />
            ) : null}
            <TextField
              label={`${brand.logoUrl ? "Replace logo" : "Upload logo"} · PNG, JPEG, WebP · up to 2 MB`}
              type="file"
              className="h-auto py-2"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) brand.chooseLogo(file);
                event.target.value = "";
              }}
            />
            {brand.logoUrl || data.logoAssetId ? (
              <Button type="button" variant="outline" size="sm" onClick={brand.removeLogo}>
                Remove logo
              </Button>
            ) : null}
          </section>
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="font-medium text-ink">Colors</h2>
            <ColorFields colors={data.colors} onChange={(colors) => setData({ ...data, colors })} />
          </section>
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="font-medium text-ink">Typography</h2>
            <datalist id="brand-fonts">
              {fonts.map((font) => (
                <option key={font} value={font} />
              ))}
            </datalist>
            {(["headingFont", "bodyFont"] as const).map((key) => (
              <TextField
                key={key}
                label={`${key === "headingFont" ? "Heading font" : "Body font"} (optional)`}
                list="brand-fonts"
                maxLength={100}
                placeholder="Choose or enter a font"
                value={data.typography[key]}
                onChange={(event) =>
                  setData({
                    ...data,
                    typography: { ...data.typography, [key]: event.target.value },
                  })
                }
              />
            ))}
            <p className="os-type-meta text-ink-faint">
              Common document font names. Availability depends on the device opening the document.
            </p>
          </section>
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="font-medium text-ink">Document identity</h2>
            {(["headerText", "footerText"] as const).map((key) => (
              <TextField
                key={key}
                label={`${key === "headerText" ? "Header / letterhead text" : "Footer text"} (optional)`}
                maxLength={2000}
                value={data.document[key]}
                onChange={(event) =>
                  setData({ ...data, document: { ...data.document, [key]: event.target.value } })
                }
              />
            ))}
            {(["showLogo", "showOrganizationName", "showPageNumbers"] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={data.document[key]}
                  onChange={(event) =>
                    setData({
                      ...data,
                      document: { ...data.document, [key]: event.target.checked },
                    })
                  }
                />
                {
                  {
                    showLogo: "Show logo in header",
                    showOrganizationName: "Show organization name in header",
                    showPageNumbers: "Show page numbers",
                  }[key]
                }
              </label>
            ))}
          </section>
        </fieldset>
        {brand.error ? (
          <p role="alert" className="text-sm text-danger">
            {brand.error}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={!brand.dirty || brand.busy || !data.organization.name.trim()}
        >
          {brand.busy ? "Saving…" : "Save"}
        </Button>
      </form>
      <BrandPreview data={data} logoUrl={brand.logoUrl} />
    </div>
  );
}

function ColorFields({
  colors,
  onChange,
}: {
  colors: WorkspaceBrandData["colors"];
  onChange: (colors: WorkspaceBrandData["colors"]) => void;
}) {
  return (
    <>
      {(["primary", "secondary", "accent"] as const).map((key) => (
        <div key={key}>
          <label htmlFor={`brand-${key}`} className="mb-1.5 block text-xs capitalize text-ink-soft">
            {key} (optional)
          </label>
          <div className="flex gap-2">
            <input
              aria-label={`Pick ${key} color`}
              type="color"
              className="h-9 w-10 shrink-0 cursor-pointer rounded border border-line bg-surface p-1"
              value={/^#[0-9a-f]{6}$/i.test(colors[key] ?? "") ? colors[key]! : "#000000"}
              onChange={(event) => onChange({ ...colors, [key]: event.target.value.toUpperCase() })}
            />
            <Input
              id={`brand-${key}`}
              placeholder="#234567"
              pattern="#[0-9a-fA-F]{6}"
              maxLength={7}
              value={colors[key] ?? ""}
              onChange={(event) => onChange({ ...colors, [key]: event.target.value || null })}
            />
          </div>
        </div>
      ))}
    </>
  );
}
