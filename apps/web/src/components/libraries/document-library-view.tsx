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
  listRecentDocuments,
  listStarredDocuments,
  setDocumentStarred,
  type LibraryDocument,
} from "@/lib/api";
import { documentPath } from "@/lib/paths";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type LibraryKind = "recent" | "starred";

/**
 * Shared list surface for Recent and Starred libraries.
 */
export function DocumentLibraryView({
  kind,
  title,
  description,
}: {
  kind: LibraryKind;
  title: string;
  description: string;
}) {
  const { toast } = useToast();
  const [documents, setDocuments] = React.useState<LibraryDocument[] | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [starBusyId, setStarBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      if (kind === "recent") {
        setDocuments(await listRecentDocuments());
      } else {
        setDocuments(await listStarredDocuments());
      }
    } catch (err) {
      setError(userFacingError(err, "Could not load documents."));
    }
  }, [kind]);

  React.useEffect(() => {
    void load();
  }, [load]);

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

  const emptyTitle =
    kind === "recent" ? "No recent documents" : "No starred documents";

  const emptyDescription =
    kind === "recent"
      ? "Open a document from a workspace and it will appear here."
      : "Star a file from a workspace and it will appear here.";

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
