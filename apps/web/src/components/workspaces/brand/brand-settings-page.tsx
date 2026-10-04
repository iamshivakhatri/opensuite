"use client";
import * as React from "react";
import { BrandForm } from "./brand-form";
import { SavedStyles } from "./saved-styles";

export function BrandSettingsPage({
  workspaceId,
  onDirtyChange,
}: {
  workspaceId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [tab, setTab] = React.useState<"brand" | "styles">("brand");
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-canvas p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Brand &amp; Styles</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Configure your workspace identity and manage your saved document styles.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Brand and styles"
          className="flex gap-5 border-b border-line"
        >
          {(["brand", "styles"] as const).map((value, index) => (
            <button
              key={value}
              id={`tab-${value}`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              aria-controls={`panel-${value}`}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "brand"
                      : event.key === "End"
                        ? "styles"
                        : index === 0
                          ? "styles"
                          : "brand";
                  setTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }
              }}
              className={`border-b-2 pb-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === value ? "border-primary font-medium text-ink" : "border-transparent text-ink-soft"}`}
            >
              {value === "brand" ? "Brand" : "Saved Styles"}
            </button>
          ))}
        </div>
        <div id="panel-brand" role="tabpanel" aria-labelledby="tab-brand" hidden={tab !== "brand"}>
          <BrandForm workspaceId={workspaceId} onDirtyChange={onDirtyChange} />
        </div>
        <div
          id="panel-styles"
          role="tabpanel"
          aria-labelledby="tab-styles"
          hidden={tab !== "styles"}
        >
          {tab === "styles" ? <SavedStyles /> : null}
        </div>
      </div>
    </main>
  );
}
