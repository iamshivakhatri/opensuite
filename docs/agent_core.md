# OpenSuite Agent Core

OpenSuite Agent Core is the model-runtime and tool-orchestration layer.

It is inspired heavily by Pi Agent Core, but should be specialized for document work.

Implemented in `packages/agent-core`.

## Responsibilities

Agent Core owns:

* model interaction
* conversation execution
* agent state
* tool selection
* tool execution lifecycle
* streaming events
* context transformation
* retries
* interruption/cancellation
* reasoning over structured tool results

Agent Core does NOT own:

* authentication
* database persistence
* storage
* document internals
* Office XML
* product UI

## Target Execution Loop

```text
intent
 ↓
inspect
 ↓
reason
 ↓
plan
 ↓
typed engine operation
 ↓
diagnostics
 ↓
render
 ↓
visual inspection
 ↓
correct if needed
 ↓
complete
```

## Pi Agent Core Direction

Reuse/adapt concepts such as:

* small agent loop
* tool abstraction
* streamed events
* context transformation
* tool lifecycle hooks
* cancellation
* steering/follow-up concepts
* model/provider abstraction where useful

Do not blindly clone Pi's complete architecture.

Reject concepts intended specifically for coding agents when they do not serve document workflows.

OpenSuite tools should expose document capabilities rather than arbitrary machine capabilities.
