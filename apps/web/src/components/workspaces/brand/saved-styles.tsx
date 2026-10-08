"use client";
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listSavedStyles,
  getSavedStyle,
  renameSavedStyle,
  deleteSavedStyle,
  learnSavedStyle,
  type StyleProfile,
} from "@/lib/brand-api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, PromptDialog } from "@/components/ui/context-menu";
import { userFacingError } from "@/components/files/format";
import { useToast } from "@/lib/toast";
import { uploadOfficeFiles } from "@/lib/office-upload";
import { queryKeys } from "@/lib/query-keys";

export function SavedStyles({ workspaceId }: { workspaceId: string }) {
  const [offset, setOffset] = React.useState(0);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [rename, setRename] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [remove, setRemove] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const client = useQueryClient();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [learning, setLearning] = React.useState(false);
  const { toast } = useToast();
  const list = useQuery({
    queryKey: ["saved-styles", offset],
    queryFn: () => listSavedStyles(offset),
  });
  const detail = useQuery({
    queryKey: ["saved-style", detailId],
    queryFn: () => getSavedStyle(detailId!),
    enabled: Boolean(detailId),
  });
  async function change(action: () => Promise<unknown>, title: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setRename(null);
      setRemove(null);
      setDetailId(null);
      await client.invalidateQueries({ queryKey: ["saved-styles"] });
      await client.invalidateQueries({ queryKey: ["saved-style"] });
      toast({ tone: "success", title });
    } catch (err) {
      setError(userFacingError(err, "Could not update saved style."));
    } finally {
      setBusy(false);
    }
  }
  // Upload a DOCX into this workspace, then learn its style from that saved version.
  async function learnFromUpload(file: File | undefined) {
    if (!file || learning) return;
    setLearning(true);
    setError(null);
    try {
      const { uploaded, errors } = await uploadOfficeFiles(workspaceId, [file]);
      const document = uploaded[0];
      if (!document || document.format !== "docx") {
        throw new Error(errors[0] ?? "Only .docx files can be used to learn a style.");
      }
      await learnSavedStyle(document.id);
      await client.invalidateQueries({ queryKey: ["saved-styles"] });
      await client.invalidateQueries({ queryKey: queryKeys.workspaceDocuments(workspaceId) });
      setOffset(0);
      toast({ tone: "success", title: "Style saved", description: `Learned from ${file.name}.` });
    } catch (err) {
      setError(userFacingError(err, "Could not learn a style from that file."));
    } finally {
      setLearning(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="os-type-secondary max-w-[60ch] text-ink-soft">
          Your personal styles learned from real documents, available across your workspaces. Brand
          preferences stay separate.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="sr-only"
          aria-label="Upload a DOCX to learn its style"
          onChange={(event) => void learnFromUpload(event.target.files?.[0])}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={learning}
          title="The file is added to this workspace so the saved style keeps its source."
          onClick={() => fileRef.current?.click()}
        >
          {learning ? "Learning style…" : "Learn from a document"}
        </Button>
      </div>
      {error && !rename && !remove ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {list.isPending ? (
        <p role="status" className="text-ink-soft">
          Loading saved styles…
        </p>
      ) : list.error ? (
        <div role="alert">
          <p className="text-danger">
            {userFacingError(list.error, "Could not load saved styles.")}
          </p>
          <Button variant="outline" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </div>
      ) : !list.data?.length ? (
        <p className="py-6 text-sm text-ink-soft">
          No saved styles yet. Upload a DOCX above, or ask the document agent to learn a style from an open document.
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {list.data.map((profile) => (
            <li key={profile.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="break-words text-sm font-medium text-ink">{profile.name}</h2>
                  <p className="mt-1 break-words text-xs text-ink-soft">
                    {profile.source.fileName}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {profile.body.fontFamily || "Body font not identified"} ·{" "}
                    {profile.headingLevels.length} heading levels ·{" "}
                    {new Date(profile.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDetailId(detailId === profile.id ? null : profile.id)}
                  >
                    {detailId === profile.id ? "Hide details" : "View details"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setRename(profile);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setRemove(profile);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {detailId === profile.id ? (
                <div className="mt-4 space-y-2 rounded-[var(--radius-sm)] bg-sunken p-4 text-xs text-ink-soft">
                  {detail.isPending ? (
                    <p role="status">Loading details…</p>
                  ) : detail.error ? (
                    <div role="alert">
                      <p className="text-danger">
                        {userFacingError(detail.error, "Could not load style details.")}
                      </p>
                      <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
                        Retry
                      </Button>
                    </div>
                  ) : detail.data ? (
                    <StyleDetails profile={detail.data} />
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0 || list.isFetching}
          onClick={() => {
            setDetailId(null);
            setOffset((value) => Math.max(0, value - 20));
          }}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={list.data?.length !== 20 || list.isFetching}
          onClick={() => {
            setDetailId(null);
            setOffset((value) => value + 20);
          }}
        >
          Next
        </Button>
      </div>
      {rename ? (
        <PromptDialog
          title="Rename saved style"
          label="Profile name"
          initialValue={rename.name}
          busy={busy}
          error={error}
          onCancel={() => setRename(null)}
          onSubmit={(name) =>
            void change(() => renameSavedStyle(rename.id, name), "Saved style renamed")
          }
        />
      ) : null}
      {remove ? (
        <ConfirmDialog
          title="Delete saved style?"
          body={`Delete “${remove.name}”? Source documents will stay unchanged.`}
          confirmLabel="Delete"
          tone="danger"
          busy={busy}
          error={error}
          onCancel={() => setRemove(null)}
          onConfirm={() => void change(() => deleteSavedStyle(remove.id), "Saved style deleted")}
        />
      ) : null}
    </div>
  );
}

function StyleDetails({ profile }: { profile: StyleProfile }) {
  return (
    <>
      <p>
        Body: {profile.style.body.text.fontFamily || "Unknown font"}
        {profile.style.body.text.fontSizeHalfPoints
          ? `, ${profile.style.body.text.fontSizeHalfPoints / 2} pt`
          : ""}
      </p>
      <p>
        Heading hierarchy:{" "}
        {profile.style.headings
          .map((heading) => `Level ${heading.level}: ${heading.text.fontFamily || "Unknown font"}`)
          .join(" · ") || "No headings identified"}
      </p>
      <p>
        Header / footer:{" "}
        {profile.style.headersFooters.present ? "Present in source" : "Not identified"}
      </p>
      <p>
        Source: {profile.source.fileName}, saved version {profile.source.versionId}
      </p>
      {profile.style.diagnostics.length ? (
        <p>
          Notes:{" "}
          {profile.style.diagnostics
            .slice(0, 8)
            .map((note) => note.message)
            .join(" · ")}
        </p>
      ) : null}
    </>
  );
}
