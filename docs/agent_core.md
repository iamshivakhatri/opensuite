# Agent Core V2

`packages/agent-core-v2` is the only agent runtime.

Phase 2A loop:

```text
API binds primary DOCX version bytes
  → createDocumentTools(boundDocument)
  → agent-core-v2 runAgent (Phase-1 tool loop)
    → document.capabilities | document.inspect | document.find
    → engine-client bindDocxDocument → DocxEngineBinding → Rust
```

The core has no database, HTTP, authentication, storage, or UI.
Document tools call a server-bound read host; they never select document IDs.

Exports: `createOpenRouterModel`, `runAgent`, `runModel`, `createDocumentTools`.
Events: `started`, `text_delta`, `tool_*`, `completed`, `cancelled`.

Mutations deferred to Phase 2B.
