"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Workspace } from "@/lib/api";

const STORAGE_KEY = "opensuite.activeWorkspaceId";

export function readStoredWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeWorkspaceId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore quota / private mode
  }
}

export function WorkspaceSelector({
  workspaces,
  activeId,
  onChange,
}: {
  workspaces: Workspace[];
  activeId: string;
  onChange: (workspaceId: string) => void;
}) {
  if (workspaces.length <= 1) {
    return null;
  }

  return (
    <label className="flex items-center gap-2 text-[11px] text-ink-soft">
      <span className="whitespace-nowrap">Workspace</span>
      <select
        className="h-8 rounded-[8px] border border-line bg-white px-2 text-[11px] text-ink outline-none focus-visible:border-accent"
        value={activeId}
        onChange={(event) => onChange(event.target.value)}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CreateWorkspaceEmptyState({
  creating,
  error,
  onCreate,
}: {
  creating: boolean;
  error: string | null;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = React.useState("My Workspace");

  return (
    <div className="mx-auto max-w-[440px] px-6 py-24 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-[12px] bg-sunken text-ink-faint">
        ▦
      </div>
      <h1 className="mb-2 text-[25px] font-semibold tracking-[-0.03em] text-ink">
        Create your workspace
      </h1>
      <p className="mb-6 text-[12px] leading-relaxed text-ink-soft">
        Workspaces hold your Word, PowerPoint, and Excel files. Create one to
        get started.
      </p>
      <form
        className="mx-auto flex max-w-[320px] flex-col gap-3 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (!trimmed || creating) return;
          onCreate(trimmed);
        }}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Workspace name"
          maxLength={100}
          disabled={creating}
          aria-label="Workspace name"
        />
        {error ? (
          <p className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create workspace"}
        </Button>
      </form>
    </div>
  );
}
