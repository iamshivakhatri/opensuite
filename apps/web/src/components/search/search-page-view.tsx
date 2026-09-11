"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { DocumentFormatIcon } from "@/components/files/document-format-icon";
import {
  formatUpdatedAt,
  userFacingError,
} from "@/components/files/format";
import { Input } from "@/components/ui/input";
import { PageEmpty, PageError, PageLoading } from "@/components/ui/page-state";
import {
  searchMetadata,
  type SearchDocumentHit,
  type SearchWorkspaceHit,
} from "@/lib/api";
import { documentPath, workspacePath } from "@/lib/paths";

/**
 * Full-page metadata search — documents across owned workspaces.
 */
export function SearchPageView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initial = searchParams.get("q") ?? "";
  const [query, setQuery] = React.useState(initial);
  const [debounced, setDebounced] = React.useState(initial.trim());
  const [documents, setDocuments] = React.useState<SearchDocumentHit[] | null>(
    null,
  );
  const [workspaces, setWorkspaces] = React.useState<SearchWorkspaceHit[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setQuery(initial);
    setDebounced(initial.trim());
  }, [initial]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = query.trim();
      setDebounced(next);
      const href = next
        ? `/app/search?q=${encodeURIComponent(next)}`
        : "/app/search";
      router.replace(href, { scroll: false });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, router]);

  React.useEffect(() => {
    if (!debounced) {
      setDocuments([]);
      setWorkspaces([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void searchMetadata(debounced)
      .then((results) => {
        if (cancelled) return;
        setDocuments(results.documents);
        setWorkspaces(results.workspaces);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(userFacingError(err, "Search failed."));
        setDocuments([]);
        setWorkspaces([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  return (
    <div className="mx-auto max-w-[920px] px-8 py-8">
      <div className="mb-6">
        <div className="os-type-section mb-1">Search</div>
        <h1 className="text-[length:var(--text-xl)] font-semibold tracking-[-0.03em] text-ink">
          Find files
        </h1>
        <p className="os-type-secondary mt-1 text-ink-soft">
          Search document names, workspace names, and formats. File contents are
          not searchable yet.
        </p>
      </div>

      <div className="mb-6">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search across your workspaces…"
          className="h-11 text-[14px]"
        />
      </div>

      {error ? (
        <div className="mb-4">
          <PageError message={error} />
        </div>
      ) : null}

      {!debounced ? (
        <p className="os-type-secondary text-ink-faint">
          Type a query to search. Tip: press{" "}
          <kbd className="os-type-meta rounded border border-line bg-[var(--paper)] px-1.5 py-0.5 font-mono">
            ⌘K
          </kbd>{" "}
          for Quick Open.
        </p>
      ) : null}

      {loading ? <PageLoading /> : null}

      {!loading && debounced && documents !== null && documents.length === 0 ? (
        <PageEmpty
          title="No matching files"
          description="Try another name, workspace, or format (docx / pptx / xlsx)."
        />
      ) : null}

      {workspaces.length > 0 ? (
        <section className="mb-6">
          <h2 className="os-type-section mb-2">Workspaces</h2>
          <div className="flex flex-col gap-1.5">
            {workspaces.map((ws) => (
              <Link
                key={ws.id}
                href={workspacePath(ws.id)}
                className="flex items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5 hover:border-ink-faint"
              >
                <span className="os-type-meta grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-line bg-[var(--paper)] text-ink-soft">
                  WS
                </span>
                <span className="min-w-0 flex-1">
                  <span className="os-type-label block truncate font-medium text-ink">
                    {ws.name}
                  </span>
                  <span className="os-type-meta block text-ink-faint">
                    Updated {formatUpdatedAt(ws.updatedAt)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {(documents?.length ?? 0) > 0 ? (
        <section>
          <h2 className="os-type-section mb-2">Documents</h2>
          <div className="flex flex-col gap-1.5">
            {documents!.map((doc) => (
              <Link
                key={doc.id}
                href={documentPath(doc.workspaceId, doc.id)}
                className="flex items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5 hover:border-ink-faint"
              >
                <DocumentFormatIcon
                  format={doc.format}
                  size="md"
                  className="text-ink-soft"
                />
                <span className="min-w-0 flex-1">
                  <span className="os-type-label block truncate font-medium text-ink">
                    {doc.name}
                  </span>
                  <span className="os-type-meta block truncate text-ink-faint">
                    {doc.workspaceName} · Updated{" "}
                    {formatUpdatedAt(doc.updatedAt)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
