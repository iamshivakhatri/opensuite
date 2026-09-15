# Agent Core V2

`packages/agent-core-v2` is the only agent runtime.

For Phase 0 it deliberately does one streamed model call:

```text
API resolves model and persisted messages
  → agent-core-v2 runAgent
  → streamed text events
  → API persists the final message and run status
```

The core has no database, HTTP, authentication, storage, UI, document engine,
tools, retry loop, recovery flow, document context system, or provider-specific
application logic. The API owns those application concerns.

`agent-core-v2` exports `createOpenRouterModel`, `runAgent`, and `runModel`.
`runAgent` emits only `started`, `text_delta`, `completed`, and `cancelled`.

Document inspection and typed mutations are deferred until Phase 1. When added,
they must use `packages/engine-client`; the core must not access Office internals
directly.
