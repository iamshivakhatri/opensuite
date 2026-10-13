# Phase 6 — Continue and mutation execution

## Original loss boundary

`agent-core/run.ts` appended SDK assistant response messages and ordered tool-result messages to a local transcript. Turn 19/20 had the complete active conversation, including provider-exposed reasoning parts/options. The returned result and saved `agent_step` rows did not include that transcript: steps retained narration and tool names/status only. `resolveContinuation` reconstructed tool counts and a synthetic progress prompt. `loadHistory` projected that unfinished request through normal compact prior-run history. Original attachments and loaded IDs could be restored, but tool arguments/results, observations, reasoning metadata, and failure identities could not.

## Change

Agent Core returns replayable messages, logical turn count, and failure-attempt counts only at max-turn/deadline boundaries after tool results are recorded. API stores each physical run's new message suffix in the last existing step. Later segments point to the preceding owned run; large prior observations and original system/retrieval context are stored once. No schema migration, second message store, cache service, or new editing tool.

Continue restores the original request and preceding conversation, skips completed-task history loading, and uses current capability bindings. It rechecks thread/workspace/document access and current tip, preserves the previously edited target lock, and restores saved-style evidence only for the matching saved version. Handles are historical references; a fresh native session cannot reuse them. Repeated-read reuse includes a physical-session marker, so a new inspection produces fresh handles. Old calls are context only and never execute during replay. Recovery classification combines earlier tool evidence with current calls; billing stays per physical run.

A short runtime notice supplies the current target/version and stale-handle rule. Completed requests retain ordinary compact history; diagnostic steps remain saved independently. HTTP step output omits replay state, including when it shares a validation step. Replay state must persist before advertising a resumable stop. Missing/corrupt parent data, old runs without replay state, and already-consumed runs reject Continue before model execution. Cancellation and unexpected provider failure do not become resumable tasks.

Each stored segment is capped at 8 MB; restored message chains at 32 MB. Exceeding these bounds fails safely instead of deleting unfinished observations. Existing thread/step ownership and deletion apply. Stored state contains SDK-visible messages and owned document/style data, not model configuration or credentials.

## Turn 21 acceptance

- OpenRouter test captures the actual HTTP request body after SDK/provider serialization: uninterrupted 22 turns versus 20 turns + JSON save/restore + Continue. Turn 21 bodies are deeply equal, including signed reasoning text and opaque encrypted reasoning metadata, original/prior messages, tool IDs/arguments/results, inspection evidence, mutation success, failure/recovery, and effective tool schemas.
- API test uses the real tool registry, scheduler, native DOCX operations, version saves, JSON-round-tripped steps, and a fresh execution service for Continue. Turn 21 serialized SDK request agrees after removing the new-session notice and normalizing session UUIDs. Three native mutations in both cases; saved versions are 1 uninterrupted versus 2 bounded. Reopened output verifies the changed cell, style color, bold heading, and unchanged sibling cells.
- Additional checks cover chained Continues without duplicate prefixes, no-mutation stops, saved mutations, partial batch failures with/without matching recovery, current-version changes, attached references, revoked/deleted target access, removed capabilities, original observations referenced by repeat notices, and compact history after completion. Existing cancellation, handle safety, discovery, verification, recovery, and workspace-isolation tests pass.

SDK-exposed reasoning parts/options are persisted, not invented. Provider-private state is unavailable. The installed OpenRouter adapter controls replay: for example it filters unsigned reasoning details for providers that require signatures. Cross-provider/model migration and paid live-provider behavior are not certified. Current authorized DIRECT document views may be refreshed; physical version metadata and native sessions necessarily differ at a save boundary. This does not promise byte-identical document saves or hidden provider state.

## Representative native DOCX benchmark

Generated fixture: one Heading 1 and 100 body paragraphs, with existing italic emphasis. Same requested Calibri 12-point green appearance. Direct overrides versus existing `document.update_style` for Normal and Heading1; no new bulk primitive. The system adds one short preference for native styles while retaining direct overrides for exceptions. This is a scripted workflow comparison, not a replay of the original 270.9-second live run.

| Measurement | Direct overrides | Native styles |
| --- | ---: | ---: |
| Logical model turns | 37 | 4 |
| Native mutations | 101 | 2 |
| Redundant mutation attempts | 0 | 0 |
| Tool calls | 104 | 5 |
| Generated argument bytes | 13,460 | 281 |
| Estimated model-input tokens | 724,475 | 43,596 |
| Peak serialized request bytes | 86,739 | 35,530 |
| Saved versions | 2 | 1 |
| Tool errors | 0 | 0 |
| Wording, heading assignment, emphasis | preserved | preserved |

KPI and header operations retain existing semantic-target/batch paths and regression coverage. Partial styling resumes remaining operations without repeating the successful sibling. Full transcript replay supplies exact successful-operation evidence; no tool-name/argument deduplication suppresses legitimate repeat edits or version-specific changes. Imported direct overrides may still need explicit correction; the benchmark does not establish that every imported document can be styled using only two mutations.

## Validation and scope

Local native binding; API 447 passed, 23 database/config-dependent skips. Agent Core 41 passed. Engine client 39 passed, 2 configured/optional skips. API/Core typechecks and builds passed. Rust and Cloud source were not changed. No native publication, consumer-pin update, paid call, live latency/cost claim, deployment, or push. Existing unrelated web changes were preserved. Whole-worktree whitespace checking detects pre-existing CRLF whitespace in the user's `globals.css`; changed Phase 6 files pass.
