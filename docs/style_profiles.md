# Personal document style profiles (Phase 2)

The engine owns read-only DOCX facts. `packages/engine-client` exposes the typed snapshot. The API's `style-profiles/normalize.ts` turns those facts into a reusable format; `style-profiles/service.ts` authorizes document access and saves profiles. `agent-core-v3` is unchanged.

## Format and evidence

`packages/contracts/src/style-profile.ts` defines version 1. Each profile has database identity/name/timestamps, source provenance, and normalized style data: body/title/headings, paragraphs, direct-emphasis evidence, palette, lists, common table treatment, page setup, headers/footers, diagnostics, and unresolved theme references. Half-points are half a typographic point; twips are 1/1440 inch. Line spacing retains the engine's value and rule, without conversion.

Normalization has no model, time, or random inputs. It canonicalizes object keys, groups identical patterns, and uses stable tie-breaking. IDs and extraction/persistence timestamps are assigned separately when saving.

Body facts start from document defaults and the used default paragraph style. If that style is unused, a dominant non-title/non-heading style used in body paragraphs supplies the base. Effective repeated body formatting replaces individual fields only with at least two observations and a strict majority. Missing facts count against promotion. Table/header/footer paragraphs cannot set body spacing. Because run patterns lack locations, ambiguous table/body runs cannot set body typography. Used semantic Title and Heading1–9 styles supply their own hierarchy, independently of body typography.

Direct formatting is stored as a small emphasis evidence list with counts and a repeated flag; isolated red/bold runs cannot replace body defaults. Palette text colors require repeated use. Table first-row fills/bold text are structural header facts, and table/page choices retain sample counts. Multiple treatments and truncated inspection produce diagnostics. Lists are aggregated by format, marker, and indent, without storing document-local numbering IDs. Table indexes, document text, raw snapshots, and DOCX bytes are not saved.

Unknowns remain absent. Orientation is unknown when omitted; we do not fabricate portrait. Theme references and engine diagnostics survive. Table style inheritance is flagged when a named table style is present. Page/header facts describe observed declarations; they do not resolve unsupported inheritance or complex layouts.

## Ownership and provenance

`style_profile` is a personal resource owned by the authenticated user, with a cascading user foreign key, name, normalized JSON data, and timestamps. Its owner/creation index supports bounded listing. Migration: `0023_style_profiles.sql` plus the migration journal.

Learning uses `getOwnedDocument`, checks any agent workspace constraint, captures the current tip once if no version was requested, then uses `readExactVersionBytes` to authorize and load that exact version. It never reads agent working bytes or edits the source. Source data preserves document ID, version ID, workspace ID, filename, extraction timestamp, snapshot schema version, normalizer version, and source type. The style data has its own schema version.

Source IDs are immutable provenance, not live foreign keys: profiles remain personal reusable resources after source trash/purge or version-history truncation. There is no team/workspace sharing policy. Fetch/rename/delete/list always filter by authenticated owner. Another user's profile/document returns 404.

## API and agent

- `POST /api/style-profiles` — `{ documentId, versionId?, name? }`; learns and returns `profile` (201).
- `GET /api/style-profiles?limit=20&offset=0` — personal metadata summaries; limit at most 50.
- `GET /api/style-profiles/:id` — complete saved profile.
- `PATCH /api/style-profiles/:id` — `{ name }`; rename only.
- `DELETE /api/style-profiles/:id` — delete (204).

Default name: `<document filename without .docx> Style`, bounded to 160 characters. Routes use Better Auth session resolution, Zod validation, and the existing error envelope.

`style.learn_from_document`, `style.list_profiles`, and `style.get_profile` are dynamically discovered/loaded API capabilities. The learning tool is for explicit user style-learning requests only. Omitted source IDs use the selected saved version; "Learn the style from this document" binds the open document. Unsaved changes require a later run. Learning is a persistent product write but does not advance a document version. Agent results contain summaries; raw snapshot patterns never enter model context. Lists return at most ten metadata summaries to the agent. Saved profiles are not injected into every run and are not applied to document generation.

