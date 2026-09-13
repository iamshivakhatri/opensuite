"use client";

import * as React from "react";

import { AccountSettings } from "@/components/settings/account-settings";
import { AiModelsSettings } from "@/components/settings/ai-models-settings";
import { StorageSettings } from "@/components/settings/storage-settings";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type SettingsSection = "account" | "ai" | "storage" | "appearance";

const sections: Array<{ id: SettingsSection; label: string }> = [
  { id: "account", label: "Account" },
  { id: "ai", label: "AI & Models" },
  { id: "storage", label: "Storage" },
  { id: "appearance", label: "Appearance" },
];

function sectionFromHash(): SettingsSection {
  if (typeof window === "undefined") return "account";
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "ai" || hash === "ai-models") return "ai";
  if (hash === "storage") return "storage";
  if (hash === "appearance") return "appearance";
  return "account";
}

function hashForSection(section: SettingsSection): string {
  if (section === "ai") return "ai";
  if (section === "storage") return "storage";
  if (section === "appearance") return "appearance";
  return "account";
}

export function SettingsView() {
  const { themePreference, setThemePreference } = useTheme();
  const [section, setSection] = React.useState<SettingsSection>("account");

  React.useEffect(() => {
    setSection(sectionFromHash());
    function onHash() {
      setSection(sectionFromHash());
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function selectSection(next: SettingsSection) {
    setSection(next);
    const hash = hashForSection(next);
    if (window.location.hash.replace(/^#/, "") !== hash) {
      window.history.replaceState(null, "", `#${hash}`);
    }
  }

  const sectionLabel =
    sections.find((item) => item.id === section)?.label ?? "Settings";

  return (
    <div className="mx-auto max-w-[640px] px-8 py-8">
      <div className="mb-6">
        <div className="mb-1 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-ink-faint">
          Settings
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">
          {sectionLabel}
        </h1>
      </div>

      <nav
        aria-label="Settings sections"
        className="mb-8 grid grid-cols-2 gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-1 sm:grid-cols-4"
      >
        {sections.map((item) => {
          const active = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => selectSection(item.id)}
              className={cn(
                "rounded-[var(--radius-sm)] px-2 py-2 text-[12px]",
                active
                  ? "bg-accent-soft font-semibold text-accent-hover"
                  : "text-ink-soft hover:bg-primary-soft hover:text-primary",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {section === "account" ? <AccountSettings /> : null}

      {section === "ai" ? <AiModelsSettings /> : null}

      {section === "storage" ? <StorageSettings /> : null}

      {section === "appearance" ? (
        <section>
          <div className="rounded-[var(--radius-md)] border border-line bg-surface p-2">
            <div className="grid grid-cols-3 gap-1">
              {themeOptions.map((option) => {
                const active = themePreference === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setThemePreference(option.value)}
                    className={
                      "rounded-[var(--radius-sm)] px-3 py-2.5 text-[12px] " +
                      (active
                        ? "bg-accent-soft font-semibold text-accent-hover"
                        : "text-ink-soft hover:bg-primary-soft hover:text-primary")
                    }
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
