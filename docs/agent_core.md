# Agent Core V3

`packages/agent-core-v3` is the active generic model/tool runtime. The API owns model resolution, persisted conversation context, document bindings, lifecycle, and product events.

```text
API resolves model + context + document tools
  → agent-core-v3 runAgent
    → generic model/tool loop
    → API persists result and document versions
```

The core has no database, HTTP, auth, storage, document semantics, checkpoints, retrieval, or compaction policy. `runModel` is its one-call primitive; `projectMessages` lets the API add first-turn request-local document context without teaching the core product rules.

## Run telemetry vocabulary

`AgentRunReport` (API) is the Cloud-neutral receipt. Canonical meanings:

| Term | Field / log key | Meaning |
|---|---|---|
| Model turn | `modelTurns` / `turns=` | One model invocation cycle |
| Tool call | `toolCalls` / `toolCalls=` | One tool invocation (any kind/outcome) |
| Read / mutation call | `tools[].kind` / `readCalls=` `mutationCalls=` | Classification of each tool call |
| Edit applied | `document.workingMutationCount` / `editsApplied=` | Successful logical mutation on run-local working bytes (batch items count) |
| Persisted version | `document.versionAdvances` / `persistedVersions=` | Immutable DB `document_version` advance (normally 0–1 per run) |
| Tool error | `failures` where `source=tool` / `toolErrors=` | Failed tool attempt; may be recovered |
| Outcome | `outcome` | Terminal run result (`success` / `failure` / `partial` / `cancelled`) |

Do not mix working revisions with persisted versions, or tool errors with terminal run failure. Product UI shows a high-level summary only; detailed counts belong in logs/admin.

Default server logs are a short human-readable run transcript (turn/LLM/tool/save/validation + DONE latency). Full JSON remains opt-in via `AGENT_RUN_REPORT_VERBOSE=1`.

## Dynamic tool surface experiment

The API passes one optional `projectTools({ tools, turn, messages })` callback to
V3. Before each model call, V3 snapshots its returned tool map, builds schema-only
tools from that snapshot, and uses the same snapshot for execution, scheduling,
and terminal-tool checks. A hidden tool cannot execute through the full registry.
Projected runs discard SDK-generated error-result messages before adding the
runtime's own results, preserving one result per call. Without the callback,
the original fixed schema map and execution behavior remain unchanged.

The API's `tool-groups.ts` selects the already engine/host-filtered tools. Its
`tools.load_group({ groups: [...] })` tool (provider name `tools_load_group`)
activates groups for the next model turn. Activation is run-local, monotonic,
idempotent, and ordered by sorted group/tool names. Unknown or unavailable groups
fail; a mixed valid/unknown request activates nothing. Groups with no executable
tools are omitted from the compact prompt index and loader schema.

With the installed engine 0.1.2, the previous run surface had **41 tools**:
35 document tools, four workspace tools, and two finish tools. There were three
reads, 36 mutations (including three workspace lifecycle actions), and two finish
tools. The initial surface now has **16 tools**: 15 existing common tools plus the
read-kind loader. `insert_paragraphs` covers both single and multiple paragraphs.
Workspace duplicate/select/source-inspect remain common to preserve multi-document
report workflows; both finish paths remain common for missing-source outcomes.
The six reported recurring-update tools need no discovery turn.

| Group | Hidden tools |
|---|---:|
| `page_layout` | 5 |
| `paragraphs` | 6 |
| `rich_content` | 4 |
| `table_structure` | 5 |
| `table_styling` | 4 |
| `text_formatting` | 2 |

Only common tool names and one sentence per group are added to the capability
list; hidden schemas and the complete hidden-name catalog are not injected.
Existing operation-specific safety guidance stays in place. Model configuration,
limits, retrieval, compaction, document validation, scheduling, handle rules,
provider aliases, and Rust behavior are unchanged. Context budgeting still
reserves the original full document-tool catalog, keeping this experiment focused
on the model-visible surface.

Compare these logs during DeepSeek dogfood:

