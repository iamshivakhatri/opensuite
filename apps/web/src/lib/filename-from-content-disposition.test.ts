import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filenameFromContentDisposition } from "./filename-from-content-disposition.ts";

describe("filenameFromContentDisposition", () => {
  it("prefers the RFC 5987 UTF-8 filename", () => {
    assert.equal(
      filenameFromContentDisposition(
        `attachment; filename="Report.docx"; filename*=UTF-8''Northstar%20Launch%20Report.docx`,
      ),
      "Northstar Launch Report.docx",
    );
  });

  it("falls back to the quoted ASCII filename", () => {
    assert.equal(
      filenameFromContentDisposition(`attachment; filename="Q1 Report.docx"`),
      "Q1 Report.docx",
    );
  });

  it("returns undefined when the header is missing", () => {
    assert.equal(filenameFromContentDisposition(null), undefined);
  });
});
