"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { userFacingError } from "@/components/files/format";
import { ApiError, getDocument } from "@/lib/api";
import { WorkspaceIde } from "@/components/documents/workspace-ide";

type State =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      workspaceId: string;
      document: Awaited<ReturnType<typeof getDocument>>;
    };

/**
 * Document route entry — loads the file then opens the workspace IDE with it
 * as the active tab.
 */
export function DocumentWorkspace({ documentId }: { documentId: string }) {
  const [state, setState] = React.useState<State>({ status: "loading" });

  const load = React.useCallback(async () => {
    setState({ status: "loading" });
    try {
      const document = await getDocument(documentId);
      setState({
        status: "ready",
        workspaceId: document.workspaceId,
        document,
      });
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        setState({ status: "not_found" });
        return;
      }
      setState({
        status: "error",
        message: userFacingError(error, "Could not load this document."),
      });
    }
  }, [documentId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <div className="grid h-full place-items-center text-[13px] text-ink-soft">
        Loading document…
      </div>
    );
  }

  if (state.status === "not_found") {
    return (
      <div className="mx-auto max-w-[420px] px-6 py-24 text-center">
        <h1 className="mb-2 text-[22px] font-semibold tracking-[-0.03em] text-ink">
          Document not found
        </h1>
        <p className="mb-6 text-[12px] leading-relaxed text-ink-soft">
          This file may have been removed, or you may not have access to it.
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

  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-[420px] px-6 py-24 text-center">
        <p className="mb-4 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {state.message}
        </p>
        <div className="flex justify-center gap-2">
          <Button type="button" size="sm" onClick={() => void load()}>
            Try again
          </Button>
          <Link
            href="/app"
            className="inline-flex h-8 items-center justify-center rounded-[var(--radius-md)] border border-line bg-surface px-3 text-xs font-medium text-ink-soft hover:border-[#D1D5DC] hover:text-ink"
          >
            Workspaces
          </Link>
        </div>
      </div>
    );
  }

  return (
    <WorkspaceIde
      workspaceId={state.workspaceId}
      document={state.document}
    />
  );
}