```text
[agent] tool_surface run=… turn=… exposedToolCount=… exposedToolSchemaChars=… activeGroups=… discoveryTurn=…
[agent] tool_surface_summary run=… {"initialToolCount":…, "peakToolCount":…, "groupsLoaded":[…], "discoveryTurnCount":…}
```

`activeGroups` describes the tools exposed on that turn. `discoveryTurn` counts
turns requesting the loader, including rejected or output-limit-discarded calls.
Run summaries also log on failure. Generic `metrics.modelTurns[]` stores
`exposedToolCount` and `exposedToolSchemaChars`, including failed model calls.
Compare them with existing first reasoning/text/tool timings, reasoning/output
usage, model duration, and total run duration. No paid model benchmark was run.

The comparable size estimate is `JSON.stringify(schemaOnlyTools).length`, which
includes provider-safe names, descriptions, and serialized schema wrappers but
excludes execution functions and runtime traits. Initial schema size changes from
**36,248 to 11,831 characters (67.4% smaller)**, including the new loader. This is
not a token count or a measurement of the entire prompt.

### Inventory measured before the experiment

Names below are internal names; the existing provider mapping replaces dots with
underscores. Per-tool characters count one serialized map entry, excluding the
outer braces and separating commas. `mutate/lifecycle` retains V3's mutate kind;
finish tools retain read kind plus the terminal flag. The common column refers
to the new initial surface. Mutation exposure still requires an engine capability,
a model schema and a bound host method; batch tools also require `mutateBatch`.
Binary picture insert/replace, engine-only capabilities, and unwired formats stay
outside the model-facing inventory.

| Tool | Kind | Schema chars | Common |
|---|---|---:|---|
| `document.inspect` | read | 797 | yes |
| `document.find` | read | 310 | yes |
| `document.replace_text` | mutate | 800 | yes |
| `document.insert_paragraph` | mutate | 1,050 | no |
| `document.insert_paragraphs` | mutate | 1,084 | yes |
| `document.delete_paragraph` | mutate | 631 | no |
| `document.set_paragraph_style` | mutate | 829 | yes |
| `document.set_paragraph_formatting` | mutate | 888 | no |
| `document.set_text_formatting` | mutate | 1,237 | no |
| `document.set_table_cells_text` | mutate | 1,866 | yes |
| `document.insert_table_rows` | mutate | 1,573 | no |
| `document.insert_table_row` | mutate | 1,529 | no |
| `document.insert_table_column` | mutate | 1,108 | no |
| `document.create_table` | mutate | 1,024 | yes |
| `document.delete_table` | mutate | 886 | no |
| `document.delete_table_row` | mutate | 1,386 | yes |
| `document.delete_table_column` | mutate | 993 | no |
| `document.set_table_formatting` | mutate | 1,207 | no |
| `document.set_table_column_widths` | mutate | 986 | no |
| `document.set_table_cell_shading` | mutate | 1,811 | no |
| `document.set_table_cells_formatting` | mutate | 2,220 | no |
| `document.set_content_control_text` | mutate | 671 | no |
| `document.set_paragraphs_list` | mutate | 781 | no |
| `document.set_hyperlink` | mutate | 673 | no |
| `document.delete_picture` | mutate | 244 | no |
| `document.set_picture_size` | mutate | 324 | no |
| `document.insert_page_break` | mutate | 977 | no |
| `document.delete_page_break` | mutate | 250 | no |
| `document.set_page_setup` | mutate | 510 | no |
| `document.set_header_footer_text` | mutate | 312 | no |
| `document.set_page_number` | mutate | 369 | no |
| `document.batch_replace_text` | mutate | 954 | yes |
| `document.batch_paragraph_styles` | mutate | 1,008 | no |
| `document.batch_paragraph_formatting` | mutate | 1,141 | no |
| `document.batch_text_formatting` | mutate | 1,461 | no |
| `workspace.create_blank_document` | mutate/lifecycle | 343 | yes |
| `workspace.duplicate_current_document` | mutate/lifecycle | 448 | yes |
| `workspace.select_document` | mutate/lifecycle | 407 | yes |
| `workspace.inspect_document` | read | 528 | yes |
| `finish` | finish | 191 | yes |
| `finish_with_input_needed` | finish | 399 | yes |
