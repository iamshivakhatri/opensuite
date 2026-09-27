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