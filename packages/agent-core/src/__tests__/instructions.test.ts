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
  assert.match(prompt, /inspect before editing/i);
  assert.match(prompt, /object affordances/i);
  assert.match(prompt, /supported:false/i);
  assert.match(prompt, /mutations are currently unavailable/i);
  assert.match(prompt, /never invent names/i);
  assert.match(prompt, /chain-of-thought/i);
  assert.doesNotMatch(prompt, /Advertised runtime capabilities/);
  assert.doesNotMatch(prompt, /Call only listed tools such as/);
  assert.doesNotMatch(prompt, /MULTIPLE_PARAGRAPHS/);
});

test("system prompt omits inspect guidance when capability missing", () => {
  const prompt = buildDocumentAgentSystemPrompt(createCapabilities());
  assert.match(prompt, /unavailable/i);
  assert.doesNotMatch(prompt, /inspect before editing/i);
  assert.doesNotMatch(prompt, /Use find with mode text/);
});

test("system prompt mentions mutate behavior without listing every tool", () => {
  const prompt = buildDocumentAgentSystemPrompt(
    createCapabilities(
      Capabilities.DocumentMutate,
      "set_table_cells_text",
      "insert_table_rows",
      "insert_table_column",
    ),
  );
  assert.doesNotMatch(prompt, /mutations are currently unavailable/i);
  assert.match(prompt, /mutation tools in your tool list/i);
  assert.match(prompt, /NOT a tool name/i);
  assert.match(prompt, /Never claim an edit succeeded/i);
  assert.match(prompt, /structural handles/i);
  assert.match(prompt, /STALE_HANDLE/);
  assert.match(prompt, /re-inspect/i);
  assert.match(prompt, /do not retry that same tool/i);
  // Catalog communicates availability — prompt must not enumerate ops.
  assert.doesNotMatch(prompt, /document\.set_table_cells_text/);
  assert.doesNotMatch(prompt, /document\.insert_table_column/);
  assert.doesNotMatch(prompt, /Advertised runtime capabilities/);
});
