import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OPENSUITE_DOCUMENT_DRAG_MIME,
  encodeDocumentDragPayload,
  readComposerDrop,
} from "./document-drag.ts";

describe("readComposerDrop", () => {
  it("prefers a workspace document tag over OS files", () => {
    const payload = encodeDocumentDragPayload({
      id: "doc-1",
      name: "September Updates.docx",
      format: "docx",
      workspaceId: "ws-1",
    });
    const dataTransfer = {
      getData: (type: string) => (type === OPENSUITE_DOCUMENT_DRAG_MIME ? payload : ""),
      files: [{ name: "ignored.docx" }] as unknown as FileList,
    } as DataTransfer;

    const drop = readComposerDrop(dataTransfer);
    assert.equal(drop.workspaceDocument?.name, "September Updates.docx");
    assert.equal(drop.files.length, 0);
  });

  it("falls back to OS files when no workspace payload is present", () => {
    const file = { name: "notes.docx" } as File;
    const dataTransfer = {
      getData: () => "",
      files: [file] as unknown as FileList,
    } as DataTransfer;

    const drop = readComposerDrop(dataTransfer);
    assert.equal(drop.workspaceDocument, null);
    assert.deepEqual(drop.files, [file]);
  });
});
