# Agent Core V2

`packages/agent-core-v2` is the only agent runtime.

Phase 2B loop:

```text
API binds primary DOCX version bytes + persist callback
  → createDocumentTools(boundDocument)  # reads + capability-gated mutations
  → agent-core-v2 runAgent (Phase-1 tool loop + turn/tool logs)
    → document.* tools
    → engine-client bindDocxDocument → DocxEngineBinding → Rust
    → on write success: appendDocumentVersion → host advances bytes/version
```

The core has no database, HTTP, authentication, storage, or UI.
Document tools call a server-bound host; they never select document IDs.

Exports: `createOpenRouterModel`, `runAgent`, `runModel`, `createDocumentTools`, `isDocumentWriteTool`.
Events: `started`, `text_delta`, `tool_*`, `completed`, `cancelled`.
Backend logs: `turn_start` / `turn_done` / `tool_start` / `tool_done` / `run_done`.
