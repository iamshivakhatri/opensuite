# API capabilities

Capabilities are the API's discoverable tools and task instructions. The model sees a small root list, then loads only the tools or instructions needed for a run.

- `core/` defines the immutable registry and one run's available and loaded state.
- `definitions/` holds capability metadata beside standalone implementations. `built-in.ts` describes existing document, workspace, and run tools; their implementations stay in the agent files that own them.
- `catalog.ts` explicitly registers definitions and creates standalone tools.
- `runtime/` binds available tools, provides discovery tools, and projects loaded instructions into model turns.
- `telemetry/` records discovery, load, and tool use without changing run outcomes.

To add a standalone tool, put its metadata, implementation, and test under the right `definitions/` domain, then register its definition and tool constructor in `catalog.ts`. Existing document tools are bound by the document agent; add only their metadata to `definitions/built-in.ts`. To add an instruction skill, put its metadata and lazy instruction body together under `definitions/skills/`, then register the definition in `catalog.ts`. A skill has no executable tool or schema.

Keep document rules, database access, and capability discovery in the API. `packages/agent-core-v3` stays a generic model and tool loop.
