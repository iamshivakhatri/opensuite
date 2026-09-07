"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { DocxEditorRef } from "@casualoffice/docs";

import {
  ApiError,
  fetchDocumentVersionContent,
  getDocument,
  saveDocumentVersion,
  type ListedDocument,
} from "@/lib/api";
import { clearCasualLocalAutosave } from "@/lib/casual-autosave";
import { userFacingError } from "@/components/files/format";
import { ConfirmDialog } from "@/components/ui/context-menu";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";

const DocxEditorHost = dynamic(
  () =>
    import("./docx-editor-host").then((mod) => ({
      default: mod.DocxEditorHost,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-canvas">
        <p className="text-[12px] text-ink-faint">Loading editor…</p>
      </div>
    ),
  },
);

type LoadPhase = "loading" | "ready" | "error";

export type DocxSurfaceStatus = {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly loadedVersionId: string | null;
  readonly latestVersionId: string | null;
};

/**
 * Host-owned DOCX surface: loads exact OpenSuite version bytes into Casual
 * Docs, edits locally, and saves via appendDocumentVersion (explicit only).
 */
export function DocxSurface({
  document,
  onStatusChange,
  onDocumentUpdated,
  saveRequestId = 0,
}: {
  readonly document: ListedDocument;
  readonly onStatusChange?: (status: DocxSurfaceStatus) => void;
  readonly onDocumentUpdated?: (document: ListedDocument) => void;
  /** Bump to request an explicit save (header Save / Cmd+S from parent). */
  readonly saveRequestId?: number;
}) {
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const editorRef = React.useRef<DocxEditorRef | null>(null);
  const selectionRef = React.useRef<unknown>(null);
  const savingRef = React.useRef(false);
  const lastSaveRequestId = React.useRef(0);
  /** Ignore Casual dirty=true churn right after remount/agent reload. */
  const suppressDirtyRef = React.useRef(false);
  const suppressDirtyTimerRef = React.useRef<number | null>(null);

  const [phase, setPhase] = React.useState<LoadPhase>("loading");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [buffer, setBuffer] = React.useState<ArrayBuffer | null>(null);
  const [editorKey, setEditorKey] = React.useState(0);
  const [loadedVersionId, setLoadedVersionId] = React.useState<string | null>(
    null,
  );
  const [latestVersionId, setLatestVersionId] = React.useState(
    document.latestVersion.id,
  );
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState(false);
  const [reloadOpen, setReloadOpen] = React.useState(false);

  const beginSuppressDirty = React.useCallback(() => {
    suppressDirtyRef.current = true;
    if (suppressDirtyTimerRef.current !== null) {
      window.clearTimeout(suppressDirtyTimerRef.current);
    }
    suppressDirtyTimerRef.current = window.setTimeout(() => {
      suppressDirtyRef.current = false;
      suppressDirtyTimerRef.current = null;
    }, 1200);
  }, []);

  React.useEffect(() => {
    return () => {
      if (suppressDirtyTimerRef.current !== null) {
        window.clearTimeout(suppressDirtyTimerRef.current);
      }
    };
  }, []);

  const newerAvailable =
    loadedVersionId != null &&
    latestVersionId != null &&
    loadedVersionId !== latestVersionId;

  React.useEffect(() => {
    onStatusChange?.({
      dirty,
      saving,
      conflict,
      loadedVersionId,
      latestVersionId,
    });
  }, [
    conflict,
    dirty,
    latestVersionId,
    loadedVersionId,
    onStatusChange,
    saving,
  ]);

  const loadVersion = React.useCallback(
    async (versionId: string) => {
      beginSuppressDirty();
      setPhase("loading");
      setLoadError(null);
      setConflict(false);
      setDirty(false);
      setBuffer(null);
      try {
        // Drop Casual's local recovery draft so remount does not show
        // "Unsaved changes from … restore them?" after agent/server loads.
        await clearCasualLocalAutosave();
        const bytes = await fetchDocumentVersionContent(
          document.id,
          versionId,
        );
        // Detach a copy so Casual ownership of the buffer cannot mutate our cache.
        const copy = bytes.slice(0);
        setBuffer(copy);
        setLoadedVersionId(versionId);
        setEditorKey((value) => value + 1);
        setPhase("ready");
        beginSuppressDirty();
      } catch (error) {
        setPhase("error");
        setLoadError(
          userFacingError(error, "Could not load this document version."),
        );
      }
    },
    [beginSuppressDirty, document.id],
  );

  // Load exact version when opening a document (not on every latestVersion bump).
  React.useEffect(() => {
    setLatestVersionId(document.latestVersion.id);
    void loadVersion(document.latestVersion.id);
  }, [document.id, loadVersion]);

  // After document identity is stable, keep latestVersionId in sync with parent.
  React.useEffect(() => {
    setLatestVersionId(document.latestVersion.id);
  }, [document.latestVersion.id]);

  // Soft metadata refresh on window focus — detects newer versions without polling.
  React.useEffect(() => {
    async function refreshLatest() {
      try {
        const fresh = await getDocument(document.id);
        setLatestVersionId(fresh.latestVersion.id);
        onDocumentUpdated?.(fresh);
      } catch {
        // Ignore focus-refresh failures; editor remains usable.
      }
    }

    function onFocus() {
      void refreshLatest();
    }
    function onVisibility() {
      if (window.document.visibilityState === "visible") void refreshLatest();
    }

    window.addEventListener("focus", onFocus);
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [document.id, onDocumentUpdated]);

  // Auto-reload when a newer version appears.
  // Prefer agent/server versions over Casual remount dirty-noise: if suppress
  // window is active, clear dirty and adopt the latest. Real user edits
  // (dirty after suppress ends) keep the banner and require Reload.
  React.useEffect(() => {
    if (!newerAvailable || conflict || saving || phase !== "ready") {
      return;
    }
    if (!latestVersionId) return;

    if (dirty && !suppressDirtyRef.current) {
      return;
    }

    if (dirty && suppressDirtyRef.current) {
      setDirty(false);
    }

    const target = latestVersionId;
    const timer = window.setTimeout(() => {
      void loadVersion(target);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    conflict,
    dirty,
    latestVersionId,
    loadVersion,
    newerAvailable,
    phase,
    saving,
  ]);

  React.useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirty && !saving) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, saving]);

  const persistBytes = React.useCallback(
    async (bytes: ArrayBuffer) => {
      if (!loadedVersionId || savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setConflict(false);

      try {
        const result = await saveDocumentVersion(document.id, {
          baseVersionId: loadedVersionId,
          file: new Blob([bytes], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
          filename: document.name,
        });

        const nextVersionId = result.version.id;
        const copy = bytes.slice(0);
        setBuffer(copy);
        setLoadedVersionId(nextVersionId);
        setLatestVersionId(result.document.latestVersion.id);
        setDirty(false);
        setConflict(false);
        setEditorKey((value) => value + 1);
        onDocumentUpdated?.(result.document);
        toast({
          tone: "success",
          title: "Saved",
          description: `Version ${result.version.versionNumber}`,
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
          setConflict(true);
          setDirty(true);
          try {
            const fresh = await getDocument(document.id);
            setLatestVersionId(fresh.latestVersion.id);
            onDocumentUpdated?.(fresh);
          } catch {
            // keep conflict UI even if refresh fails
          }
          toast({
            tone: "error",
            title: "Version conflict",
            description:
              "A newer version exists. Your unsaved edits are still here.",
          });
          return;
        }

        toast({
          tone: "error",
          title: "Save failed",
          description: userFacingError(error, "Could not save this document."),
        });
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [document.id, document.name, loadedVersionId, onDocumentUpdated, toast],
  );

  const save = React.useCallback(async () => {
    if (savingRef.current || phase !== "ready" || conflict) return;
    if (!dirty) {
      toast({
        tone: "success",
        title: "Already saved",
        description: "No local edits to persist.",
      });
      return;
    }
    const api = editorRef.current;
    if (!api) {
      toast({
        tone: "error",
        title: "Editor not ready",
        description: "Wait for the document to finish loading.",
      });
      return;
    }

    try {
      const bytes = await api.export();
      if (!bytes) {
        toast({
          tone: "error",
          title: "Export failed",
          description: "Casual Docs could not serialize this document.",
        });
        return;
      }
      await persistBytes(bytes);
      await clearCasualLocalAutosave();
    } catch (error) {
      toast({
        tone: "error",
        title: "Save failed",
        description: userFacingError(error, "Could not export this document."),
      });
    }
  }, [conflict, dirty, persistBytes, phase, toast]);

  // Parent-driven save (header button / Cmd+S).
  React.useEffect(() => {
    if (saveRequestId === 0 || saveRequestId === lastSaveRequestId.current) {
      return;
    }
    lastSaveRequestId.current = saveRequestId;
    void save();
  }, [save, saveRequestId]);

  // Capture Cmd/Ctrl+S before Casual / browser defaults.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      void save();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save]);

  function confirmReloadLatest() {
    if (!latestVersionId) return;
    setReloadOpen(false);
    void loadVersion(latestVersionId);
  }

  if (phase === "loading") {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-canvas">
        <p className="text-[12px] text-ink-faint">Loading document…</p>
      </div>
    );
  }

  if (phase === "error" || !buffer || !loadedVersionId) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-canvas px-6">
        <p className="max-w-md text-center text-[12.5px] text-danger">
          {loadError ?? "Could not load this document."}
        </p>
        <button
          type="button"
          className="inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[11.5px] font-medium text-ink"
          onClick={() => void loadVersion(document.latestVersion.id)}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-canvas">
      {conflict ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/25 bg-danger-soft px-3 py-2">
          <p className="text-[11.5px] leading-snug text-danger">
            This file was updated elsewhere. Your unsaved edits are kept in
            memory — reload the latest version when you are ready (discards local
            changes).
          </p>
          <button
            type="button"
            className="shrink-0 rounded-[var(--radius-sm)] border border-danger/30 bg-surface px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-elevated"
            onClick={() => {
              if (dirty) setReloadOpen(true);
              else confirmReloadLatest();
            }}
          >
            Reload latest
          </button>
        </div>
      ) : newerAvailable && dirty ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-accent-line bg-accent-soft px-3 py-2">
          <p className="text-[11.5px] leading-snug text-ink-soft">
            Newer version available. Save is blocked until you reload — local
            edits will be discarded.
          </p>
          <button
            type="button"
            className="shrink-0 rounded-[var(--radius-sm)] border border-accent-line bg-surface px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-elevated"
            onClick={() => setReloadOpen(true)}
          >
            Reload latest
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <DocxEditorHost
          key={`${document.id}:${loadedVersionId}:${editorKey}`}
          ref={editorRef}
          documentBuffer={buffer}
          documentName={document.name}
          resolvedTheme={resolvedTheme}
          onDirtyChange={(next) => {
            if (suppressDirtyRef.current && next) {
              return;
            }
            setDirty(next);
          }}
          onError={(error) => {
            toast({
              tone: "error",
              title: "Editor error",
              description: error.message || "Casual Docs reported an error.",
            });
          }}
          onSelectionChange={(selection) => {
            // Groundwork only — stay local to DocxSurface.
            selectionRef.current = selection;
          }}
          // Do not wire Casual's onSave → persistBytes.
          // Casual can fire save on remount / internal autosave while the agent
          // advances versions, which races baseVersionId → VERSION_CONFLICT.
          // OpenSuite Save / ⌘S is the only persist path (window keydown + header).
        />
      </div>

      {reloadOpen ? (
        <ConfirmDialog
          title="Reload latest version?"
          body="This discards your unsaved edits and loads the newest saved version."
          confirmLabel="Discard and reload"
          onCancel={() => setReloadOpen(false)}
          onConfirm={confirmReloadLatest}
        />
      ) : null}
    </div>
  );
}
