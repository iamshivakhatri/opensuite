# Engine version upgrade (application side)

Use this after `@opensuitehq/engine` is **published** to npm (see the engine repo’s `docs/releasing.md`).

This is the consumer checklist for the **`opensuite`** app repo. It does **not** publish the engine.

Related:

- Architecture / loading: `docs/engine_integration.md`
- Deploy image notes: `docs/deploy.md`
- Agent summary: `AGENTS.md` (Verification → engine upgrade bullet)

Substitute `NEW` for the published version (example: `0.1.5`) and `OLD` for the previous pin (example: `0.1.4`).

---

## Goals

1. Make `NEW` the canonical released engine everywhere the app installs/runs it.
2. Prove runtime uses the **published package**, not a local `opensuite-engine` checkout.
3. Keep `OPENSUITE_ENGINE_PATH` as an **optional** local-dev override only.
4. Ensure `packages/engine-client` bridges intended new N-API surface (thin typed wrappers — no DOCX logic in TS).
5. Do **not** modify/republish `opensuite-engine`, push, or deploy production in the bump PR unless asked.

---

## Topology (do not assume)

| Question | Current answer |
|---|---|
| Who depends on `@opensuitehq/engine`? | **Only** `packages/engine-client` (exact version). |
| Do apps import the engine? | **No.** `apps/api` uses `@opensuite/engine-client`. |
| Does `opensuite-cloud` pin the engine? | **No.** It links/fetches public OpenSuite; engine version follows public `engine-client` + lockfile. |
| Catalog / pnpm override for engine? | **No.** Only `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. |
| Docker local artifact? | **No.** Image installs from npm via frozen lockfile (glibc bookworm). |
| `OPENSUITE_ENGINE_PATH`? | Optional local override. Production and normal local must work **without** it. |

Search before editing:

```bash
rg -n '@opensuitehq/engine|OPENSUITE_ENGINE_PATH|0\.1\.\d+' \
  --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!pnpm-lock.yaml'
```

Classify hits: **must update** (active pin/ops) vs **historical** (changelogs, version-floor fallbacks, old fixtures) vs **leave** (unrelated packages like `@huggingface/tokenizers@0.1.3`).

---

## 1. Bump pins and install

Update in the **same** change:

| Location | What to change |
|---|---|
| `packages/engine-client/package.json` | `"@opensuitehq/engine": "NEW"` (exact) |
| `pnpm-workspace.yaml` → `minimumReleaseAgeExclude` | Add `NEW` for `@opensuitehq/engine` **and** all five platform packages (`darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, `win32-x64-msvc`). Keep older versions in the `\|\|` list. |
| `pnpm-lock.yaml` | Regenerate with `pnpm install` |

**Lockfile must include Linux optional packages** even when generated on macOS:

- `@opensuitehq/engine-linux-x64-gnu@NEW`
- `@opensuitehq/engine-linux-arm64-gnu@NEW`

If a macOS install omits them, fix the lockfile before merging (Docker will need them).

Also update **operational** version strings (not historical diary entries):

| Location | Typical content |
|---|---|
| `Dockerfile` | Comment: `@opensuitehq/engine@NEW from npm` |
| `docker-compose.atlas.yml` | Engine comment |
| `docs/deploy.md` | Image / install pin lines |
| `docs/engine_integration.md` | Install / exact-dep lines |
| `docs/status.md` | Current pin line(s) that state the npm version |
| `docs/style_profiles.md` | Only if it still tells people to install `OLD` |
| `.env.example` | Comment that normal usage is npm `NEW`; override optional |
| `packages/engine-client/src/docx-engine-binding.ts` | Error strings that say `pin/install @opensuitehq/engine@OLD` |
| Tests that assert `engineVersion === "OLD"` | e.g. `bound-docx.test.ts`, `execution.version.test.ts`, `architecture-boundary.test.ts` |

Do **not** rewrite historical changelogs or version-floor comments that intentionally say “≥ OLD” for compatibility.

---

## 2. Local override hygiene

Desired behavior:

