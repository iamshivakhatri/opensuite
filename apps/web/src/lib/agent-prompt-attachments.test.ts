import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addPromptAttachmentFiles,
  attachmentIdsReady,
  hasPendingUploads,
  uploadPromptAttachments,
  type PromptAttachment,
} from "./agent-prompt-attachments.ts";

const file = (name: string, size = 10) =>
  new File([name], name, { lastModified: 1 });

test("accepts supported chat attachment types and skips duplicates", () => {
  const report = file("August Report.docx");
  const notes = file("notes.pdf");
  const image = file("chart.png");
  const selected = addPromptAttachmentFiles([], [report]);
  const dropped = addPromptAttachmentFiles(selected.items, [
    report,
    notes,
    image,
    file("slide.pptx"),
  ]);
  assert.equal(dropped.rejected, true);
  assert.deepEqual(
    dropped.items.map((item) => item.file.name),
    ["August Report.docx", "notes.pdf", "chart.png"],
  );
  assert.ok(dropped.items.every((item) => item.status === "pending"));
});

test("uploads pending files before send and reuses ready attachments on retry", async () => {
  const first = file("August Report.docx");
  const second = file("notes.pdf");
  const attachments: PromptAttachment[] = [
    { localId: "a", file: first, status: "pending" },
    { localId: "b", file: second, status: "pending" },
  ];
  let calls = 0;
  await assert.rejects(
    uploadPromptAttachments(
      "workspace-1",
      attachments,
      async () => {
        calls++;
        if (calls === 2) throw new Error("upload failed");
        return {
          attachment: {
            id: `att-${calls}`,
            filename: "x",
            mediaType: "application/pdf",
            sizeBytes: 1,
            status: "staged",
          },
        };
      },
      (localId, patch) => {
        const item = attachments.find((entry) => entry.localId === localId)!;
        Object.assign(item, patch);
      },
    ),
    /upload failed/,
  );
  assert.equal(attachments[0]?.status, "ready");
  assert.equal(attachments[0]?.attachment?.id, "att-1");
  assert.equal(attachments[1]?.status, "error");
  assert.equal(hasPendingUploads(attachments), false);
  assert.equal(attachmentIdsReady(attachments), null);

  attachments[1]!.status = "pending";
  attachments[1]!.error = undefined;
  const ids = await uploadPromptAttachments(
    "workspace-1",
    attachments,
    async () => {
      calls++;
      return {
        attachment: {
          id: `att-${calls}`,
          filename: "x",
          mediaType: "application/pdf",
          sizeBytes: 1,
          status: "staged",
        },
      };
    },
    (localId, patch) => {
      const item = attachments.find((entry) => entry.localId === localId)!;
      Object.assign(item, patch);
    },
  );
  assert.deepEqual(ids, ["att-1", "att-3"]);
  assert.equal(calls, 3);
  assert.deepEqual(attachmentIdsReady(attachments), ["att-1", "att-3"]);
});

test("send stays blocked while any upload is pending", () => {
  const attachments: PromptAttachment[] = [
    {
      localId: "a",
      file: file("a.pdf"),
      status: "ready",
      attachment: {
        id: "1",
        filename: "a.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1,
        status: "staged",
      },
    },
    { localId: "b", file: file("b.png"), status: "uploading" },
  ];
  assert.equal(hasPendingUploads(attachments), true);
  assert.equal(attachmentIdsReady(attachments), null);
});
