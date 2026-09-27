import assert from "node:assert/strict";
import { test } from "node:test";

import { addPromptAttachmentFiles, uploadPromptAttachments, type PromptAttachment } from "./agent-prompt-attachments.ts";

const file = (name: string) => new File([name], name);
const document = (id: string) => ({ id, name: `${id}.docx` });

test("dropped DOCX files use the same attachment list as picked files", () => {
  const report = file("August Report.docx");
  const updates = file("September Updates.DOCX");
  const selected = addPromptAttachmentFiles([], [report]);
  const dropped = addPromptAttachmentFiles(selected, [report, updates, file("notes.pdf")]);
  assert.deepEqual(dropped.map((item) => item.file.name), ["August Report.docx", "September Updates.DOCX"]);
});

test("uploads each attached DOCX and returns IDs for the agent run", async () => {
  const attachments = [{ file: file("August Report.docx") }, { file: file("September Updates.docx") }];
  const uploaded: string[] = [];
  const ids = await uploadPromptAttachments("workspace-1", attachments, async (workspaceId, item) => {
    assert.equal(workspaceId, "workspace-1");
    return { document: document(item.name) as never };
  }, (_file, value) => uploaded.push(value.id));
  assert.deepEqual(ids, ["August Report.docx", "September Updates.docx"]);
  assert.deepEqual(uploaded, ids);
});

test("a failed upload stops before a run and reuses already uploaded documents on retry", async () => {
  const first = file("August Report.docx");
  const second = file("September Updates.docx");
  const attachments: PromptAttachment[] = [{ file: first }, { file: second }];
  let calls = 0;
  await assert.rejects(uploadPromptAttachments("workspace-1", attachments, async () => {
    calls++;
    if (calls === 2) throw new Error("upload failed");
    return { document: document(`doc-${calls}`) as never };
  }, (item, value) => {
    const attachment = attachments.find((entry) => entry.file === item)!;
    attachment.document = value;
  }), /upload failed/);
  assert.equal(attachments[0]?.document?.id, "doc-1");
  const ids = await uploadPromptAttachments("workspace-1", attachments, async () => {
    calls++;
    return { document: document(`doc-${calls}`) as never };
  }, () => undefined);
  assert.deepEqual(ids, ["doc-1", "doc-3"]);
  assert.equal(calls, 3);
});
