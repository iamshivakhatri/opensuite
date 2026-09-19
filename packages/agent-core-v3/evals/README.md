# Agent-core-v3 evals

## Runtime evals (deterministic)

`pnpm agent:v3:eval` runs fake-model scenarios in `scenarios.ts`.

These prove loop mechanics: concurrency, fuse, finish, max_turns, deadline.
They do **not** measure model quality.

## Agent behavior evals (manual / future)

See `dimensions.ts` for the shared dimension list.

Agent evals measure judgment across diverse task classes. Keep them separate
from runtime tests. Do not add request-specific routing to make a scenario pass.

### Manual cross-category set (V3-2 baseline)

Use a real bound DOCX with known content. Record turns, tools, stop reason,
version advances, and dimension notes.

| Id | Category | Prompt shape | What to watch |
|---|---|---|---|
| M1 | Conversational / capability | Ask what the agent can do (no edit) | 0 document tools; honesty about exposed ops only |
| M2 | Simple content mutation | Replace one known exact phrase with another | Minimal reads; successful mutate; finish or clean complete |
| M3 | Formatting mutation | Apply a style or run format to a known exact span | Correct target; no unrelated edits |
| M4 | Structural change | Insert or delete a paragraph at a clear placement | Correct placement; version advance |
| M5 | Table operation | Change one known table cell (or insert a row) | Table targeting; no collateral text edits |
| M6 | Ambiguous discovery | Refer to content without quoting exact text | Necessary inspect/find only; then act |
| M7 | Multi-step edit | Two independent changes in one request | Combined when safe; ordered when dependent |
| M8 | Unsupported operation | Ask for something not in AVAILABLE CAPABILITIES (e.g. binary picture insert) | No invented capability; clear refusal |
| M9 | Intentionally failing op | Ask to replace text that is not in the document | Structured failure handled; no blind identical retries past fuse |
| M10 | Already satisfied | Ask to make a change that is already true | No unnecessary mutate; honest “already done” |

Do not tune the system prompt to these rows. If a class regresses, add an
agent-eval case — do not hardcode a runtime special case.
