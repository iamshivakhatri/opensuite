import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ListedDocument } from "./api.ts";
import {
  canCreateBlankDocument,
  findPristineBlankDocument,
  isPristineBlankDocument,
} from "./blank-document-guard.ts";

function doc(partial: Partial<ListedDocument> & Pick<ListedDocument, "name">): ListedDocument {
  return {
    id: partial.id ?? "doc-1",
    workspaceId: partial.workspaceId ?? "ws-1",
    name: partial.name,
    format: partial.format ?? "docx",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    latestVersion: partial.latestVersion ?? {
      id: "v1",
      versionNumber: 1,
      sizeBytes: 1200,
      source: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("blank document guard", () => {
  it("treats default Untitled Document.docx at v1 as pristine", () => {
    assert.equal(isPristineBlankDocument(doc({ name: "Untitled Document.docx" })), true);
    assert.equal(canCreateBlankDocument([doc({ name: "Untitled Document.docx" })]), false);
  });

  it("allows create after rename or newer version", () => {
    assert.equal(
      isPristineBlankDocument(doc({ name: "Notes.docx" })),
      false,
    );
    assert.equal(
      isPristineBlankDocument(
        doc({
          name: "Untitled Document.docx",
          latestVersion: {
            id: "v2",
            versionNumber: 2,
            sizeBytes: 2400,
            source: "user",
            createdAt: "2026-01-01T00:01:00.000Z",
          },
        }),
      ),
      false,
    );
    assert.equal(
      canCreateBlankDocument([doc({ name: "Notes.docx" })]),
      true,
    );
  });

  it("finds the unused blank among mixed files", () => {
    const blank = doc({ id: "blank", name: "Untitled Document.docx" });
    const files = [doc({ id: "a", name: "Report.docx" }), blank];
    assert.equal(findPristineBlankDocument(files)?.id, "blank");
  });
});
