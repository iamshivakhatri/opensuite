"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { PageError, PageLoading } from "@/components/ui/page-state";
import { userFacingError } from "@/components/files/format";
import {
  fetchAiPreference,
  listProviderCredentials,
} from "@/lib/ai-settings-api";
import { activeModeSummary } from "@/lib/ai-settings-model";
import { fetchMe, type Me } from "@/lib/api";
import { signOut } from "@/lib/auth-client";
import { fetchStorageStatus } from "@/lib/storage-api";
import { storageUsedOfQuotaLabel } from "@/lib/storage-model";
import { useTheme, type ThemePreference } from "@/lib/theme";

const APPEARANCE_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function OverviewRow({
  label,
  value,
  loading,
  error,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}) {
  return (
    <div>
      <dt className="text-[10.5px] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-[12.5px] font-medium text-ink">
        {loading ? (
          <span className="font-normal text-ink-faint">Loading…</span>
        ) : error ? (
          <span className="font-normal text-danger">{error}</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/**
 * Account tab: identity + read-only glance at AI / storage / appearance.
 */
export function AccountSettings() {
  const router = useRouter();
  const { themePreference } = useTheme();

  const [me, setMe] = React.useState<Me | null>(null);
  const [meError, setMeError] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);

  const [aiSummary, setAiSummary] = React.useState<string | null>(null);
  const [aiLoading, setAiLoading] = React.useState(true);
  const [aiError, setAiError] = React.useState<string | null>(null);

  const [storageSummary, setStorageSummary] = React.useState<string | null>(
    null,
  );
  const [storageLoading, setStorageLoading] = React.useState(true);
  const [storageError, setStorageError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void fetchMe()
      .then((user) => setMe(user))
      .catch((err) =>
        setMeError(userFacingError(err, "Could not load account.")),
      );
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setAiLoading(true);
    setAiError(null);
    void Promise.all([fetchAiPreference(), listProviderCredentials()])
      .then(([preference, credentials]) => {
        if (cancelled) return;
        setAiSummary(activeModeSummary({ preference, credentials }));
      })
      .catch((err) => {
        if (cancelled) return;
        setAiError(userFacingError(err, "Could not load AI status."));
      })
      .finally(() => {
        if (!cancelled) setAiLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setStorageLoading(true);
    setStorageError(null);
    void fetchStorageStatus()
      .then((status) => {
        if (cancelled) return;
        setStorageSummary(storageUsedOfQuotaLabel(status));
      })
      .catch((err) => {
        if (cancelled) return;
        setStorageError(userFacingError(err, "Could not load storage."));
      })
      .finally(() => {
        if (!cancelled) setStorageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    router.push("/sign-in");
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[var(--radius-md)] border border-line bg-surface px-4 py-4">
        {meError ? (
          <PageError message={meError} />
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
      </section>

      <section className="rounded-[var(--radius-md)] border border-line bg-surface px-4 py-4">
        <h2 className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
          At a glance
        </h2>
        <dl className="space-y-3">
          <OverviewRow
            label="AI for agent runs"
            value={aiSummary}
            loading={aiLoading}
            error={aiError}
          />
          <OverviewRow
            label="Storage"
            value={storageSummary}
            loading={storageLoading}
            error={storageError}
          />
          <OverviewRow
            label="Appearance"
            value={APPEARANCE_LABELS[themePreference]}
            loading={false}
            error={null}
          />
        </dl>
      </section>
    </div>
  );
}
