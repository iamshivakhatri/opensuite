"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { DocumentLibraryRow } from "@/components/libraries/document-library-row";
import { PageEmpty, PageError, PageLoading } from "@/components/ui/page-state";
import {
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
import { focusRingClass } from "@/lib/focus-scope";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

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

  const emptyTitle =
    kind === "recent"
      ? "No recent documents"
      : kind === "starred"
        ? "No starred documents"
        : "Nothing here yet";

  const emptyDescription =
    kind === "recent"
      ? "Open a document from a workspace and it will appear here."
      : kind === "starred"
        ? "Star a file from a workspace and it will appear here."
        : "Upload a matching Office file into a workspace.";

  function rowMeta(doc: LibraryDocument): string {
    const when =
      kind === "recent" && doc.lastOpenedAt
        ? `Opened ${formatUpdatedAt(doc.lastOpenedAt)}`
        : `Updated ${formatUpdatedAt(doc.updatedAt)}`;
    return `${doc.workspaceName} · ${when}`;
  }

  return (
    <div className="mx-auto max-w-[880px] px-6 py-7 sm:px-8">
      <header className="mb-6">
        <h1 className="text-[length:var(--text-xl)] font-semibold tracking-[-0.03em] text-ink">
          {title}
        </h1>
        <p className="os-type-secondary mt-1 max-w-[48ch] text-ink-soft">
          {description}
        </p>
      </header>

      {kind === "format" ? (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5">
          <select
            value={uploadWorkspaceId}
            onChange={(event) => setUploadWorkspaceId(event.target.value)}
            className={cn(
              focusRingClass,
              "h-8 rounded-[var(--radius-sm)] border border-line bg-surface px-2 text-[length:var(--text-xs)] text-ink",
            )}
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
            <p className="os-type-meta w-full text-danger">{uploadError}</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <PageError message={error} onRetry={() => void load()} />
        </div>
      ) : null}

      {documents === null && !error ? <PageLoading variant="list" /> : null}

      {documents !== null && documents.length === 0 ? (
        <PageEmpty title={emptyTitle} description={emptyDescription} />
      ) : null}

      {documents !== null && documents.length > 0 ? (
        <ul className="divide-y divide-line border-y border-line">
          {documents.map((doc) => (
            <li key={doc.id}>
              <DocumentLibraryRow
                href={documentPath(doc.workspaceId, doc.id)}
                name={doc.name}
                format={doc.format}
                meta={rowMeta(doc)}
                trailing={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={doc.starred ? "Unstar" : "Star"}
                    aria-label={
                      doc.starred ? "Unstar document" : "Star document"
                    }
                    aria-pressed={doc.starred}
                    disabled={starBusyId === doc.id}
                    onClick={() => void toggleStar(doc)}
                    className={cn(
                      "text-[length:var(--text-sm)]",
                      doc.starred
                        ? "text-accent hover:text-accent"
                        : "text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
                    )}
                  >
                    {doc.starred ? "★" : "☆"}
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
