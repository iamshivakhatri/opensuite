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
import { decideEditorVersionRefresh } from "@/lib/editor-version-refresh";
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
        <p className="os-type-secondary text-ink-faint">Loading editor…</p>
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
 *
 * Version advances on the *same* document prefer Casual's imperative
 * `loadDocumentBuffer` so the React host stays mounted (Phase 4B). Remount is
 * reserved for document switches / first open / in-place failure fallback.
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
  const reloadingRef = React.useRef(false);
  const lastSaveRequestId = React.useRef(0);
  /** Ignore Casual dirty=true churn right after remount/agent reload. */
  const suppressDirtyRef = React.useRef(false);
  const suppressDirtyTimerRef = React.useRef<number | null>(null);
  const documentIdRef = React.useRef(document.id);
  const dirtyRef = React.useRef(false);
  const conflictRef = React.useRef(false);
  const phaseRef = React.useRef<LoadPhase>("loading");
  const loadedVersionIdRef = React.useRef<string | null>(null);
  const latestVersionIdRef = React.useRef(document.latestVersion.id);

  const [phase, setPhase] = React.useState<LoadPhase>("loading");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [buffer, setBuffer] = React.useState<ArrayBuffer | null>(null);
  /** Bumped only for remount fallback — not on every version advance. */
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

  dirtyRef.current = dirty;
  conflictRef.current = conflict;
  phaseRef.current = phase;
  loadedVersionIdRef.current = loadedVersionId;
  latestVersionIdRef.current = latestVersionId;

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

  /**
   * First open / document switch: full load with loading phase.
   * Remounts the Casual host (keyed by document id + editorKey).
   */
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

  /**
   * Same-document clean version advance: keep the React host mounted and
   * replace content via Casual `loadDocumentBuffer`. Falls back to remount
   * if the imperative API is unavailable or fails.
   *
   * Data-loss invariant: callers must only invoke this when dirty human edits
   * are absent (or the user explicitly discarded them).
   */
  const reloadVersionInPlace = React.useCallback(
    async (versionId: string) => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      beginSuppressDirty();

      const apiBefore = editorRef.current;
      let priorZoom: number | undefined;
      let priorPage: number | undefined;
      try {
        priorZoom = apiBefore?.getZoom();
        priorPage = apiBefore?.getCurrentPage();
      } catch {
        // Viewport capture is best-effort only.
      }

      try {
        await clearCasualLocalAutosave();
        const bytes = await fetchDocumentVersionContent(
          document.id,
          versionId,
        );
        const copy = bytes.slice(0);
        const api = editorRef.current;

        if (api && typeof api.loadDocumentBuffer === "function") {
          await api.loadDocumentBuffer(copy);
          setBuffer(copy);
          setLoadedVersionId(versionId);
          setDirty(false);
          setConflict(false);
          setLoadError(null);
          beginSuppressDirty();

          // Best-effort viewport restore. Cursor/selection is not restored —
          // paraIds can shift across agent mutations and Casual does not
          // expose a durable selection snapshot API for this host path.
          try {
            if (typeof priorZoom === "number") {
              api.setZoom(priorZoom);
            }
            if (typeof priorPage === "number" && priorPage >= 1) {
              api.scrollToPage(priorPage);
            }
          } catch {
            // ignore restore failures
          }
          return;
        }

        // Fallback remount without blanking the whole surface into phase=loading.
        setBuffer(copy);
        setLoadedVersionId(versionId);
        setDirty(false);
        setConflict(false);
        setLoadError(null);
        setEditorKey((value) => value + 1);
        beginSuppressDirty();
      } catch (error) {
        toast({
          tone: "error",
          title: "Could not refresh document",
          description: userFacingError(
            error,
            "The newer version could not be loaded into the editor.",
          ),
        });
      } finally {
        reloadingRef.current = false;
      }
    },
    [beginSuppressDirty, document.id, toast],
  );

  // Load exact version when opening a document (not on every latestVersion bump).
  React.useEffect(() => {
    const switched = documentIdRef.current !== document.id;
    documentIdRef.current = document.id;
    if (switched) {
      setEditorKey(0);
    }
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

  // Auto-refresh when a newer immutable version appears (agent/server).
  React.useEffect(() => {
    if (!newerAvailable || !latestVersionId || phase !== "ready") {
      return;
    }

    const target = latestVersionId;
    const timer = window.setTimeout(() => {
      // Re-decide at fire time so a keystroke during the coalesce window
      // cannot be overwritten by a stale "clean" snapshot.
      const action = decideEditorVersionRefresh({
        documentChanged: false,
        hasReadyEditor:
          Boolean(editorRef.current) && phaseRef.current === "ready",
        loadedVersionId: loadedVersionIdRef.current,
        targetVersionId: target,
        dirty: dirtyRef.current,
        suppressDirtyNoise: suppressDirtyRef.current,
        conflict: conflictRef.current,
        saving: savingRef.current,
      });

      if (action === "defer_dirty" || action === "skip") {
        return;
      }

      if (action === "initialize") {
        void loadVersion(target);
        return;
      }

      if (dirtyRef.current && suppressDirtyRef.current) {
        setDirty(false);
      }
      void reloadVersionInPlace(target);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    latestVersionId,
    loadVersion,
    newerAvailable,
    phase,
    reloadVersionInPlace,
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
        // Content already matches the editor — update version pointers only.
        // Do not remount / re-import; that was a major post-save flash.
        setBuffer(copy);
        setLoadedVersionId(nextVersionId);
        setLatestVersionId(result.document.latestVersion.id);
        setDirty(false);
        setConflict(false);
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
    // User explicitly discarded local edits — in-place when possible.
    if (phase === "ready" && editorRef.current) {
      void reloadVersionInPlace(latestVersionId);
    } else {
      void loadVersion(latestVersionId);
    }
  }

  if (phase === "loading") {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-canvas">
        <p className="os-type-secondary text-ink-faint">Loading document…</p>
      </div>
    );
  }

  if (phase === "error" || !buffer || !loadedVersionId) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-canvas px-6">
        <p className="os-type-secondary max-w-md text-center text-danger">
          {loadError ?? "Could not load this document."}
        </p>
        <button
          type="button"
          className="os-type-label inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-line bg-surface px-3 font-medium text-ink"
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
          <p className="os-type-secondary leading-snug text-danger">
            This file was updated elsewhere. Your unsaved edits are kept in
            memory — reload the latest version when you are ready (discards local
            changes).
          </p>
          <button
            type="button"
            className="os-type-label shrink-0 rounded-[var(--radius-sm)] border border-danger/30 bg-surface px-2.5 py-1 font-medium text-danger hover:bg-elevated"
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
          <p className="os-type-secondary leading-snug text-ink-soft">
            Newer version available. Save is blocked until you reload — local
            edits will be discarded.
          </p>
          <button
            type="button"
            className="os-type-label shrink-0 rounded-[var(--radius-sm)] border border-accent-line bg-surface px-2.5 py-1 font-medium text-accent hover:bg-elevated"
            onClick={() => setReloadOpen(true)}
          >
            Reload latest
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <DocxEditorHost
          // Key by document identity (+ remount fallback counter). Version
          // advances must NOT force a React remount when in-place load works.
          key={`${document.id}:${editorKey}`}
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
