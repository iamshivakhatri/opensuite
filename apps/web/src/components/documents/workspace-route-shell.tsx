"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { userFacingError } from "@/components/files/format";
import { ApiError, listWorkspaces } from "@/lib/api";
import { WorkspaceIde } from "@/components/documents/workspace-ide";
import { documentQuery } from "@/lib/query-keys";
import { useStableBrowserTitle } from "@/lib/use-stable-browser-title";

type ShellState =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "error"; message: string }
  | { status: "ready"; name: string };

function documentIdFromPath(pathname: string, workspaceId: string): string | null {
  const match = new RegExp(
    `^/app/workspaces/${workspaceId}/documents/([^/]+)`,
  ).exec(pathname);
  return match?.[1] ?? null;
}

/**
 * Persistent workspace IDE shell. Survives document tab switches so explorer,
 * panels, and chrome do not remount (avoids full-page “jerk”).
 */
export function WorkspaceRouteShell({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const documentId = documentIdFromPath(pathname, workspaceId);

  const [shell, setShell] = React.useState<ShellState>({ status: "loading" });

  const browserTitle =
    shell.status === "ready" && shell.name.trim()
      ? `${shell.name.trim()} · OpenSuite`
      : "OpenSuite";
  useStableBrowserTitle(browserTitle);

  React.useEffect(() => {
    let cancelled = false;
    setShell({ status: "loading" });
    void listWorkspaces()
      .then((workspaces) => {
        if (cancelled) return;
        const match = workspaces.find((item) => item.id === workspaceId);
        if (!match) {
          setShell({ status: "not_found" });
          return;
        }
        setShell({ status: "ready", name: match.name });
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.statusCode === 404) {
          setShell({ status: "not_found" });
          return;
        }
        setShell({
          status: "error",
          message: userFacingError(error, "Could not load this workspace."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const documentQueryResult = useQuery({
    ...documentQuery(documentId ?? ""),
    enabled: shell.status === "ready" && Boolean(documentId),
  });

  const document =
    documentId &&
    documentQueryResult.data &&
    documentQueryResult.data.id === documentId &&
    documentQueryResult.data.workspaceId === workspaceId
      ? documentQueryResult.data
      : null;

  const docError = !documentId
    ? null
    : documentQueryResult.data &&
        documentQueryResult.data.workspaceId !== workspaceId
      ? "This file is not in the current workspace."
      : documentQueryResult.error instanceof ApiError &&
          documentQueryResult.error.statusCode === 404
        ? "Document not found."
        : documentQueryResult.error
          ? userFacingError(
              documentQueryResult.error,
              "Could not load this document.",
            )
          : null;

  const docLoading = Boolean(documentId) && documentQueryResult.isFetching;

  if (shell.status === "loading") {
    return (
      <div
        className="os-workspace-boot flex h-full min-h-0 flex-col bg-shell-main"
        aria-busy="true"
        aria-label="Opening workspace"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <div className="os-shimmer h-7 w-7 rounded-[var(--radius-md)]" />
          <div className="os-shimmer h-3.5 w-36 rounded-[var(--radius-sm)]" />
          <div className="os-shimmer ml-1 h-3 w-14 rounded-[var(--radius-sm)]" />
          <div className="ml-auto flex gap-2">
            <div className="os-shimmer h-7 w-16 rounded-[var(--radius-sm)]" />
            <div className="os-shimmer h-7 w-20 rounded-[var(--radius-sm)]" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-sidebar">
            <div className="os-workspace-rail flex items-center justify-end gap-1 px-2">
              <div className="os-shimmer h-5 w-5 rounded-[var(--radius-sm)]" />
              <div className="os-shimmer h-5 w-5 rounded-[var(--radius-sm)]" />
              <div className="os-shimmer h-5 w-5 rounded-[var(--radius-sm)]" />
            </div>
            <div className="space-y-1.5 px-2 py-2">
              {Array.from({ length: 8 }, (_, i) => (
                <div
                  key={i}
                  className="os-shimmer h-7 rounded-[var(--radius-md)]"
                  style={{ width: `${72 - (i % 4) * 8}%` }}
                />
              ))}
            </div>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col bg-canvas">
            <div className="flex h-9 items-center gap-2 border-b border-line bg-surface px-3">
              <div className="os-shimmer h-6 w-32 rounded-[var(--radius-md)]" />
              <div className="os-shimmer h-6 w-24 rounded-[var(--radius-md)] opacity-60" />
            </div>
            <div className="grid flex-1 place-items-center p-8">
              <div className="flex flex-col items-center gap-3">
                <div className="os-shimmer h-10 w-10 rounded-full" />
                <div className="os-shimmer h-3.5 w-40 rounded-[var(--radius-sm)]" />
                <div className="os-shimmer h-3 w-56 rounded-[var(--radius-sm)] opacity-70" />
              </div>
            </div>
          </main>
          <aside className="hidden w-[280px] shrink-0 flex-col border-l border-line bg-sidebar lg:flex">
            <div className="os-workspace-rail flex items-center px-3">
              <div className="os-shimmer h-3.5 w-16 rounded-[var(--radius-sm)]" />
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
              <div className="os-shimmer h-3 w-full rounded-[var(--radius-sm)]" />
              <div className="os-shimmer h-3 w-[80%] rounded-[var(--radius-sm)] opacity-70" />
              <div className="os-shimmer h-3 w-[60%] rounded-[var(--radius-sm)] opacity-50" />
            </div>
            <div className="border-t border-line p-3">
              <div className="os-shimmer h-9 w-full rounded-[var(--radius-md)]" />
            </div>
          </aside>
        </div>
      </div>
    );
  }

  if (shell.status === "not_found") {
    return (
      <div className="mx-auto max-w-[420px] px-6 py-24 text-center">
        <h1 className="mb-2 text-[length:var(--text-xl)] font-semibold tracking-[-0.03em] text-ink">
          Workspace not found
        </h1>
        <p className="os-type-secondary mb-6 text-ink-soft">
          This workspace may have been removed, or you may not have access.
        </p>
        <Link
          href="/app"
          className="os-type-label inline-flex h-9 items-center justify-center rounded-[var(--radius-md)] bg-primary px-4 font-medium text-on-ink hover:bg-primary-hover"
        >
          Back to Home
        </Link>
      </div>
    );
  }

  if (shell.status === "error") {
    return (
      <div className="mx-auto max-w-[420px] px-6 py-24 text-center">
        <p className="os-type-secondary mb-4 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-danger">
          {shell.message}
        </p>
        <Link
          href="/app"
          className="os-type-label inline-flex h-8 items-center justify-center rounded-[var(--radius-md)] border border-line bg-surface px-3 font-medium text-ink-soft hover:text-primary"
        >
          Home
        </Link>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <WorkspaceIde
        workspaceId={workspaceId}
        workspaceName={shell.name}
        document={document}
        documentId={documentId}
        documentPending={
          Boolean(documentId) && docLoading && !document
        }
        onWorkspaceRenamed={(name) => {
          setShell({ status: "ready", name });
        }}
      />
      {docError ? (
        <div className="absolute inset-x-0 top-[44px] z-30 flex justify-center px-4 pt-3">
          <div className="os-type-secondary flex max-w-[480px] items-center gap-3 rounded-[var(--radius-lg)] border border-danger/20 bg-danger-soft px-3 py-2 text-danger shadow-[var(--elevation-xs)]">
            <span className="min-w-0 flex-1">{docError}</span>
            <Link
              href={`/app/workspaces/${workspaceId}`}
              className="os-type-label shrink-0 rounded-[var(--radius-md)] border border-line bg-surface px-2.5 py-1 font-medium text-ink-soft hover:text-primary"
            >
              Back
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
