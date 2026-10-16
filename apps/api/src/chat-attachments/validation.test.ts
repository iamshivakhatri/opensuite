import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyChatAttachmentBytes } from "./validation.js";

test("accepts supported media by extension and light magic", () => {
  assert.equal(
    verifyChatAttachmentBytes("notes.pdf", Buffer.from("%PDF-1.4\n"))?.mediaType,
    "application/pdf",
  );
  assert.equal(
    verifyChatAttachmentBytes("readme.txt", Buffer.from("hello"))?.mediaType,
    "text/plain",
  );
  assert.equal(
    verifyChatAttachmentBytes("readme.md", Buffer.from("# Title"))?.mediaType,
    "text/markdown",
  );
  assert.equal(
    verifyChatAttachmentBytes(
      "a.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )?.mediaType,
    "image/png",
  );
  assert.equal(
    verifyChatAttachmentBytes("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mediaType,
    "image/jpeg",
  );
  assert.equal(
    verifyChatAttachmentBytes("doc.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04]))?.mediaType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});

test("rejects unsupported or mismatched bytes", () => {
  assert.equal(verifyChatAttachmentBytes("slide.pptx", Buffer.from("PK")), null);
  assert.equal(verifyChatAttachmentBytes("notes.pdf", Buffer.from("not-pdf")), null);
  assert.equal(verifyChatAttachmentBytes("a.png", Buffer.from("nope")), null);
  assert.equal(verifyChatAttachmentBytes("bad.txt", Buffer.from([0, 1, 2])), null);
});
