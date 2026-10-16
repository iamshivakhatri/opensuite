"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { DocxEditorRef } from "@casualoffice/docs";

import { useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  fetchWorkingDocument,
  getDocument,
  saveDocumentVersion,
  type ListedDocument,
} from "@/lib/api";
import { fetchDocumentDraft, saveDocumentDraft } from "@/lib/document-drafts-api";
import { createEditorSaveState } from "@/lib/editor-save";
import { clearCasualLocalAutosave } from "@/lib/casual-autosave";
import {
  assertEditorFieldsPreserved,
  prepareDocxForEditor,
} from "@/lib/docx-field-preservation";
import { canApplyWorkingPreview, decideEditorVersionRefresh } from "@/lib/editor-version-refresh";
import { userFacingError } from "@/components/files/format";
import { ConfirmDialog } from "@/components/ui/context-menu";
import { documentVersionContentQuery } from "@/lib/query-keys";
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
 * Docs, edits locally, and autosaves a replaceable draft and creates versions on explicit Save.
 *
 * Version advances on the *same* document prefer Casual's imperative
 * `loadDocumentBuffer` so the React host stays mounted (Phase 4B). Remount is
 * reserved for document switches / first open / in-place failure fallback.
 */
export function DocxSurface({
  document,
  viewVersionId = null,
  onStatusChange,
  onDocumentUpdated,
  onRequestRestore,
  saveRequestId = 0,
  workingPreview = null,
  beforeAgentSaveRef,
  agentRunning = false,
}: {
  readonly agentRunning?: boolean;
  readonly beforeAgentSaveRef?: React.RefObject<(() => Promise<void>) | null>;
  readonly document: ListedDocument;
  /** When set, load this version instead of the tip (read-only if not latest). */
  readonly viewVersionId?: string | null;
  readonly onStatusChange?: (status: DocxSurfaceStatus) => void;
  readonly onDocumentUpdated?: (document: ListedDocument) => void;
  /** User wants to make the viewed historical version the tip. */
  readonly onRequestRestore?: () => void;
  /** Bump to request an explicit save (header Save / Cmd+S from parent). */
  readonly saveRequestId?: number;
  readonly workingPreview?: { runId: string; documentId: string; baseVersionId: string; revision: number } | null;
}) {
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const editorRef = React.useRef<DocxEditorRef | null>(null);
  const draftIdRef = React.useRef<string | null>(null);
  const savedBufferRef = React.useRef<ArrayBuffer | null>(null);
  const needsFullExportRef = React.useRef(false);
  const selectionRef = React.useRef<unknown>(null);
  const savingRef = React.useRef(false);
  const saveState = React.useRef(createEditorSaveState()).current;
  const [editRevision, setEditRevision] = React.useState(0);
  const lastAutoSaveRevision = React.useRef(-1);
  const reloadingRef = React.useRef(false);
  const editorReadyRef = React.useRef(false);
  const previewBusyRef = React.useRef(false);
  const previewTargetRef = React.useRef(workingPreview);
  const appliedPreviewRef = React.useRef<{ runId: string; revision: number } | null>(null);
  const lastSaveRequestId = React.useRef(0);
  /** Ignore Casual dirty=true churn right after remount/agent reload. */
  const suppressDirtyRef = React.useRef(false);
  const suppressDirtyTimerRef = React.useRef<number | null>(null);
  /** `null` until first load effect so initial mount always counts as a switch. */
  const documentIdRef = React.useRef<string | null>(null);
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
  const [previewTick, setPreviewTick] = React.useState(0);

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

  const handleEditorReady = React.useCallback(() => {
    editorReadyRef.current = true;
    beginSuppressDirty();
    if (previewTargetRef.current) setPreviewTick((value) => value + 1);
  }, [beginSuppressDirty]);

  React.useEffect(() => {
    return () => {
      if (suppressDirtyTimerRef.current !== null) {
        window.clearTimeout(suppressDirtyTimerRef.current);
      }
    };
  }, []);

  const targetVersionId = viewVersionId ?? document.latestVersion.id;
  const viewingHistory = targetVersionId !== document.latestVersion.id;
  const newerAvailable =
    !viewingHistory &&
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

  const loadEditorBytes = React.useCallback(async (versionId: string) => {
    const draft = versionId === document.latestVersion.id ? await fetchDocumentDraft(document.id) : null;
    if (draft && draft.baseVersionId !== versionId) throw new Error("This document changed. Reopen its latest version.");
    const bytes = draft?.bytes ?? await queryClient.fetchQuery(documentVersionContentQuery(document.id, versionId));
    if (!bytes) throw new Error("Document content is unavailable.");
    draftIdRef.current = draft?.id ?? null;
    saveState.reset(Boolean(draft));
    return prepareDocxForEditor(bytes.slice(0));
  }, [document.id, document.latestVersion.id, queryClient, saveState]);

  /**
   * First open / document switch: full load with loading phase.
   * Remounts the Casual host (keyed by document id + editorKey).
   */
  const loadVersion = React.useCallback(
    async (versionId: string) => {
      editorReadyRef.current = false;
      beginSuppressDirty();
      setPhase("loading");
      setLoadError(null);
      setConflict(false);
      saveState.reset();
      needsFullExportRef.current = false;
      setDirty(false);
      setBuffer(null);
      try {
        // Drop Casual's local recovery draft so remount does not show
        // "Unsaved changes from … restore them?" after agent/server loads.
        await clearCasualLocalAutosave();
        const copy = await loadEditorBytes(versionId);
        savedBufferRef.current = copy.slice(0);
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
    [beginSuppressDirty, loadEditorBytes, saveState],
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
      while (reloadingRef.current) await new Promise((resolve) => window.setTimeout(resolve, 50));
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
        const copy = await loadEditorBytes(versionId);
        const api = editorRef.current;

        if (api && typeof api.loadDocumentBuffer === "function") {
          await api.loadDocumentBuffer(copy);
          savedBufferRef.current = copy.slice(0);
          setBuffer(copy);
          setLoadedVersionId(versionId);
          needsFullExportRef.current = false;
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
        editorReadyRef.current = false;
        savedBufferRef.current = copy.slice(0);
        setBuffer(copy);
        setLoadedVersionId(versionId);
        needsFullExportRef.current = false;
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
    [beginSuppressDirty, loadEditorBytes, toast],
  );

  React.useEffect(() => {
    previewTargetRef.current = workingPreview;
    if (!workingPreview || previewBusyRef.current) return;
    previewBusyRef.current = true;
    void (async () => {
      try {
        let lastFetchedRevision = 0;
        while (previewTargetRef.current) {
          const target = previewTargetRef.current;
          if (!target || documentIdRef.current !== target.documentId ||
              loadedVersionIdRef.current !== target.baseVersionId ||
              latestVersionIdRef.current !== target.baseVersionId ||
              phaseRef.current !== "ready" || dirtyRef.current || savingRef.current || conflictRef.current) break;
          const applied = appliedPreviewRef.current;
          if (applied?.runId === target.runId && applied.revision >= target.revision) break;
          const preview = await fetchWorkingDocument(target.runId);
          const latest = previewTargetRef.current;
          if (!latest || latest.runId !== target.runId) break;
          if (latest.revision > preview.revision) {
            if (preview.revision <= lastFetchedRevision) break;
            lastFetchedRevision = preview.revision;
            continue;
          }
          if (!canApplyWorkingPreview({
            requestedRevision: latest.revision,
            fetchedRevision: preview.revision,
            dirty: dirtyRef.current,
            saving: savingRef.current,
            conflict: conflictRef.current,
            baseVersionId: preview.baseVersionId,
            loadedVersionId: loadedVersionIdRef.current,
            latestVersionId: latestVersionIdRef.current,
          })) break;
          while (reloadingRef.current) await new Promise((resolve) => window.setTimeout(resolve, 50));
          if (dirtyRef.current || !previewTargetRef.current || latestVersionIdRef.current !== preview.baseVersionId) break;
          const api = editorRef.current;
          if (!api?.loadDocumentBuffer) break;
          reloadingRef.current = true;
          beginSuppressDirty();
          try {
            let page: number | undefined;
            let zoom: number | undefined;
            try {
              page = api.getCurrentPage();
              zoom = api.getZoom();
            } catch { /* Viewport capture is best effort. */ }
            await clearCasualLocalAutosave();
            if (dirtyRef.current) break;
            const prepared = await prepareDocxForEditor(preview.bytes.slice(0));
            await api.loadDocumentBuffer(prepared);
            try {
              if (typeof zoom === "number") api.setZoom(zoom);
              if (typeof page === "number" && page >= 1) api.scrollToPage(page);
            } catch { /* Viewport restore is best effort. */ }
            appliedPreviewRef.current = { runId: target.runId, revision: preview.revision };
            savedBufferRef.current = prepared.slice(0);
            setBuffer(prepared);
            setDirty(false);
            beginSuppressDirty();
          } finally {
            reloadingRef.current = false;
          }
        }
      } catch {
        // A run may finish while its last preview is in flight; the persisted version will load.
      } finally {
        previewBusyRef.current = false;
        const latest = previewTargetRef.current;
        const applied = appliedPreviewRef.current;
        if (latest && latest !== workingPreview &&
            (!applied || latest.runId !== applied.runId || latest.revision > applied.revision)) {
          setPreviewTick((value) => value + 1);
        }
      }
    })();
  }, [beginSuppressDirty, phase, previewTick, workingPreview]);

  /** `undefined` sentinel so first mount always counts as a view change. */
  const viewVersionIdRef = React.useRef<string | null | undefined>(undefined);

  // Load on document open or explorer history selection — not on tip advance
  // (tip advance uses newerAvailable → reloadVersionInPlace below).
  React.useEffect(() => {
    const switched = documentIdRef.current !== document.id;
    documentIdRef.current = document.id;
    const viewChanged = viewVersionIdRef.current !== viewVersionId;
    viewVersionIdRef.current = viewVersionId;
    setLatestVersionId(document.latestVersion.id);
    if (!switched && !viewChanged) return;
    if (switched) setEditorKey(0);
    void loadVersion(targetVersionId);
  }, [document.id, document.latestVersion.id, loadVersion, targetVersionId, viewVersionId]);

  // Auto-refresh when a newer immutable version appears (agent/server).
  // Skip while the user is intentionally viewing history.
  React.useEffect(() => {
    if (viewingHistory || !newerAvailable || !latestVersionId || phase !== "ready") {
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
    viewingHistory,
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
    async (bytes: ArrayBuffer, mode: "draft" | "version") => {
      const baseVersionId = loadedVersionIdRef.current;
      if (!baseVersionId) throw new Error("The document is still loading.");
      if (baseVersionId !== latestVersionIdRef.current) {
        throw new Error("Reload the latest version or restore this version before saving.");
      }
      try {
        const input = { baseVersionId, baseDraftId: draftIdRef.current,
          file: new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
          filename: document.name };
        if (mode === "draft") {
          const draft = await saveDocumentDraft(document.id, input);
          draftIdRef.current = draft.id;
          savedBufferRef.current = bytes.slice(0);
          return;
        }
        const result = await saveDocumentVersion(document.id, input);
        draftIdRef.current = null;

        const nextVersionId = result.version.id;
        // Changing documentBuffer re-imports the editor and can erase edits
        // made during upload. Keep the prop stable; advance only the save baseline.
        savedBufferRef.current = bytes.slice(0);
        loadedVersionIdRef.current = nextVersionId;
        latestVersionIdRef.current = result.document.latestVersion.id;
        setLoadedVersionId(nextVersionId);
        setLatestVersionId(result.document.latestVersion.id);
        setConflict(false);
        onDocumentUpdated?.(result.document);
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
        }
        throw error;
      }
    },
    [document.id, document.name, onDocumentUpdated],
  );

  const save = React.useCallback(async (mode: "draft" | "version" = "draft") => {
    if (phaseRef.current !== "ready" || conflictRef.current || viewingHistory || agentRunning || previewTargetRef.current) return false;
    return saveState.save(async () => {
      savingRef.current = true;
      setSaving(true);
      try {
        const api = editorRef.current;
        if (!api) throw new Error("Wait for the document to finish loading.");
        const exportRevision = saveState.revision;
        const selective = !needsFullExportRef.current;
        needsFullExportRef.current = true;
        const bytes = await api.export({ selective });
        if (!bytes) throw new Error("The editor could not export this document.");
        // Casual clears its change markers after export, including overlapping edits.
        needsFullExportRef.current = saveState.revision !== exportRevision;
        if (savedBufferRef.current) await assertEditorFieldsPreserved(savedBufferRef.current, bytes);
        await persistBytes(bytes, mode);
        await clearCasualLocalAutosave().catch(() => {});
      } catch (error) {
        toast({ tone: "error", title: "Save failed", description: userFacingError(error, "Could not save this document.") });
        throw error;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }, mode === "version").then((ok) => {
      dirtyRef.current = saveState.isDirty();
      setDirty(dirtyRef.current);
      return ok;
    });
  }, [agentRunning, persistBytes, saveState, toast, viewingHistory]);

  // Save after editing pauses. A failed save stays dirty until another edit or Save.
  React.useEffect(() => {
    if (!dirty || saving || conflict || agentRunning || viewingHistory || workingPreview || phase !== "ready" || lastAutoSaveRevision.current === editRevision) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveRevision.current = editRevision;
      void save();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [agentRunning, editRevision, dirty, conflict, phase, save, saving, viewingHistory, workingPreview]);

  React.useEffect(() => {
    if (!beforeAgentSaveRef) return;
    beforeAgentSaveRef.current = async () => {
      while (saveState.isDirty()) {
        if (!await save()) throw new Error("Save your document changes before starting the agent.");
      }
    };
    return () => { beforeAgentSaveRef.current = null; };
  }, [beforeAgentSaveRef, save, saveState]);

  function markChanged() {
    if (!editorReadyRef.current || reloadingRef.current || viewingHistory) return;
    suppressDirtyRef.current = false;
    saveState.changed();
    dirtyRef.current = true;
    setDirty(true);
    setEditRevision(value => value + 1);
  }

  // Parent-driven save (header button / Cmd+S).
  React.useEffect(() => {
    if (saveRequestId === 0 || saveRequestId === lastSaveRequestId.current) {
      return;
    }
    lastSaveRequestId.current = saveRequestId;
    void save("version");
  }, [save, saveRequestId]);

  // Capture Cmd/Ctrl+S before Casual / browser defaults.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      void save("version");
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
      {viewingHistory ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-primary-line bg-primary-soft px-3 py-2">
          <p className="os-type-secondary leading-snug text-ink-soft">
            Viewing an older version (read-only). To edit it, restore it as
            current — newer versions will be permanently deleted.
          </p>
          {onRequestRestore ? (
            <button
              type="button"
              className="os-type-label shrink-0 rounded-[var(--radius-sm)] border border-primary-line bg-surface px-2.5 py-1 font-medium text-primary hover:bg-elevated"
              onClick={onRequestRestore}
            >
              Restore as current
            </button>
          ) : null}
        </div>
      ) : conflict ? (
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
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-primary-line bg-primary-soft px-3 py-2">
          <p className="os-type-secondary leading-snug text-ink-soft">
            Newer version available. Save is blocked until you reload — local
            edits will be discarded.
          </p>
          <button
            type="button"
            className="os-type-label shrink-0 rounded-[var(--radius-sm)] border border-primary-line bg-surface px-2.5 py-1 font-medium text-primary hover:bg-elevated"
            onClick={() => setReloadOpen(true)}
          >
            Reload latest
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden" onInputCapture={(event) => {
        if (phaseRef.current === "ready" && event.nativeEvent.isTrusted &&
            event.target instanceof Element && event.target.closest('[contenteditable="true"]')) {
          markChanged();
        }
      }}>
        <DocxEditorHost
          // Key by document identity (+ remount fallback counter). Version
          // advances must NOT force a React remount when in-place load works.
          key={`${document.id}:${editorKey}`}
          ref={editorRef}
          documentBuffer={buffer}
          documentName={document.name}
          resolvedTheme={resolvedTheme}
          onReady={handleEditorReady}
          onChange={markChanged}
          onDirtyChange={(next) => {
            if (next && editorReadyRef.current && !suppressDirtyRef.current) markChanged();
            // Casual's local autosave does not mean the server saved these edits.
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
          // OpenSuite serializes automatic, explicit, and before-agent saves.
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
