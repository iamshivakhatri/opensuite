# Agent Core V2

`packages/agent-core-v2` is the only agent runtime.

Phase 1 loop:

```text
API resolves model and persisted messages
  → agent-core-v2 runAgent
    → model turn (stream text)
    → if tool calls: execute all sequentially, append results, next turn
    → else: final text events
  → API persists the final message and run status
```

The core has no database, HTTP, authentication, storage, UI, or document engine.
The API owns those application concerns.

`agent-core-v2` exports `createOpenRouterModel`, `runAgent`, and `runModel`.
`runAgent` emits `started`, `text_delta`, `tool_started`, `tool_completed`,
`tool_failed`, `completed`, and `cancelled`.

Document tools are deferred to Phase 2; they must use `packages/engine-client`.
