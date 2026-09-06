import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Capabilities,
  buildDocumentAgentSystemPrompt,
  createCapabilities,
  readOnlyDocumentCapabilities,
} from "../index.js";

test("system prompt is task-oriented and read-only aware", () => {
  const prompt = buildDocumentAgentSystemPrompt(readOnlyDocumentCapabilities());
  assert.match(prompt, /OpenSuite/);
  assert.match(prompt, /document\.inspect/);
  assert.match(prompt, /overview first/i);
  assert.match(prompt, /document\.find/);
  assert.match(prompt, /mutations are currently unavailable/i);
  assert.match(prompt, /never invent names/i);
  assert.match(prompt, /chain-of-thought/i);
  assert.doesNotMatch(prompt, /Capability document\.mutate/);
});

test("system prompt omits inspect guidance when capability missing", () => {
  const prompt = buildDocumentAgentSystemPrompt(createCapabilities());
  assert.match(prompt, /unavailable/i);
  assert.doesNotMatch(prompt, /overview first/i);
  assert.doesNotMatch(prompt, /Use document\.find/);
});

test("system prompt mentions mutate only when advertised", () => {
  const prompt = buildDocumentAgentSystemPrompt(
    createCapabilities(
      Capabilities.DocumentMutate,
      "set_table_cells_text",
      "insert_table_rows",
      "insert_table_column",
    ),
  );
  assert.doesNotMatch(prompt, /mutations are currently unavailable/i);
  assert.match(prompt, /document\.replace_text/);
  assert.match(prompt, /document\.set_table_cells_text/);
  assert.match(prompt, /document\.insert_table_rows/);
  assert.match(prompt, /document\.insert_table_column/);
  assert.match(prompt, /NOT a tool name/i);
  assert.match(prompt, /Never claim an edit succeeded/i);
  assert.doesNotMatch(prompt, /cannot insert\/delete rows/i);
});
