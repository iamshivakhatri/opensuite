# API capabilities

Capabilities are the API's discoverable tools and task instructions. The model sees a small root list, then loads only the tools or instructions needed for a run. A document skill describes content and evidence; a style pack describes appearance using supported DOCX tools; executable tools make the actual edits.

- `core/` defines the immutable registry and one run's available and loaded state.
- `definitions/` holds capability metadata beside standalone implementations. `built-in.ts` describes existing document, workspace, and run tools; their implementations stay in the agent files that own them.
- `catalog.ts` explicitly registers definitions and creates standalone tools.
- `runtime/` binds available tools, provides discovery tools, and projects loaded instructions into model turns.
- `telemetry/` records discovery, load, and tool use without changing run outcomes.

To add a standalone tool, put its metadata, implementation, and test under the right `definitions/` domain, then register its definition and tool constructor in `catalog.ts`. Existing document tools are bound by the document agent; add only their metadata to `definitions/built-in.ts`. To add a document skill or style pack, put its metadata and lazy instruction body in the matching `definitions/skills/` or `definitions/styles/` domain module, then add it to that folder's `index.ts`. Both are instruction capabilities with no executable schema. An instruction may name up to four executable `companionCapabilities`; Turn 1 shows only companions that are available and loadable in that run.

For example, `skills.reporting.analytical-report` plus `styles.reporting.professional` can guide a new report while existing `document.*` tools build it. A narrow update normally keeps the document's existing style.

Keep document rules, database access, and capability discovery in the API. `packages/agent-core-v3` stays a generic model and tool loop.

Personal saved styles are API product tools in `definitions/style-profiles.ts`. `execution.ts` supplies the authenticated style service and selected saved-version context; the catalog registers metadata only. They learn/retrieve explicitly requested style profiles and never apply them. See `docs/style_profiles.md`.
