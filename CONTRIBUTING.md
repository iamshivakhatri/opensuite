# Contributing to OpenSuite

Thanks for helping improve OpenSuite. The product application lives here; the lower-level Office engine lives in [`opensuite-engine`](https://github.com/opensuite/opensuite-engine).

## Project map

```text
apps/web                Next.js product interface
apps/api                Fastify API, agent binding, document services
packages/agent-core-v3  Agent loop
packages/engine-client  Only product package that calls the document engine
packages/contracts      Shared engine contracts
packages/db             PostgreSQL schema and migrations
docs/                   Public technical documentation
```

## Local development

Use the [README quick start](README.md#quick-start). The usual checks are:

```bash
pnpm test
pnpm typecheck
```

Run the smallest affected package check while developing when possible. Document and API integration tests need configured local services.

## How we make changes

- Preserve existing documents. The engine, not TypeScript, owns Office semantics and mutations.
- Keep application code thin around engine contracts. Do not parse or patch Office XML in the web app or API.
- Prefer simple, explicit code over new abstractions.
- Add or update a focused test for a document mutation, compatibility case, or regression.
- Never silently corrupt a document. Return a clear failure when a supported target cannot be resolved safely.

## Bugs and larger changes

Use a GitHub issue for reproducible bugs. Include a safe sample document only when you can share it, the exact operation, expected result, actual result, and OpenSuite/engine version.

Open an issue or discussion before starting a large feature, new document format, or architecture change. This avoids duplicate work and keeps the application and engine boundaries clear.

## Pull requests

1. Create a focused branch and make one coherent change.
2. Run the relevant tests and type checks.
3. Explain the user-facing behavior, verification, and any document-fidelity limits.
4. Do not include secrets, private documents, generated build output, or unrelated refactors.

By contributing, you agree that your contributions are available under this repository’s [MIT License](LICENSE).
