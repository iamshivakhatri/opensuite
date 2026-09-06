"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { userFacingError } from "@/components/files/format";
import { ApiError, getDocument, listWorkspaces, type ListedDocument } from "@/lib/api";
import { WorkspaceIde } from "@/components/documents/workspace-ide";

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
  const [document, setDocument] = React.useState<ListedDocument | null>(null);
  const [docError, setDocError] = React.useState<string | null>(null);
  const [docLoading, setDocLoading] = React.useState(false);

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

  React.useEffect(() => {
    if (shell.status !== "ready") return;

    if (!documentId) {
      setDocument(null);
      setDocError(null);
      setDocLoading(false);
      return;
    }

    let cancelled = false;
    setDocLoading(true);
    setDocError(null);
    void getDocument(documentId)
      .then((doc) => {
        if (cancelled) return;
        if (doc.workspaceId !== workspaceId) {
          setDocError("This file is not in the current workspace.");
          setDocument(null);
          return;
        }
        setDocument(doc);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.statusCode === 404) {
          setDocError("Document not found.");
          setDocument(null);
          return;
        }
        setDocError(userFacingError(error, "Could not load this document."));
        setDocument(null);
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [documentId, shell.status, workspaceId]);

  if (shell.status === "loading") {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex h-full min-h-0 flex-col gap-3 p-4" aria-busy="true" aria-label="Opening workspace">
          <div className="flex gap-3">
            <div className="h-full w-[200px] shrink-0 space-y-2 rounded-[var(--radius-md)] border border-line bg-[var(--sidebar)] p-3">
              <div className="h-3 w-16 animate-pulse rounded-[var(--radius-sm)] bg-sunken" />
              <div className="h-7 animate-pulse rounded-[var(--radius-sm)] bg-sunken" />
              <div className="h-7 animate-pulse rounded-[var(--radius-sm)] bg-sunken" />
              <div className="h-7 animate-pulse rounded-[var(--radius-sm)] bg-sunken" />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="h-9 animate-pulse rounded-[var(--radius-sm)] bg-sunken" />
              <div className="h-[280px] animate-pulse rounded-[var(--radius-md)] border border-line bg-surface" />
            </div>
            <div className="hidden h-full w-[260px] shrink-0 animate-pulse rounded-[var(--radius-md)] border border-line bg-[var(--sidebar)] lg:block" />
          </div>
        </div>
      </div>
    );
  }

  if (shell.status === "not_found") {
    return (
      <div className="mx-auto max-w-[420px] px-6 py-24 text-center">
        <h1 className="mb-2 text-[22px] font-semibold tracking-[-0.03em] text-ink">
          Workspace not found
        </h1>
        <p className="mb-6 text-[12px] leading-relaxed text-ink-soft">
          This workspace may have been removed, or you may not have access.
        </p>
        <Link
          href="/app"
          className="inline-flex h-9 items-center justify-center rounded-[var(--radius-md)] bg-ink px-4 text-[13px] font-medium text-white hover:bg-[#2A2D33]"
        >
          Back to Workspaces
        </Link>
      </div>
    );
  }

  if (shell.status === "error") {
    return (
      <div className="mx-auto max-w-[420px] px-6 py-24 text-center">
        <p className="mb-4 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {shell.message}
        </p>
        <Link
          href="/app"
          className="inline-flex h-8 items-center justify-center rounded-[var(--radius-md)] border border-line bg-surface px-3 text-xs font-medium text-ink-soft hover:text-ink"
        >
          Workspaces
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
        documentPending={Boolean(documentId) && docLoading && !document}
      />
      {docError ? (
        <div className="absolute inset-x-0 top-[44px] z-30 flex justify-center px-4 pt-3">
          <div className="flex max-w-[480px] items-center gap-3 rounded-[12px] border border-danger/20 bg-danger-soft px-3 py-2 text-[12px] text-danger shadow-sm">
            <span className="min-w-0 flex-1">{docError}</span>
            <Link
              href={`/app/workspaces/${workspaceId}`}
              className="shrink-0 rounded-[8px] border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink"
            >
              Back
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
