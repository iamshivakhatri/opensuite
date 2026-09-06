"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { PageEmpty, PageError, PageLoading } from "@/components/ui/page-state";
import {
  formatLabel,
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";
import {
  listLibraryDocuments,
  listRecentDocuments,
  listStarredDocuments,
  listWorkspaces,
  setDocumentStarred,
  uploadDocument,
  type DocumentFormat,
  type LibraryDocument,
  type Workspace,
} from "@/lib/api";
import { documentPath } from "@/lib/paths";
import { useToast } from "@/lib/toast";

type LibraryKind = "recent" | "starred" | "format";

/**
 * Shared list surface for Recent, Starred, and format libraries.
 */
export function DocumentLibraryView({
  kind,
  format,
  title,
  description,
}: {
  kind: LibraryKind;
  format?: DocumentFormat;
  title: string;
  description: string;
}) {
  const { toast } = useToast();
  const [documents, setDocuments] = React.useState<LibraryDocument[] | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [starBusyId, setStarBusyId] = React.useState<string | null>(null);
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [uploadWorkspaceId, setUploadWorkspaceId] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      if (kind === "recent") {
        setDocuments(await listRecentDocuments());
      } else if (kind === "starred") {
        setDocuments(await listStarredDocuments());
      } else {
        setDocuments(await listLibraryDocuments(format!));
      }
    } catch (err) {
      setError(userFacingError(err, "Could not load documents."));
    }
  }, [kind, format]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (kind !== "format") return;
    void listWorkspaces()
      .then((list) => {
        setWorkspaces(list);
        setUploadWorkspaceId((current) => current || list[0]?.id || "");
      })
      .catch(() => {
        // upload picker optional
      });
  }, [kind]);

  async function toggleStar(doc: LibraryDocument) {
    if (starBusyId) return;
    setStarBusyId(doc.id);
    try {
      await setDocumentStarred(doc.id, !doc.starred);
      await load();
      toast({
        tone: "success",
        title: doc.starred ? "Unstarred" : "Starred",
      });
    } catch (err) {
      setError(userFacingError(err, "Could not update star."));
      toast({ tone: "error", title: "Could not update star" });
    } finally {
      setStarBusyId(null);
    }
  }

  async function handleUpload(file: File | undefined) {
    if (!file || !uploadWorkspaceId || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadDocument(uploadWorkspaceId, file);
      await load();
      toast({ tone: "success", title: "File uploaded" });
    } catch (err) {
      const message = userFacingError(err, "Upload failed.");
      setUploadError(message);
      toast({ tone: "error", title: "Upload failed", description: message });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const accept =
    format === "docx"
      ? ".docx"
      : format === "pptx"
        ? ".pptx"
        : format === "xlsx"
          ? ".xlsx"
          : ".docx,.pptx,.xlsx";

  return (
    <div className="mx-auto max-w-[920px] px-8 py-8">
      <div className="mb-6">
        <div className="mb-1 font-mono text-[8.5px] font-medium uppercase tracking-[0.095em] text-ink-faint">
          Library
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">
          {title}
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">{description}</p>
      </div>

      {kind === "format" ? (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-3">
          <select
            value={uploadWorkspaceId}
            onChange={(event) => setUploadWorkspaceId(event.target.value)}
            className="h-8 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-ink"
          >
            {workspaces.length === 0 ? (
              <option value="">No workspaces</option>
            ) : (
              workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))
            )}
          </select>
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(event) =>
              void handleUpload(event.target.files?.[0] ?? undefined)
            }
          />
          <Button
            type="button"
            size="sm"
            disabled={!uploadWorkspaceId || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "Uploading…" : "Upload"}
          </Button>
          {uploadError ? (
            <p className="w-full text-[11px] text-danger">{uploadError}</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <PageError message={error} onRetry={() => void load()} />
        </div>
      ) : null}

      {documents === null && !error ? (
        <PageLoading />
      ) : null}

      {documents !== null && documents.length === 0 ? (
        <PageEmpty
          title="Nothing here yet"
          description={
            kind === "recent"
              ? "Open a document and it will appear here."
              : kind === "starred"
                ? "Star files from a workspace explorer or this list."
                : "Upload a matching Office file into a workspace."
          }
        />
      ) : null}

      <div className="flex flex-col gap-1.5">
        {(documents ?? []).map((doc) => (
          <div
            key={doc.id}
            className="flex items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5 hover:border-[#D5D9E0]"
          >
            <Link
              href={documentPath(doc.workspaceId, doc.id)}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-line bg-[var(--paper)] font-mono text-[7.5px] text-ink-soft">
                {formatLabel(doc.format)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-ink">
                  {doc.name}
                </span>
                <span className="block truncate text-[10.5px] text-ink-faint">
                  {doc.workspaceName}
                  {" · "}
                  {kind === "recent" && doc.lastOpenedAt
                    ? `Opened ${formatUpdatedAt(doc.lastOpenedAt)}`
                    : `Updated ${formatUpdatedAt(doc.updatedAt)}`}
                </span>
              </span>
            </Link>
            <button
              type="button"
              title={doc.starred ? "Unstar" : "Star"}
              disabled={starBusyId === doc.id}
              onClick={() => void toggleStar(doc)}
              className={
                "grid h-8 w-8 place-items-center rounded-[8px] text-[14px] " +
                (doc.starred
                  ? "text-accent hover:bg-accent-soft"
                  : "text-ink-faint hover:bg-sunken hover:text-ink")
              }
            >
              {doc.starred ? "★" : "☆"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
