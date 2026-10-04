import assert from "node:assert/strict";
import { test } from "node:test";

import { refersToOpenDocument, requestsDocumentChange } from "./document-target.js";
import { formatWorkspaceManifest } from "./workspace-manifest.js";

test("explicit current-document wording binds the open file", () => {
  assert.equal(refersToOpenDocument("Update this document"), true);
  assert.equal(refersToOpenDocument("Change the current document"), true);
  assert.equal(refersToOpenDocument("Update the board report"), false);
  assert.equal(refersToOpenDocument("Use this document to update the board report"), false);
  assert.equal(requestsDocumentChange("Create 10 documents"), true);
  assert.equal(requestsDocumentChange("Make a list of documents here"), false);
});

test("manifest lists workspace metadata without document bodies", () => {
  const documents = [
    { documentId: "open", name: "Open.docx", format: "docx", updatedAt: "2026-10-01T00:00:00.000Z", latestVersionNumber: 2 },
    { documentId: "source", name: "Source.docx", format: "docx", updatedAt: "2026-10-02T00:00:00.000Z", latestVersionNumber: 5 },
  ];
  const manifest = formatWorkspaceManifest(documents, "open", ["source"]);
  assert.match(manifest, /\[OPEN\] Open\.docx \(docx; ID open; updated 2026-10-01T00:00:00.000Z; v2\)/);
  assert.match(manifest, /\[TAGGED\] Source\.docx \(docx; ID source; updated 2026-10-02T00:00:00.000Z; v5\)/);
  assert.doesNotMatch(manifest, /body|snippet|heading|table/i);
});


test("explicit document-style wording binds only this/current/open document", () => {
  assert.equal(refersToOpenDocument("Learn the document style from this document and save it for future use."), true);
  assert.equal(refersToOpenDocument("Learn the style from this document"), true);
  assert.equal(refersToOpenDocument("Save the document style of the current report"), true);
  assert.equal(refersToOpenDocument("Learn the document style from the board report"), false);
  assert.equal(refersToOpenDocument("Tell me all the styles I have saved."), false);
});
