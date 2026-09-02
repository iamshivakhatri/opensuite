# OpenSuite Engine Integration

`opensuite-engine` is a separate Rust project.

OpenSuite communicates with it only through `packages/engine-client`.

## Rule

Application code must never manipulate Office internals as a shortcut around the engine.

## Conceptual Interface

The application should eventually be able to request operations such as:

* `inspect_document`
* `get_document_structure`
* `find_content`
* `apply_operations`
* `validate_document`
* `render_pages`
* `render_slides`

Exact contracts will evolve with the engine.

Responses should favor structured data:

* `result`
* `diagnostics`
* `warnings`
* `errors`
* `affected_regions`
* `render_artifacts`
* `document_version`

The agent should reason from these structured results instead of parsing human-readable engine logs.

During early development, `engine-client` may use fixtures or a mock transport while preserving the intended interface.

## Contracts

The first cross-language contracts live in `packages/contracts/src/engine/`. So far only `inspect_document` is fully modeled (`InspectDocumentRequest` / `InspectDocumentResult`); `apply_operations`, `validate_document`, and `render_pages` will be added as their own operation contracts later, built on the same shared pieces:

* **`DocumentInput`** — a discriminated union (`kind: "inline" | "reference"`) for how the engine receives a document's bytes. `inline` carries base64 content; `reference` carries an opaque handle whose resolution is out of scope for this contract.
* **`Diagnostic`** — `{ severity, code, message, path? }`. `code` is a stable, namespaced machine-readable identifier (e.g. `engine.docx.malformed_xml`); `message` is for humans only.
* **`EngineOperationResult<TData>`** — the shared success/failure envelope every engine operation result uses, tagged on `status: "success" | "error"`. An `"error"` result must carry at least one diagnostic (enforced at the type level, not just by convention).

These types are plain, JSON-shaped TypeScript (no classes, enums-as-objects, or language-specific tricks) so they can be mirrored by Rust structs/enums with serde on the engine side once it exists.

## Client

`packages/engine-client` is the concrete implementation of the boundary described above. It is built around a small, fixed shape:

* **`EngineTransport`** — the only interface that knows how to reach the engine (currently just `inspectDocument`). Nothing else in the package, and nothing outside it, is allowed to talk to the engine directly.
* **`EngineClient`** — the application-facing entry point. It holds a single `EngineTransport` and forwards each call to it, returning the contract result unmodified. It contains no engine logic and does not depend on which transport it was given.
* **`MockEngineTransport`** — an in-memory `EngineTransport` implementation used until `opensuite-engine` and a real transport exist. It resolves a caller-configured response and records received requests for tests.

Swapping `MockEngineTransport` for a future `HttpEngineTransport` (or any other transport) only requires implementing `EngineTransport` — `EngineClient` and its callers (`agent-core`, eventually) do not change. The HTTP transport itself is intentionally not designed yet.
