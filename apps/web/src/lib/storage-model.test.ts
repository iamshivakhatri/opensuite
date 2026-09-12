import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRASH_PATH,
  formatStorageBytes,
  permanentDeleteConfirmBody,
  storageQuotaKind,
  storageQuotaMessage,
  storageRemainingLabel,
  storageUsageRatio,
  storageUsedOfQuotaLabel,
  trashDocumentActions,
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

  it("exposes permanent-delete for trashed documents only", () => {
    const doc = trashDocumentActions({ workspaceDeleted: false });
    assert.equal(doc.canPermanentlyDelete, true);
    assert.equal(doc.canRestore, true);

    const blocked = trashDocumentActions({ workspaceDeleted: true });
    assert.equal(blocked.canRestore, false);
    assert.equal(blocked.canPermanentlyDelete, true);
    assert.equal(blocked.restoreBlockedReason, "Restore the workspace first");
  });

  it("does not expose unsupported workspace permanent purge", () => {
    const workspace = trashWorkspaceActions();
    assert.equal(workspace.canRestore, true);
    assert.equal(workspace.canPermanentlyDelete, false);
  });

  it("builds clear permanent-delete confirmation copy", () => {
    const body = permanentDeleteConfirmBody("Q3 Report.docx");
    assert.match(body, /permanently deleted/);
    assert.match(body, /All saved versions/);
    assert.match(body, /storage they use will be reclaimed/);
    assert.match(body, /cannot be undone/);
    assert.equal(body.includes("S3"), false);
    assert.equal(body.includes("document_version"), false);
  });
});
