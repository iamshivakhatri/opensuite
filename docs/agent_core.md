# Agent Core V3

`packages/agent-core-v3` is the active generic model/tool runtime. The API owns model resolution, persisted conversation context, document bindings, lifecycle, and product events.

```text
API resolves model + context + document tools
  → agent-core-v3 runAgent
    → generic model/tool loop
    → API persists result and document versions
```

The core has no database, HTTP, auth, storage, document semantics, checkpoints, retrieval, or compaction policy. `runModel` is its one-call primitive; `projectMessages` lets the API add first-turn request-local document context without teaching the core product rules.
