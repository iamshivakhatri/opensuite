# OpenSuite Engine Integration

`opensuite-engine` is a separate Rust project.

OpenSuite communicates with it only through `packages/engine-client`.

## Rule

Application code must never manipulate Office internals as a shortcut around the engine.

## Proven mutation path (local N-API)

```text
AgentRunner
  → AgentTool
  → DocumentRuntime
  → OpenSuiteEngineAdapter (@opensuite/engine-client)
  → Node N-API (@opensuite/engine)
  → Rust opensuite-engine
  → verified artifact bytes
```

* Application owns version/storage lifecycle (`DocumentRef`, `baseVersionId`, artifact loader).
* Engine owns semantic mutation, preservation, OPC verification, postconditions.
* `MockDocumentRuntime` remains the default for agent-core / API until inspect is bound.
* Native transport is hidden behind `DocxEngineBinding` — AgentRunner/tools never import N-API.
* Only `document.replace_text` → `executeDocxReplaceText` is wired initially.
* Successful mutations may return in-memory `artifactBytes`; persistence is not done inside the adapter.

### Application persistence lifecycle (ReplaceText)

```text
immutable version N
  → createOwnedDocumentArtifactLoader (exact bytes)
  → DocumentRuntime / OpenSuiteEngineAdapter
  → verified artifactBytes
  → createDocumentMutationService.applyReplaceText
  → appendDocumentVersion (new storage key + row)
  → version N+1 (only if N still latest)
```

* Engine never writes DB/storage.
* Application owns version history; `baseVersionId` concurrency is atomic in `appendDocumentVersion` (`FOR UPDATE` + latest id check).
* Runtime/engine failure → no upload / no version.
* Stale engine output after a concurrent append → `VERSION_CONFLICT` + best-effort delete of the unused object.
* Production agent runtime switch remains deferred until engine inspect/find exist.

### Local Node binding setup

Sibling checkout expected:

```text
opensuite-project/
  opensuite/
  opensuite-engine/
```

```bash
# in opensuite-engine
cd crates/opensuite-node
npm install
npm run build   # produces opensuite_node.<platform>-<arch>.node

# in opensuite
pnpm install    # optionalDependency file: link to crates/opensuite-node
```

`packages/engine-client` declares `@opensuite/engine` as an **optionalDependency** via
`file:../../../opensuite-engine/crates/opensuite-node`. Do not commit native binaries into
this repo. Smoke test writes `/private/tmp/opensuite-app-engine-adapter-output.docx` for
manual inspection only.

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

`packages/engine-client` is the concrete implementation of the boundary described above. It is built around:

* **`EngineTransport` / `EngineClient` / `MockEngineTransport`** — existing inspect-oriented transport seam (still mock-backed).
* **`OpenSuiteEngineAdapter`** — `DocumentRuntime` implementation for real DOCX `ReplaceText` via N-API.
* **`DocumentArtifactLoader`** — injected exact-version byte loader (application storage owns resolution).
* **`DocxEngineBinding` / `createNapiDocxEngineBinding`** — hides Node Buffer / N-API details.

Swapping N-API for a future remote engine service only requires a new `DocxEngineBinding` (or transport) — AgentRunner and AgentTools do not change.
