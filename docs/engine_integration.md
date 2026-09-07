# OpenSuite Engine Integration

`opensuite-engine` is a separate Rust project.

OpenSuite communicates with it only through `packages/engine-client`.

## Rule

Application code must never manipulate Office internals as a shortcut around the engine.

## Proven mutation path (local N-API)

```text
AgentRunner
  → AgentTool (replace_text | set_table_cells_text | insert_table_rows | insert_table_column)
  → DocumentMutationExecutor (injected by apps/api)
  → apply* (shared authorize → execute → appendDocumentVersion)
  → DocumentRuntime.execute (once)
  → OpenSuiteEngineAdapter (@opensuite/engine-client)
  → Node N-API (@opensuite/engine)
  → Rust opensuite-engine
  → verified artifact bytes → appendDocumentVersion
```

### Real DOCX agent write lifecycle

```text
Agent run starts at Version N
  → real find/inspect N
  → typed mutation tool
       → DocumentMutationExecutor (apps/api)
       → apply* (engine once + appendDocumentVersion)
       → immutable Version N+1
  → run advances active DocumentRef to N+1
  → subsequent tools read N+1
  → SSE document.version.advanced → UI reloads persisted version
```

* Raw engine `artifactBytes` success is **not** tool success — persistence must complete.
* agent-core never imports apps/api; persistence is injected.
* No engine source identities cross the tool boundary.
* VERSION_CONFLICT / TARGET_NOT_FOUND / PRECONDITION_FAILED / UNSUPPORTED_OPERATION / persistence failure → tool failed; DocumentRef unchanged.
* Multi-cell / multi-row updates are atomic **inside one engine operation**; separate tool calls remain separate versions.

### Real DOCX read+write flow (service layer)

```text
exact immutable version N
  → getDocxCapabilities (Rust RuntimeCapabilities)
  → findDocxText (mode=text)
  → inspectDocx (overview | headings | paragraphs | tables | context)
  → executeDocxReplaceText
    | executeDocxSetTableCellsText
    | executeDocxInsertTableRows
    | executeDocxInsertTableColumn
  → verified artifactBytes
  → appendDocumentVersion → N+1
  → find/inspect N+1 independently
```

* Rust is capability / semantic source of truth.
* Inspect focuses: overview, headings, paragraphs, tables, context — paged collections use offset/limit (default 20, max 100).
* Occurrence/order from inspect is VERSION-LOCAL — never persist as durable identity.
* Table inspect returns opaque artifact-local handles (table/column/row/cell). Mutations accept those
  handles alongside semantic selectors. Prefer handles for blank/duplicate targets; re-inspect after N→N+1.
* Table/cell inspect may include format-neutral `affordances[]` from Rust (capability + supported + optional reason).
  Adapter transport only — TypeScript does not recompute editability. Absence ≠ supported/unsupported.
* Application enforces version-bound structural handles (run-local registry). Stale/unknown handles never reach Rust.
* Proven blank-row path: inspect(tables) → cell handles → one atomic `set_table_cells_text` → persist N+1.
* Table workflow: inspect(tables) → set cells / insert rows / insert one column → re-inspect.
* Current engine verify for column insert still needs `headerCells` even with handles —
  app rejects handle-only column insert as `VALIDATION_FAILED` before N-API (avoids process abort).
* Limits: simple top-level rectangular tables; column insert needs explicit `w:tblGrid`; merged/nested/complex → `UNSUPPORTED_OPERATION`.
* Find `mode: "semantic"` is unsupported on the real adapter (use `text`).
* `MockDocumentRuntime` remains for isolated tests; API DOCX default is OpenSuiteEngineAdapter; PPTX/XLSX remain mock.
* Real DOCX never falls back to mock inspect semantics.
* Application owns version history; engine never writes DB/storage.

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

* **`EngineTransport` / `EngineClient` / `MockEngineTransport`** — existing contracts inspect seam (still mock-backed).
* **`DocxEngineBinding`** — hides N-API (`getDocxCapabilities`, `findDocxText`, `inspectDocx`, `executeDocxReplaceText`, `executeDocxSetTableCellsText`, `executeDocxInsertTableRows`, `executeDocxInsertTableColumn`).
* **`OpenSuiteEngineAdapter`** — real DOCX `DocumentRuntime` (caps/find/inspect/replace + table mutations).
* **`DocumentArtifactLoader`** — injected exact-version byte loader (application storage owns resolution).

Swapping N-API for a future remote engine service only requires a new `DocxEngineBinding` — AgentRunner and AgentTools do not change.
