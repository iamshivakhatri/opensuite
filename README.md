# OpenSuite

**An open-source AI workspace for editing real Word documents.**

OpenSuite helps an AI agent work on an existing `.docx` file instead of treating it as plain text. It inspects the document, uses typed document operations for targeted changes, and saves each change as a new version.

> **Alpha:** DOCX is the current focus. PPTX and XLSX files can be stored, but their editing surfaces are not connected yet.

**[Quick start](#quick-start)** · **[Architecture](docs/architecture.md)** · **[Roadmap](docs/roadmap.md)** · **[Contributing](CONTRIBUTING.md)**

## Why OpenSuite?

Writing text with an LLM is easy. Changing a real Office document safely is different: the system needs to understand an existing artifact, preserve what it does not change, target the intended content, and produce a compatible file.

OpenSuite pairs an agent runtime with a document engine. The agent decides what to inspect or change; the engine performs the supported DOCX operation and returns a new file. The application keeps the workspace, document history, and agent run around that work.

## What works today

- Upload, create, edit, download, and version DOCX documents in workspaces.
- Ask the agent to inspect document structure and make supported targeted edits.
- Work with text, paragraphs, basic formatting, tables, and selected DOCX structure through typed engine operations.
- Use your own OpenAI, Anthropic, or OpenRouter key in the app, or configure a server-managed provider.
- Run the TypeScript application and its Node-native document engine locally or on your own infrastructure.

The product is early-stage. DOCX fidelity varies with the source document and the operation; test important files before relying on the result. PPTX and XLSX editing, broader Office fidelity, and agent reliability work are planned, not available today.

## Example tasks

- “Make the work-experience section shorter without changing the rest of the formatting.”
- “Update the Q3 values in this table and keep the existing layout.”
- “Add a section after ‘Scope’ and match the surrounding paragraph style.”
- “Find inconsistent paragraph formatting in this document and fix the supported cases.”
- “Create a copy of this document, then revise the summary in the copy.”

## How it works

```text
You
 ↓
OpenSuite agent
 ↓
Typed document operation
 ↓
OpenSuite Engine
 ↓
Updated DOCX + a new document version
```

The agent does not edit OOXML directly. [`opensuite-engine`](https://github.com/opensuite/opensuite-engine) is the lower-level Rust engine that parses DOCX files, resolves supported targets, performs deterministic mutations, and returns diagnostics. The OpenSuite application owns user accounts, workspaces, storage, document versions, and the agent experience.

For the product boundary, see [the architecture guide](docs/architecture.md). For the DOCX integration details, see [the engine integration guide](docs/engine_integration.md).

## Quick start

OpenSuite currently needs services you provide: PostgreSQL, S3-compatible object storage, and a Resend API key for account email. There is no one-command local stack yet.

```bash
git clone https://github.com/iamshivakhatri/opensuite.git
cd opensuite
pnpm install
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
```

Fill the required values in `.env`: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, and the `S3_*` values. For local development, keep the URLs from the example file and set `AGENT_MODEL_PROVIDER=fake` for a deterministic local agent, or configure OpenAI, Anthropic, or OpenRouter.

```bash
pnpm db:migrate
pnpm dev
```

Open the web app at `http://localhost:3001`. The API runs at `http://localhost:3000`.

Requirements: Node.js 20+, pnpm 11, PostgreSQL, S3-compatible storage, and the environment values above. See [deployment notes](docs/deploy.md) for the current hosted setup.

## AI providers and BYOK

In **Settings → AI models**, users can connect their own OpenAI, Anthropic, or OpenRouter key and select a model. Self-host operators can also configure a server-managed provider through environment variables. Keep production keys and the optional `AI_CREDENTIAL_ENCRYPTION_KEY` out of source control.

## Open source and OpenSuite Cloud

This repository contains the OpenSuite application: the web app, API, workspaces, document storage and versions, agent runtime, BYOK flow, and the client for the document engine. The engine is developed separately in [`opensuite-engine`](https://github.com/opensuite/opensuite-engine).

OpenSuite Cloud is the hosted option for people who do not want to operate the application and its infrastructure themselves. It adds hosted operations and managed AI/usage services; it is not a reduced version of the self-hosted product.

## Status and roadmap

OpenSuite is under active development. Current work centers on reliable DOCX operations and the surrounding workspace experience. See [the roadmap](docs/roadmap.md) for current, next, and later directions without delivery promises.

## Visuals

There is no product screenshot or demo in this repository yet. The first launch asset should be a short, real recording of an existing DOCX being inspected, changed, and downloaded. [Capture guidance](docs/media/README.md) explains what to add; no synthetic product imagery is used here.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), especially the preservation-first rules for document changes.

## Security

Please do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

OpenSuite is available under the [MIT License](LICENSE).
