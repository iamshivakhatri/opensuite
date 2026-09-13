"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageError, PageLoading } from "@/components/ui/page-state";
import { userFacingError } from "@/components/files/format";
import {
  connectProviderCredential,
  deleteProviderCredential,
  fetchAiPreference,
  fetchAiTrial,
  listProviderCredentials,
  saveAiPreference,
} from "@/lib/ai-settings-api";
import {
  AI_PROVIDERS,
  BYOK_MODEL_PLACEHOLDERS,
  PROVIDER_LABELS,
  activeModeSummary,
  buildByokPreferencePayload,
  buildManagedPreferencePayload,
  clearedApiKeyAfterSuccess,
  isProviderConnected,
  modeFromPreference,
  trialDisplay,
  type AiMode,
  type AiPreference,
  type AiProvider,
  type AiTrialStatus,
  type PublicProviderCredential,
} from "@/lib/ai-settings-model";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type ConnectTarget = {
  readonly provider: AiProvider;
  readonly replacing: boolean;
};

export function AiModelsSettings() {
  const { toast } = useToast();

  const [preference, setPreference] = React.useState<AiPreference | null>(null);
  const [preferenceLoading, setPreferenceLoading] = React.useState(true);
  const [preferenceError, setPreferenceError] = React.useState<string | null>(
    null,
  );

  const [credentials, setCredentials] = React.useState<
    PublicProviderCredential[] | null
  >(null);
  const [credentialsLoading, setCredentialsLoading] = React.useState(true);
  const [credentialsError, setCredentialsError] = React.useState<string | null>(
    null,
  );

  const [trial, setTrial] = React.useState<AiTrialStatus | null>(null);
  const [trialLoading, setTrialLoading] = React.useState(true);
  const [trialError, setTrialError] = React.useState<string | null>(null);

  const [mode, setMode] = React.useState<AiMode>("managed");
  const [draftByokProvider, setDraftByokProvider] =
    React.useState<AiProvider>("openai");
  const [draftByokModel, setDraftByokModel] = React.useState("");
  const [savingPreference, setSavingPreference] = React.useState(false);

  const [connectTarget, setConnectTarget] = React.useState<ConnectTarget | null>(
    null,
  );
  const [apiKeyDraft, setApiKeyDraft] = React.useState("");
  const [connectBusy, setConnectBusy] = React.useState(false);
  const [connectError, setConnectError] = React.useState<string | null>(null);

  const [removeProvider, setRemoveProvider] = React.useState<AiProvider | null>(
    null,
  );
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  const loadPreference = React.useCallback(async () => {
    setPreferenceLoading(true);
    setPreferenceError(null);
    try {
      const next = await fetchAiPreference();
      setPreference(next);
      const nextMode = modeFromPreference(next);
      setMode(nextMode);
      if (next?.credentialSource === "byok") {
        setDraftByokProvider(next.provider);
        setDraftByokModel(next.model);
      }
    } catch (error) {
      setPreferenceError(userFacingError(error, "Could not load AI preference."));
    } finally {
      setPreferenceLoading(false);
    }
  }, []);

  const loadCredentials = React.useCallback(async () => {
    setCredentialsLoading(true);
    setCredentialsError(null);
    try {
      setCredentials(await listProviderCredentials());
    } catch (error) {
      setCredentialsError(
        userFacingError(error, "Could not load provider keys."),
      );
    } finally {
      setCredentialsLoading(false);
    }
  }, []);

  const loadTrial = React.useCallback(async () => {
    setTrialLoading(true);
    setTrialError(null);
    try {
      setTrial(await fetchAiTrial());
    } catch (error) {
      setTrialError(userFacingError(error, "Could not load trial status."));
    } finally {
      setTrialLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadPreference();
    void loadCredentials();
    void loadTrial();
  }, [loadPreference, loadCredentials, loadTrial]);

  const byokConnected =
    credentials !== null &&
    isProviderConnected(credentials, draftByokProvider);

  const activeIsManaged =
    !preference || preference.credentialSource === "managed";

  async function switchToManaged() {
    setMode("managed");
    if (activeIsManaged || savingPreference) return;
    setSavingPreference(true);
    try {
      const saved = await saveAiPreference(buildManagedPreferencePayload());
      setPreference(saved);
      toast({
        tone: "success",
        title: "Using OpenSuite managed",
      });
    } catch (error) {
      toast({
        tone: "error",
        title: "Could not switch to managed AI",
        description: userFacingError(error, "Please try again."),
      });
      // Keep the BYOK form visible if the switch failed.
      setMode("byok");
    } finally {
      setSavingPreference(false);
    }
  }

  async function handleSaveByokPreference() {
    if (savingPreference) return;
    setSavingPreference(true);
    try {
      if (!byokConnected) {
        throw new Error(
          `Connect a ${PROVIDER_LABELS[draftByokProvider]} key before saving.`,
        );
      }
      const model = draftByokModel.trim();
      if (!model) {
        throw new Error("Enter a model id for your provider.");
      }
      const saved = await saveAiPreference(
        buildByokPreferencePayload(draftByokProvider, model),
      );
      setPreference(saved);
      setMode("byok");
      toast({
        tone: "success",
        title: "AI preference saved",
      });
    } catch (error) {
      toast({
        tone: "error",
        title: "Could not save preference",
        description: userFacingError(error, "Please try again."),
      });
    } finally {
      setSavingPreference(false);
    }
  }

  async function handleConnectSubmit() {
    if (!connectTarget || connectBusy) return;
    const key = apiKeyDraft.trim();
    if (!key) {
      setConnectError("API key is required.");
      return;
    }
    setConnectBusy(true);
    setConnectError(null);
    try {
      const credential = await connectProviderCredential({
        provider: connectTarget.provider,
        apiKey: key,
      });
      setApiKeyDraft(clearedApiKeyAfterSuccess());
      setConnectTarget(null);
      setCredentials((current) => {
        const next = (current ?? []).filter(
          (row) => row.provider !== credential.provider,
        );
        return [...next, credential];
      });
      toast({
        tone: "success",
        title: connectTarget.replacing
          ? `${PROVIDER_LABELS[connectTarget.provider]} key replaced`
          : `${PROVIDER_LABELS[connectTarget.provider]} key connected`,
      });
    } catch (error) {
      setConnectError(userFacingError(error, "Could not save API key."));
    } finally {
      setConnectBusy(false);
    }
  }

  async function handleRemoveConfirm() {
    if (!removeProvider || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await deleteProviderCredential(removeProvider);
      setCredentials(
        (current) =>
          (current ?? []).filter((row) => row.provider !== removeProvider),
      );
      setRemoveProvider(null);
      toast({
        tone: "success",
        title: `${PROVIDER_LABELS[removeProvider]} key removed`,
      });
    } catch (error) {
      setRemoveError(userFacingError(error, "Could not remove key."));
    } finally {
      setRemoveBusy(false);
    }
  }

  const trialUi = trial ? trialDisplay(trial) : null;
  const summary = activeModeSummary({ preference, credentials });

  return (
    <div className="space-y-8">
      <div className="rounded-[var(--radius-md)] border border-line bg-sunken/40 px-3.5 py-2.5">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
          Active for agent runs
        </div>
        <div className="mt-0.5 truncate text-[12.5px] font-medium text-ink">
          {preferenceLoading ? "Loading…" : summary}
        </div>
      </div>

      <section>
        <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
          AI mode
        </h2>
        <p className="mb-3 text-[12px] text-ink-soft">
          Choose how OpenSuite runs the document agent.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <ModeCard
            selected={mode === "managed"}
            title="OpenSuite managed"
            description="No personal API key required. Uses your OpenSuite trial credits."
            disabled={savingPreference || preferenceLoading}
            onSelect={() => void switchToManaged()}
          />
          <ModeCard
            selected={mode === "byok"}
            title="Bring your own key"
            description="You pay your model provider directly. Does not use OpenSuite trial credits."
            disabled={savingPreference || preferenceLoading}
            onSelect={() => setMode("byok")}
          />
        </div>
        {preferenceError ? (
          <div className="mt-3">
            <PageError
              message={preferenceError}
              onRetry={() => void loadPreference()}
            />
          </div>
        ) : null}
      </section>

      {mode === "managed" ? (
        <section>
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            Trial credits
          </h2>
          <p className="mb-3 text-[12px] text-ink-soft">
            OpenSuite picks the model. Credits apply only to managed AI.
          </p>
          {trialLoading ? (
            <PageLoading variant="inline" />
          ) : trialError ? (
            <PageError message={trialError} onRetry={() => void loadTrial()} />
          ) : trialUi ? (
            <div className="rounded-[var(--radius-md)] border border-line bg-surface px-3.5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[13px] font-medium text-ink">
                  {trialUi.statusLabel}
                </div>
                <div
                  className={cn(
                    "text-[13px] font-semibold tabular-nums",
                    trialUi.kind === "available"
                      ? "text-ink"
                      : trialUi.kind === "exhausted"
                        ? "text-danger"
                        : "text-ink-soft",
                  )}
                >
                  {trialUi.balanceLabel}
                </div>
              </div>
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-sunken"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={trialUi.totalCredits}
                aria-valuenow={trialUi.remainingCredits}
                aria-label="Trial credits remaining"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${trialUi.fillPercent}%` }}
                />
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {mode === "byok" ? (
        <section>
          <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            Your provider & model
          </h2>
          <p className="mb-3 text-[12px] text-ink-soft">
            Connect a provider key, then enter the model id to use.
          </p>
          <div className="space-y-4">
            <div>
              <Label className="mb-1.5 block">Provider</Label>
              <div className="grid grid-cols-3 gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-1">
                {AI_PROVIDERS.map((provider) => {
                  const active = draftByokProvider === provider;
                  return (
                    <button
                      key={provider}
                      type="button"
                      disabled={savingPreference}
                      onClick={() => {
                        setDraftByokProvider(provider);
                        if (!draftByokModel.trim()) {
                          setDraftByokModel(BYOK_MODEL_PLACEHOLDERS[provider]);
                        }
                      }}
                      className={cn(
                        "rounded-[var(--radius-sm)] px-2 py-2 text-[12px]",
                        active
                          ? "bg-accent-soft font-semibold text-accent-hover"
                          : "text-ink-soft hover:bg-primary-soft hover:text-primary",
                      )}
                    >
                      {PROVIDER_LABELS[provider]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label className="mb-1.5 block">API key</Label>
              {credentialsLoading ? (
                <PageLoading variant="inline" />
              ) : credentialsError ? (
                <PageError
                  message={credentialsError}
                  onRetry={() => void loadCredentials()}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface px-3.5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">
                      {PROVIDER_LABELS[draftByokProvider]}
                    </div>
                    <div
                      className={cn(
                        "text-[11.5px]",
                        byokConnected ? "text-success" : "text-ink-faint",
                      )}
                    >
                      {byokConnected ? "Connected" : "Not connected"}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setApiKeyDraft("");
                        setConnectError(null);
                        setConnectTarget({
                          provider: draftByokProvider,
                          replacing: byokConnected,
                        });
                      }}
                    >
                      {byokConnected ? "Replace key" : "Connect key"}
                    </Button>
                    {byokConnected ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:bg-danger-soft hover:text-danger"
                        onClick={() => {
                          setRemoveError(null);
                          setRemoveProvider(draftByokProvider);
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>

            <div>
              <Label htmlFor="byok-model" className="mb-1.5 block">
                Model id
              </Label>
              <Input
                id="byok-model"
                value={draftByokModel}
                disabled={savingPreference || !byokConnected}
                placeholder={BYOK_MODEL_PLACEHOLDERS[draftByokProvider]}
                onChange={(event) => setDraftByokModel(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="mt-1.5 text-[11px] text-ink-faint">
                {byokConnected
                  ? `Example: ${BYOK_MODEL_PLACEHOLDERS[draftByokProvider]}`
                  : `Connect a ${PROVIDER_LABELS[draftByokProvider]} key before entering a model id.`}
              </p>
            </div>

            <div>
              <Button
                type="button"
                size="sm"
                disabled={
                  savingPreference ||
                  preferenceLoading ||
                  !byokConnected ||
                  !draftByokModel.trim()
                }
                onClick={() => void handleSaveByokPreference()}
              >
                {savingPreference ? "Saving…" : "Save preference"}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {connectTarget ? (
        <Dialog
          title={
            connectTarget.replacing
              ? `Replace ${PROVIDER_LABELS[connectTarget.provider]} key`
              : `Connect ${PROVIDER_LABELS[connectTarget.provider]}`
          }
          onClose={() => {
            if (connectBusy) return;
            setApiKeyDraft(clearedApiKeyAfterSuccess());
            setConnectTarget(null);
          }}
          closeOnOverlayClick={!connectBusy}
        >
          <p className="mb-3 text-[12.5px] text-ink-soft">
            Paste your {PROVIDER_LABELS[connectTarget.provider]} API key. It is
            sent securely and never shown again.
          </p>
          <Label htmlFor="provider-api-key" className="mb-1.5 block">
            API key
          </Label>
          <Input
            id="provider-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKeyDraft}
            disabled={connectBusy}
            onChange={(event) => setApiKeyDraft(event.target.value)}
            placeholder="••••••••••••••••"
          />
          {connectError ? (
            <p className="mt-2 text-[12px] text-danger">{connectError}</p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={connectBusy}
              onClick={() => {
                setApiKeyDraft(clearedApiKeyAfterSuccess());
                setConnectTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={connectBusy}
              onClick={() => void handleConnectSubmit()}
            >
              {connectBusy ? "Saving…" : "Save key"}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {removeProvider ? (
        <ConfirmDialog
          title={`Remove ${PROVIDER_LABELS[removeProvider]} key?`}
          body={
            <>
              Future agent runs that use your {PROVIDER_LABELS[removeProvider]}{" "}
              key will stop working until you connect another.
            </>
          }
          confirmLabel={removeBusy ? "Removing…" : "Remove key"}
          tone="danger"
          busy={removeBusy}
          error={removeError}
          onCancel={() => {
            if (removeBusy) return;
            setRemoveProvider(null);
          }}
          onConfirm={() => void handleRemoveConfirm()}
        />
      ) : null}
    </div>
  );
}

function ModeCard({
  selected,
  title,
  description,
  onSelect,
  disabled = false,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "rounded-[var(--radius-md)] border px-3.5 py-3 text-left transition-colors",
        selected
          ? "border-accent bg-accent-soft/60"
          : "border-line bg-surface hover:border-ink-faint",
        disabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-3.5 w-3.5 items-center justify-center rounded-full border",
            selected
              ? "border-accent bg-accent"
              : "border-ink-faint bg-surface",
          )}
          aria-hidden
        >
          {selected ? (
            <span className="h-1.5 w-1.5 rounded-full bg-on-ink" />
          ) : null}
        </span>
        <span className="text-[13px] font-semibold text-ink">{title}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-soft">
        {description}
      </p>
    </button>
  );
}