## Verification

Unit fixtures cover deterministic output, custom/default body selection, headings, repeated patterns, isolated overrides, table isolation, lists, page setup, and unresolved/partial evidence. Capability checks cover discovery, explicit load/use, compact output, and unsaved-edit rejection. The execution isolation suite checks open-document binding and service wiring without paid models.

Run the API build, then the opt-in integration test:

```sh
OPENSUITE_ENGINE_PATH=/absolute/path/opensuite-engine/crates/opensuite-node/index.js \
RUN_STYLE_PROFILE_DB_TESTS=true \
node --test apps/api/dist/style-profiles/service.integration.test.js
```

This test requires PostgreSQL schema creation rights. It creates a random isolated schema on `DATABASE_URL`, applies the entire migration chain there (substituting historical `public` schema identifiers), and drops that test schema in cleanup. It does not migrate the application schema. Each of the three repository dogfood DOCX files is learned from an explicit older version, saved, and reloaded through a fresh Node process/database pool with full structural equality. Tests check source hashes/version counts, personal CRUD, cross-user/source-workspace access, wrong version IDs, latest-tip provenance, and trashed-source rejection. Explicit extraction tests require a local engine path and fail if unavailable.

Validated real profiles:

- Blue Harbor: Arial 11 pt body; Title 20 pt and Heading1 16 pt; body spacing 160/240 twips; KPI header fill `DCE3EA`, bold header evidence, single borders, cell margins 80/120 twips, 1-inch page margins.
- Maya: Arial 11 pt body; Title/Heading1; Heading1 spacing 200/80 twips; three bullet uses with 720/360 twip left/hanging indents; isolated job-line bold retained as emphasis evidence, not body bold.
- Scientific paper: Arial 11 pt; used Heading1 and Heading2 (16/14 pt), body spacing 160/160 twips and auto line spacing 276; 1-inch margins. The actual file has no Title style usage or headers/footers, so none are invented.

Engine limitations remain: unresolved themes, incomplete table-style inheritance, numbering overrides, and bounded facts. A single structural table header can be useful evidence but is labeled with one table sample, not claimed as a universal design. No profile application, brand configuration, engine publishing, or model normalization is included.


## Phase 2 dogfood hardening

The failed dogfood run `4c2548e7-d180-49dc-a34e-634f05723d7d` called learning with `{ "name": "Blue Harbor Operating Report Style" }`. The exact error was `Select a source document or provide documentId`. The binding rule recognized “learn the style” but missed “learn the document style”; the run therefore had no selected document or base saved version. The name-only arguments were valid according to the tool schema. Explicit document-style wording now binds the open saved document before the model acts. No retry or unrelated-document fallback was added.

Completion presentation uses successful tool names/statuses, not assistant text or version-count guesses. Successful learning shows “Saved style profile”; profile list/get shows “Completed”; successful document mutations still show “Updated document”; document creation keeps “Created …”. Failed/unknown tools and capability discovery cannot imply document edits.

The exact prompt/arguments have regression coverage in document targeting, execution isolation, and an opt-in integration replay. The replay uses the real V3 loop, persisted agent runs/steps, document service, local native engine, and PostgreSQL in an isolated schema, with a scripted model. Blue Harbor learning executes once with no failures and exact current-version provenance; list/get expose the saved profile in compact model results; source hashes/version counts remain unchanged. All three original normalization and fresh-process persistence checks still pass. Live-model UI dogfood remains a manual check because paid model calls are prohibited.

Manual prompts in the existing local agent panel, with a saved Blue Harbor DOCX open:

1. “Learn the document style from this document and save it for future use.”
2. “Tell me all the styles I have saved.”
3. “Retrieve the Blue Harbor style profile you just saved.”

The web suite's default Node type-stripping command cannot resolve existing extensionless imports. The same listed tests pass using the already installed `tsx` Node loader; no dependency or unrelated import changes are needed.
