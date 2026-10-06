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
const contactFields = [
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
  const fileInput = React.useRef<HTMLInputElement>(null);
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
            <h2 className="font-medium text-ink">Organization</h2>
            <div className="grid gap-4 sm:grid-cols-[112px_minmax(0,1fr)]">
              <div className="space-y-2">
                <div className="grid h-24 place-items-center rounded-[var(--radius-sm)] border border-line bg-surface p-3">
                  {brand.logoUrl ? (
                    <img
                      src={brand.logoUrl}
                      alt="Organization logo"
                      className="max-h-16 max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-ink-faint">Logo</span>
                  )}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  aria-label="Choose organization logo"
                  className="hidden"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) brand.chooseLogo(file);
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => fileInput.current?.click()}
                >
                  {brand.logoUrl || data.logoAssetId ? "Replace logo" : "Upload logo"}
                </Button>
                {brand.logoUrl || data.logoAssetId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={brand.removeLogo}
                  >
                    Remove logo
                  </Button>
                ) : null}
              </div>
              <div className="min-w-0 space-y-3">
                <TextField
                  label="Company / organization name"
                  required
                  maxLength={160}
                  value={data.organization.name}
                  onChange={(event) =>
                    setData({
                      ...data,
                      organization: { ...data.organization, name: event.target.value },
                    })
                  }
                />
                <TextField
                  label="Website (optional)"
                  type="url"
                  maxLength={500}
                  value={data.organization.website}
                  onChange={(event) =>
                    setData({
                      ...data,
                      organization: { ...data.organization, website: event.target.value },
                    })
                  }
                />
                <p className="os-type-meta text-ink-faint">Logo: PNG, JPEG, or WebP · up to 2 MB</p>
              </div>
            </div>
          </section>
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="font-medium text-ink">Brand colors</h2>
            <ColorFields colors={data.colors} onChange={(colors) => setData({ ...data, colors })} />
          </section>
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="font-medium text-ink">Typography</h2>
            <p className="os-type-meta text-ink-soft">
              Preferred fonts OpenSuite can use when branding is appropriate.
            </p>
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
              Font availability depends on the device opening the document.
            </p>
          </section>
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="font-medium text-ink">Contact information</h2>
            {contactFields.map((field) => (
              <TextField
                key={field.key}
                label={field.label}
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
    <div className="grid gap-3 sm:grid-cols-3">
      {(["primary", "secondary", "accent"] as const).map((key) => (
        <div key={key} className="min-w-0">
          <label htmlFor={`brand-${key}`} className="mb-1.5 block text-xs capitalize text-ink-soft">
            {key} (optional)
          </label>
          <div className="flex gap-1.5">
            <input
              aria-label={`Pick ${key} color`}
              type="color"
              className="h-9 w-8 shrink-0 cursor-pointer rounded border border-line bg-surface p-1"
              value={/^#[0-9a-f]{6}$/i.test(colors[key] ?? "") ? colors[key]! : "#000000"}
              onChange={(event) => onChange({ ...colors, [key]: event.target.value.toUpperCase() })}
            />
            <Input
              id={`brand-${key}`}
              className="min-w-0 px-2 text-xs"
              placeholder="#234567"
              pattern="#[0-9a-fA-F]{6}"
              maxLength={7}
              value={colors[key] ?? ""}
              onChange={(event) => onChange({ ...colors, [key]: event.target.value || null })}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
