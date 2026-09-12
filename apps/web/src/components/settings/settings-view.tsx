"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { AiModelsSettings } from "@/components/settings/ai-models-settings";
import { StorageSettings } from "@/components/settings/storage-settings";
import { Button } from "@/components/ui/button";
import { PageError, PageLoading } from "@/components/ui/page-state";
import { userFacingError } from "@/components/files/format";
import { fetchMe, type Me } from "@/lib/api";
import { signOut } from "@/lib/auth-client";
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
  const router = useRouter();
  const { themePreference, setThemePreference } = useTheme();
  const [section, setSection] = React.useState<SettingsSection>("account");
  const [me, setMe] = React.useState<Me | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    setSection(sectionFromHash());
    function onHash() {
      setSection(sectionFromHash());
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  React.useEffect(() => {
    void fetchMe()
      .then((user) => setMe(user))
      .catch((err) =>
        setError(userFacingError(err, "Could not load account.")),
      );
  }, []);

  function selectSection(next: SettingsSection) {
    setSection(next);
    const hash = hashForSection(next);
    if (window.location.hash.replace(/^#/, "") !== hash) {
      window.history.replaceState(null, "", `#${hash}`);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    router.push("/sign-in");
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
                  : "text-ink-soft hover:bg-sunken hover:text-ink",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {section === "account" ? (
        <section>
          <div className="rounded-[var(--radius-md)] border border-line bg-surface px-4 py-4">
            {error ? (
              <PageError message={error} />
            ) : me === null ? (
              <PageLoading variant="settings" />
            ) : (
              <dl className="space-y-3 text-[12.5px]">
                <div>
                  <dt className="text-[10.5px] text-ink-faint">Name</dt>
                  <dd className="font-medium text-ink">{me.name}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-ink-faint">Email</dt>
                  <dd className="font-medium text-ink">{me.email}</dd>
                </div>
              </dl>
            )}
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={signingOut}
                onClick={() => void handleSignOut()}
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

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
                        : "text-ink-soft hover:bg-sunken hover:text-ink")
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
