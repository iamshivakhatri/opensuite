"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { PageError, PageLoading } from "@/components/ui/page-state";
import { userFacingError } from "@/components/files/format";
import { fetchMe, type Me } from "@/lib/api";
import { signOut } from "@/lib/auth-client";
import { useTheme, type ThemePreference } from "@/lib/theme";

const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsView() {
  const router = useRouter();
  const { preference, setPreference } = useTheme();
  const [me, setMe] = React.useState<Me | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    void fetchMe()
      .then((user) => setMe(user))
      .catch((err) =>
        setError(userFacingError(err, "Could not load account.")),
      );
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    router.push("/sign-in");
  }

  return (
    <div className="mx-auto max-w-[640px] px-8 py-8">
      <div className="mb-8">
        <div className="mb-1 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-ink-faint">
          Account
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">
          Settings
        </h1>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
          Account
        </h2>
        <div className="rounded-[14px] border border-line bg-surface px-4 py-4">
          {error ? (
            <PageError message={error} />
          ) : me === null ? (
            <PageLoading label="Loading account…" />
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

      <section>
        <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
          Appearance
        </h2>
        <div className="rounded-[14px] border border-line bg-surface p-2">
          <div className="grid grid-cols-3 gap-1">
            {themeOptions.map((option) => {
              const active = preference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPreference(option.value)}
                  className={
                    "rounded-[10px] px-3 py-2.5 text-[12px] " +
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
    </div>
  );
}