```text
unset OPENSUITE_ENGINE_PATH
  → require("@opensuitehq/engine") @ NEW + host native optional dep

OPENSUITE_ENGINE_PATH=/abs/path/to/opensuite-node/index.js
  → load that path only; missing/unloadable → fail fast (no npm fallback)
```

For acceptance and CI-like checks: **unset** `OPENSUITE_ENGINE_PATH` (and comment it out in gitignored `.env` if it would be reloaded by `load-env`).

Boot log should show `source=npm` when unset (`apps/api/src/runtime.ts`).

---

## 3. Verify the published package (host)

With override unset:

```bash
unset OPENSUITE_ENGINE_PATH
pnpm install
pnpm --filter @opensuite/engine-client exec node -e '
const { createRequire } = require("module");
const r = createRequire(require.resolve("@opensuitehq/engine/package.json"));
const pkg = require("@opensuitehq/engine/package.json");
const eng = require("@opensuitehq/engine");
const caps = eng.getDocxCapabilities();
console.log({
  packageVersion: pkg.version,
  engineVersion: caps.engineVersion,
  resolved: require.resolve("@opensuitehq/engine"),
  isLocalCheckout: require.resolve("@opensuitehq/engine").includes("opensuite-engine"),
});
'
```

Expect: `packageVersion`/`engineVersion` = `NEW`, path under `node_modules/.pnpm/@opensuitehq+engine@NEW/...`, `isLocalCheckout: false`.

Then:

```bash
pnpm --filter @opensuite/engine-client style-smoke
```

---

## 4. Engine → engine-client completeness

Compare **published** N-API (`getDocxCapabilities()` + `index.d.ts` / require surface) against `packages/engine-client`.

| If… | Then… |
|---|---|
| New capability family with no typed module / binding method / dispatch | Add the **smallest** thin wrapper (no DOCX logic in TS). |
| Inspect-only id (e.g. `inspect_*`) | Usually **not** a mutation dispatcher; add to non-mutation allowlists in tests if needed. |
| Binary picture insert/replace | Keep dispatchable but **hidden** from model schemas (`HIDDEN_BINARY_MUTATION_CAPABILITIES`). |
| Product workflow already covered by one wrapper | Do **not** add duplicate tools. |
| Internal/unsafe helper | Leave hidden. |

Capability groups live under `apps/api/src/agent/capabilities/definitions/built-in.ts` (lazy groups such as `document.notes`, `document.revisions`, …). Prefer existing groups; do not expand the root tool surface without reason.

Architecture rules:

- Only `engine-client` may depend on `@opensuitehq/engine`.
- `agent-core-v3` stays product-agnostic (no engine import).
- DOCX semantics stay in Rust.

---

## 5. Focused acceptance (mandatory: no local override)

```bash
unset OPENSUITE_ENGINE_PATH

# Unit / bridge
pnpm --filter @opensuite/engine-client test
pnpm --filter @opensuite/engine-client typecheck
pnpm --filter @opensuite/api typecheck

# Representative API tests that touch the live binding
pnpm --filter @opensuite/api build
node --test \
  apps/api/dist/agent/execution.version.test.js \
  apps/api/dist/document-appearance/resolve.test.js \
  apps/api/dist/style-profiles/application.test.js
```

Optional / env-gated:

| Check | How |
|---|---|
| Style snapshot smoke | `pnpm --filter @opensuite/engine-client style-smoke` |
| Field refresh (LibreOffice) | Prefer **Docker** (below). Host: `OPENSUITE_FIELD_REFRESH_SMOKE=1` on `docx-field-refresh` test — host soffice can be flaky. |
| Style profile DB integration | `RUN_STYLE_PROFILE_DB_TESTS=true` + Postgres (see `docs/style_profiles.md`) |

Do **not** run paid model dogfood for a version bump.

### Representative DOCX smoke (ad hoc)

Through engine-client against npm `NEW`, exercise a small mix of old + new surface, e.g.:

- create/open → inspect → text mutate → reopen  
- paragraph formatting / custom style  
- table mutate  
- section inspect or break  
- comment and/or tracked replace  
- footnote/endnote if advertised  
- TOC / fields insert if advertised  

Assert resolved module is npm, not `../opensuite-engine`.

