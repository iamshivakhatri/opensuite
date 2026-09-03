import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableName } from "drizzle-orm";

import {
  document,
  documentFormatEnum,
  documentVersion,
  documentVersionSourceEnum,
  workspace,
} from "../schema/product.js";

test("product schema exports workspace, document, and document_version", () => {
  assert.equal(getTableName(workspace), "workspace");
  assert.equal(getTableName(document), "document");
  assert.equal(getTableName(documentVersion), "document_version");
});

test("workspace and document support soft delete; document_version does not", () => {
  assert.ok("deletedAt" in workspace);
  assert.ok("deletedAt" in document);
  assert.equal("deletedAt" in documentVersion, false);
});

test("document has no current_version_id; latest version is max version_number", () => {
  assert.equal("currentVersionId" in document, false);
  assert.ok("versionNumber" in documentVersion);
  assert.ok("storageKey" in documentVersion);
  assert.ok("parentVersionId" in documentVersion);
});

test("format and source enums match the decided product vocabulary", () => {
  assert.deepEqual(documentFormatEnum.enumValues, ["docx", "pptx", "xlsx"]);
  assert.deepEqual(documentVersionSourceEnum.enumValues, [
    "upload",
    "user",
    "agent",
    "system",
  ]);
});
