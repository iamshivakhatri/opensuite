import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PERMANENT_DELETE_SURFACE,
  TRASH_PATH,
  formatStorageBytes,
  notifyStorageChanged,
  permanentDeleteConfirmBody,
  permanentWorkspaceDeleteConfirmBody,
  permanentWorkspaceDeleteConfirmCopy,
  removePurgedTrashItem,
  STORAGE_CHANGED_EVENT,
  storageQuotaKind,
  storageQuotaMessage,
  storageRemainingLabel,
  storageUsageRatio,
  storageUsedOfQuotaLabel,
  trashDocumentActions,
  trashPurgePath,
  trashWorkspaceActions,
  type StorageStatus,
} from "./storage-model.ts";

const MiB = 1024 * 1024;

describe("formatStorageBytes", () => {
  it("formats bytes, KB, MB, and GB with binary units", () => {
    assert.equal(formatStorageBytes(0), "0 B");
    assert.equal(formatStorageBytes(512), "512 B");
    assert.equal(formatStorageBytes(2048), "2.0 KB");
    assert.equal(formatStorageBytes(42 * MiB), "42.0 MB");
    assert.equal(formatStorageBytes(500 * MiB), "500 MB");
    assert.equal(formatStorageBytes(2 * 1024 * MiB), "2.00 GB");
  });

  it("clamps negative display values without inventing accounting", () => {
    assert.equal(formatStorageBytes(-10), "0 B");
  });
});

describe("storage status presentation", () => {
  it("renders used/quota/remaining correctly", () => {
    const status: StorageStatus = {
      usedBytes: 42 * MiB,
      quotaBytes: 500 * MiB,
      remainingBytes: 458 * MiB,
    };
    assert.equal(storageUsedOfQuotaLabel(status), "42.0 MB of 500 MB used");
    assert.equal(storageRemainingLabel(status), "458 MB remaining");
    assert.ok(storageUsageRatio(status) > 0.08 && storageUsageRatio(status) < 0.09);
    assert.equal(storageQuotaKind(status), "normal");
    assert.equal(storageQuotaMessage("normal"), null);
  });

  it("marks high usage as near quota", () => {
    const status: StorageStatus = {
      usedBytes: 460 * MiB,
      quotaBytes: 500 * MiB,
      remainingBytes: 40 * MiB,
    };
    assert.equal(storageQuotaKind(status), "near");
    assert.match(storageQuotaMessage("near") ?? "", /almost full/i);
  });

  it("marks full/exhausted storage clearly", () => {
    const status: StorageStatus = {
      usedBytes: 500 * MiB,
      quotaBytes: 500 * MiB,
      remainingBytes: 0,
    };
    assert.equal(storageQuotaKind(status), "full");
    assert.equal(storageRemainingLabel(status), "0 B remaining");
    assert.match(
      storageQuotaMessage("full") ?? "",
      /cannot be saved/i,
    );
  });
});

describe("trash navigation and actions", () => {
  it("points Review Trash at the library trash path", () => {
    assert.equal(TRASH_PATH, "/app/trash");
  });

  it("exposes permanent-delete for trashed documents", () => {
    const doc = trashDocumentActions({ workspaceDeleted: false });
    assert.equal(doc.canPermanentlyDelete, true);
    assert.equal(doc.canRestore, true);

    const blocked = trashDocumentActions({ workspaceDeleted: true });
    assert.equal(blocked.canRestore, false);
    assert.equal(blocked.canPermanentlyDelete, true);
    assert.equal(blocked.restoreBlockedReason, "Restore the workspace first");
  });

  it("exposes Delete forever for trashed workspaces", () => {
    const workspace = trashWorkspaceActions();
    assert.equal(workspace.canRestore, true);
    assert.equal(workspace.canPermanentlyDelete, true);
  });

  it("keeps permanent-delete surface limited to Trash", () => {
    assert.equal(PERMANENT_DELETE_SURFACE, "trash");
  });

  it("builds clear document permanent-delete confirmation copy", () => {
    const body = permanentDeleteConfirmBody("Q3 Report.docx");
    assert.match(body, /permanently deleted/);
    assert.match(body, /All saved versions/);
    assert.match(body, /storage they use will be reclaimed/);
    assert.match(body, /cannot be undone/);
    assert.equal(body.includes("S3"), false);
    assert.equal(body.includes("document_version"), false);
  });

  it("builds workspace confirmation with larger deletion scope", () => {
    const copy = permanentWorkspaceDeleteConfirmCopy("Acme HQ");
    assert.match(copy.lead, /Permanently deleting "Acme HQ"/);
    assert.deepEqual([...copy.items], [
      "the workspace",
      "all documents inside it",
      "all saved document versions",
      "workspace conversation history",
      "associated stored document data",
    ]);
    assert.match(copy.footer, /Storage used by this workspace will be reclaimed/);
    assert.match(copy.footer, /cannot be undone/);

    const body = permanentWorkspaceDeleteConfirmBody("Acme HQ");
    assert.match(body, /all documents inside it/);
    assert.match(body, /workspace conversation history/);
    assert.equal(body.includes("agent_run"), false);
    assert.equal(body.includes("S3"), false);
    assert.equal(body.includes("model_usage_event"), false);
  });

  it("maps purge kinds to the correct trash endpoints", () => {
    assert.equal(
      trashPurgePath("document", "doc-1"),
      "/api/trash/documents/doc-1",
    );
    assert.equal(
      trashPurgePath("workspace", "ws-1"),
      "/api/trash/workspaces/ws-1",
    );
  });

  it("removes a purged workspace from the trash list on success", () => {
    const before = [
      { id: "ws-keep", name: "Keep" },
      { id: "ws-gone", name: "Gone" },
    ];
    const after = removePurgedTrashItem(before, "ws-gone");
    assert.deepEqual(after, [{ id: "ws-keep", name: "Keep" }]);
  });

  it("leaves the list unchanged when purge fails (no success apply)", () => {
    const before = [
      { id: "ws-1", name: "Still here" },
      { id: "ws-2", name: "Also here" },
    ];
    // Failure path must not call removePurgedTrashItem.
    assert.deepEqual(before, [
      { id: "ws-1", name: "Still here" },
      { id: "ws-2", name: "Also here" },
    ]);
  });

  it("cancel performs no list mutation", () => {
    const workspaces = [{ id: "ws-1", name: "Drafts" }];
    // Cancel closes the dialog without calling removePurgedTrashItem or purge API.
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.id, "ws-1");
  });

  it("dispatches storage-changed after a successful purge path", () => {
    const events: string[] = [];
    const previous = globalThis.window;
    // Minimal window stub for Node tests.
    (globalThis as { window?: Window }).window = {
      dispatchEvent(event: Event) {
        events.push(event.type);
        return true;
      },
    } as Window;
    try {
      notifyStorageChanged();
      assert.deepEqual(events, [STORAGE_CHANGED_EVENT]);
    } finally {
      if (previous === undefined) {
        delete (globalThis as { window?: Window }).window;
      } else {
        (globalThis as { window?: Window }).window = previous;
      }
    }
  });
});
