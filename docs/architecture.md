# OpenSuite architecture

OpenSuite has two public repositories with a deliberate boundary.

```text
OpenSuite web
     ↓
OpenSuite API
     ↓
Agent runtime
     ↓
Engine client
     ↓
opensuite-engine
```

## Application repository

This repository owns the Next.js web app, Fastify API, authentication, PostgreSQL data, object storage, workspaces, documents, immutable document versions, agent threads, and agent runs.

The API binds a user’s current DOCX version to the agent. When the agent requests a supported document operation, the API calls `packages/engine-client`, persists the returned bytes as the next immutable version, and updates the workspace view. The application does not parse or edit Office XML itself.

```text
workspace
  └─ document
       └─ immutable versions

workspace
  └─ agent thread
       └─ messages and runs
```

## Document engine

[`opensuite-engine`](https://github.com/opensuite/opensuite-engine) is the independent Rust document engine. It owns Office parsing, supported document semantics, target resolution, mutation, diagnostics, and serialization. Its source-aware approach aims to leave unsupported and untouched parts alone.

`packages/engine-client` is the only application package permitted to communicate with the engine. This keeps document behavior deterministic and testable rather than spreading Office logic through the web app and API.

## Formats

DOCX is the connected editing path today. PPTX and XLSX can be stored in the workspace, but their editors and agent operations are not connected yet.

## Open source and Cloud

The application and engine are public, self-hostable components. OpenSuite Cloud is a separate hosted service that operates the same application layer and provides managed AI, usage, and infrastructure services. Private Cloud implementation details do not belong in this repository.

## More detail

- [Engine integration](engine_integration.md) documents the DOCX operation boundary.
- [Deployment](deploy.md) documents the current application deployment path.
- [Status](status.md) is a maintainer handoff of implementation details and may change more often than this document.
