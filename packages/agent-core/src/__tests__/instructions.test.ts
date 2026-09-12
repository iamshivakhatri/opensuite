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
  assert.match(prompt, /Inspect only when you need/i);
  assert.match(prompt, /supported:false/i);
  assert.match(prompt, /reasonCode/i);
  assert.match(prompt, /authoritative/i);
  assert.match(prompt, /Editing is currently unavailable/i);
  assert.match(prompt, /never invent tool names/i);
  assert.match(prompt, /chain-of-thought/i);
  assert.doesNotMatch(prompt, /Advertised runtime capabilities/);
  assert.doesNotMatch(prompt, /Call only listed tools such as/);
  assert.doesNotMatch(prompt, /MULTIPLE_PARAGRAPHS/);
});

test("system prompt omits inspect guidance when capability missing", () => {
  const prompt = buildDocumentAgentSystemPrompt(createCapabilities());
  assert.match(prompt, /unavailable/i);
  assert.doesNotMatch(prompt, /Inspect only when you need/i);
  assert.doesNotMatch(prompt, /Use find \(mode text\)/);
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
  assert.doesNotMatch(prompt, /Editing is currently unavailable/i);
  assert.match(prompt, /AUTHORING:/i);
  assert.match(prompt, /semantic structure/i);
  assert.match(prompt, /lightweight presentation plan|presentation plan/i);
  assert.match(prompt, /fake layout|punctuation/i);
  assert.match(prompt, /Capability presence is not a command/i);
  assert.match(prompt, /grouping hack|genuine itemization/i);
  assert.match(prompt, /meaning first, appearance second/i);
  assert.match(prompt, /create_blank succeeds/i);
  assert.match(prompt, /Never claim an edit succeeded/i);
  assert.match(prompt, /STALE_HANDLE/);
  assert.match(prompt, /re-inspect/i);
  assert.match(prompt, /do not retry the same call unchanged/i);
  assert.match(prompt, /fewest MODEL ROUNDS/i);
  assert.match(prompt, /LONG-FORM/i);
  assert.match(prompt, /compact first pass|compact passes/i);
  assert.match(prompt, /semantic rowLabel/i);
  // Catalog communicates availability — prompt must not enumerate ops as callable lists.
  assert.doesNotMatch(prompt, /document\.set_table_cells_text/);
  assert.doesNotMatch(prompt, /document\.insert_table_column/);
  assert.doesNotMatch(prompt, /Advertised runtime capabilities/);
  // No genre-specific branching.
  assert.doesNotMatch(prompt, /if poem|if resume|if report|contentType ===/i);
});