### Dynamic tools (no model call)

Inspect `createPrimaryDocxTools` / capability definitions:

- Supported workflows discoverable (notes, revisions, sections, styles, fields, … as applicable).
- No `insert_picture` / `replace_picture` in model schemas.
- Image product path remains `workspace_asset` id → app resolver → bytes → client.

---

## 6. Docker / Linux (required before deploy)

```bash
unset OPENSUITE_ENGINE_PATH
docker build -t opensuite-api:engine-NEW .

# Override entrypoint so migrate is skipped
docker run --rm --entrypoint node opensuite-api:engine-NEW --input-type=module -e '
import { createRequire } from "node:module";
import { createNapiDocxEngineBinding } from "./packages/engine-client/dist/index.js";
const require = createRequire(new URL("./packages/engine-client/dist/index.js", import.meta.url));
const pkg = require("@opensuitehq/engine/package.json");
const binding = await createNapiDocxEngineBinding();
const caps = binding.getDocxCapabilities();
const out = await binding.executeDocxInsertParagraph(binding.createBlankDocx(), {
  text: "linux smoke", placement: { kind: "end" },
});
const inspected = await binding.inspectDocx(out.output, { focus: { kind: "paragraphs", limit: 5 } });
console.log({
  packageVersion: pkg.version,
  engineVersion: caps.engineVersion,
  text: inspected.paragraphs?.items?.[0]?.text,
  resolved: require.resolve("@opensuitehq/engine"),
});
'
```

Expect: `NEW`, Linux path under `/app/node_modules/.pnpm/...`, inspect text `linux smoke`.

Dockerfile build already runs an engine-load check. Image must have LibreOffice Writer for field refresh (`soffice` in runtime stage). Confirm with a TOC/PAGE refresh smoke inside the container when touching fields.

Do **not** deploy production in the bump task unless explicitly requested.

---

## 7. `opensuite-cloud` (private)

Inspect first; usually **no commit**.

- No direct `@opensuitehq/engine` pin in cloud lockfile.
- After public lands on `NEW`, rebuild/redeploy cloud against the updated public ref (`OPENSUITE_REF`).
- Local cloud `.env` may still set `OPENSUITE_ENGINE_PATH` — unset for package acceptance.

Only bump cloud if reconnaissance finds an explicit stale pin or broken install assumption.

---

## 8. Final searches

```bash
# Active OLD pin should be gone from package.json / lock / Dockerfile / deploy docs
rg -n 'OLD' packages/engine-client/package.json Dockerfile docker-compose.atlas.yml docs/deploy.md

# Remaining OLD mentions should be historical / compatibility only
rg -n '@opensuitehq/engine@OLD|"OLD"' --glob '!**/node_modules/**'

rg -n 'OPENSUITE_ENGINE_PATH' --glob '!**/node_modules/**' --glob '!**/dist/**'
```

`git diff --check`

---

## 9. Commit

Public `opensuite` (after checks pass):

```text
chore: adopt engine NEW
```

Private cloud: only if something actually changed — same message. Do not create an empty commit. Do not push unless asked.

Preserve unrelated worktree changes.

---

## Pass criteria (short)

- [ ] Active app pin is `NEW`; lockfile has Linux gnu optionals  
- [ ] `minimumReleaseAgeExclude` includes `NEW` for engine + platforms  
- [ ] Ops docs / Dockerfile comments state `NEW`  
- [ ] Unset override → npm `NEW` loads on host  
- [ ] engine-client tests + typechecks pass  
- [ ] No accidental engine-client gaps for intended new surface  
- [ ] Binary image ops stay off model schemas  
- [ ] Docker Linux load + basic mutate/inspect pass  
- [ ] Field refresh still application-side (LibreOffice); works in API image if applicable  
- [ ] Cloud unchanged unless necessary  
- [ ] Engine repo untouched; nothing deployed unless asked  

---

## Out of scope for a version bump

- Publishing / modifying `opensuite-engine`
- New DOCX engine features
- Capability registry redesign / root-tool explosion
- Paid model dogfood
- Production deploy (unless the task explicitly includes it)
