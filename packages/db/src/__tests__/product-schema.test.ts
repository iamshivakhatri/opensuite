import assert from "node:assert/strict";
import { test } from "node:test";
import { getTableName } from "drizzle-orm";

import {
  agentMessage,
  agentMessageRoleEnum,
  agentRun,
  agentRunStatusEnum,
  agentStep,
  agentStepKindEnum,
  agentStepStatusEnum,
  agentThread,
} from "../schema/agent.js";
import {
  document,
  documentFormatEnum,
  documentUserState,
  documentVersion,
  documentVersionSourceEnum,
  workspace,
} from "../schema/product.js";

test("product schema exports workspace, document, and document_version", () => {
  assert.equal(getTableName(workspace), "workspace");
  assert.equal(getTableName(document), "document");
  assert.equal(getTableName(documentVersion), "document_version");
});

test("document_user_state tracks per-user star and last-opened", () => {
  assert.equal(getTableName(documentUserState), "document_user_state");
  assert.ok("starred" in documentUserState);
  assert.ok("starredAt" in documentUserState);
  assert.ok("lastOpenedAt" in documentUserState);
  assert.equal("deletedAt" in documentUserState, false);
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

test("agent schema exports thread, message, run, and step tables", () => {
  assert.equal(getTableName(agentThread), "agent_thread");
  assert.equal(getTableName(agentMessage), "agent_message");
  assert.equal(getTableName(agentRun), "agent_run");
  assert.equal(getTableName(agentStep), "agent_step");
});

test("agent enums match the decided persistence vocabulary", () => {
  assert.deepEqual(agentMessageRoleEnum.enumValues, ["user", "assistant"]);
  assert.deepEqual(agentRunStatusEnum.enumValues, [
    "queued",
    "planning",
    "running",
    "waiting_for_confirmation",
    "completed",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual(agentStepKindEnum.enumValues, [
    "plan",
    "inspect",
    "tool",
    "confirmation",
    "validation",
    "final",
  ]);
  assert.deepEqual(agentStepStatusEnum.enumValues, [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]);
});

test("agent_thread soft-archives; messages/runs/steps are immutable history", () => {
  assert.ok("archivedAt" in agentThread);
  assert.equal("deletedAt" in agentThread, false);
  assert.equal("deletedAt" in agentMessage, false);
  assert.equal("deletedAt" in agentRun, false);
  assert.equal("deletedAt" in agentStep, false);
});

test("agent_run may record base document version provenance", () => {
  assert.ok("baseDocumentVersionId" in agentRun);
});
