# Agent Core V3

`packages/agent-core-v3` is the active generic model/tool runtime. The API owns model resolution, persisted conversation context, document bindings, lifecycle, and product events.

```text
API resolves model + context + document tools
  → agent-core-v3 runAgent
    → generic model/tool loop
    → API persists result and document versions
```

The core has no database, HTTP, auth, storage, document semantics, checkpoints, retrieval, or compaction policy. `runModel` is its one-call primitive; `projectMessages` lets the API add first-turn request-local document context without teaching the core product rules.

Within a human-triggered run, model turns retain the prior provider reasoning,
tool calls, and results while the API refreshes the current working document view.
At the next human prompt, the API instead loads bounded completed human turns:
the request, final assistant reply when recorded, a small status/tool-name result,
and the latest persisted document. Full model turns stay in local run traces;
durable tool steps stay separate from later model-facing conversation history.

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

## Local full run traces

Set `AGENT_RUN_TRACE=full` in the API environment to append one Markdown file per
agent run. Optional `AGENT_RUN_TRACE_DIR` selects a directory; the default is
`.agent-traces/` relative to the API process's working directory. Filenames contain
the full run ID followed by a readable Eastern start time (EST/EDT automatically):
`run-283b7bc5_10-01-2026_09-05-06-AM-EDT.md`. Unset the setting or use
`AGENT_RUN_TRACE=off` to disable it. Disabled tracing creates no files or directories
and performs no trace serialization.

**Files may contain full user, document, and model content.** The default directory
is gitignored and local only; there is no database, telemetry, storage upload, or UI
connection. Keep custom directories outside version control. Files are created
with owner-only permissions. Appends happen during execution, so partial files
remain after failure, cancellation, or process exit. A failed diagnostic write
prints a short warning and does not fail the agent run.

The API owns `run-trace.ts`; V3 exposes only an optional `onDiagnostic` callback.
Requests are captured in `streamTurn` immediately before `streamText`, **after**
`projectMessages` and per-turn `projectTools` / schema-only provider-safe aliases.
The request sections contain the actual system, message array, and schema map
passed to the SDK. Metadata includes the current factory's allowlisted reasoning,
provider routing, and usage settings, never the model object's credential config.
Per model turn, SDK stream deltas (`reasoning-delta`, `text-delta`,
`tool-input-*`) are accumulated in memory and flushed once as complete
**Reasoning**, **Assistant Text**, and **Tool Calls** blocks — never as one
Markdown section per token. Partial streams (error/cancel) flush whatever was
accumulated under **Reasoning — Partial** / **Assistant Text — Partial** before
the error. Usage/timing (including first reasoning/text/tool latency) is written
once at turn completion. `responseMessages` and per-delta stream events are not
duplicated in the Markdown; the canonical complete blocks are enough.

Raw tool results are recorded as one **Tool Result** block per call (arguments,
duration, outcome, rawResult, and the runtime observation wrapper). Each later
request also labels projected tool results by `toolCallId`, so provider
continuation can be compared with the original output. The **Model-Facing
Observation** section is the actual next-turn projection (including C7
compaction). Terminal tools have no next model turn. Retrieval, constructed
context, version creation, validation, reports, and durable settlement are
recorded without extra document reads. Error transport/config properties and
causes are omitted because they can contain secrets; the trace labels this
omission.

This is the application-level request, not an HTTP wire dump. SDK normalization,
adapter serialization/defaults, internal retries, transport headers and any
reasoning the provider does not expose remain outside the trace. Prompts, replay,
retrieval, compaction, tool selection and execution are unchanged.

## Clarification escape hatch

The API always exposes `request_clarification({ question: string })`, a read-kind
terminal tool. Its nonblank question becomes the final response through the
existing message event/persistence path; settlement uses
`completed_with_input_needed` (the panel shows "Needs your input"). The tool does
not edit a document or create a version. Earlier successful edits still flush at
the run boundary. A reply starts a normal new run in the same thread, with the
prior request and question in history; no pause/resume state is added.

Policy asks early only when conflicting or genuinely missing information allows
two or more interpretations with materially different facts, structure or
outcomes. One narrow read may establish the conflict. Typos, casing, fuzzy matches,
missing selectors, deterministic recovery and delegated judgment do not justify
clarification. The schema is question-only; structured choices are deferred.
The generic runtime, scheduling and both existing finish tools are unchanged.

## Capability discovery

The API owns a process-wide capability catalog in `apps/api/src/agent/capabilities/`.
The catalog indexes IDs, immediate children, provider-safe tool names, and lexical
search terms once at startup. It is source-code metadata, not a database catalog.
A run creates a `CapabilitySession` from the tools actually supplied by the
engine and host. Empty groups are unavailable for that run.

The first model turn receives the existing common tools plus
`capabilities.list`, `capabilities.search`, and `capabilities.load`. Its system
instruction lists only available root domains. Listing shows immediate children;
search returns at most eight compact matches. Loading a leaf group or tool is
run-local, monotonic, and idempotent. Unknown or unavailable IDs fail together.
The next model turn receives schemas for the newly loaded tools through V3's
existing `projectTools` callback. V3 executes against that turn's snapshot, so
hidden tools cannot run in the same turn as the load request.

DOCX specialist groups now live below `document` (paragraphs, text, tables,
layout, rich content). Common document, workspace, and finish tools keep their
previous initial exposure. V3 remains unaware of capability structure and DOCX.
First-turn context budgeting reserves only the projected initial schemas.

`agent_capability_event` stores raw discovered, loaded, executed, succeeded,
and failed events with run, turn, capability ID, model, time, latency, and error
code. A run buffers events and writes them after settlement; write failure is
logged without changing the document outcome. Availability is derived from the
catalog and run bindings, rather than emitting one row per available item.
Instruction capabilities use the same indexed discovery and run-local load, but
carry a lazy instruction body rather than a tool name. The API projects loaded
instructions once into each subsequent model request as delimited task guidance;
the body never enters the durable transcript or the initial root prompt. Core
system rules, document targeting, permissions, and engine constraints take
precedence. The current skill is `skills.scientific-writing.scientific-paper`.
The projected instruction tokens are counted against that turn's available
input budget. Raw telemetry stores capability kind; instruction skills emit
discovered/loaded events, not tool execution events. Web/compute tools,
connectors, subagents, and rollups remain deferred.
