# Engine v0.1.8 Capability Reachability

_Generated from execution-backed audit against published `@opensuitehq/engine@0.1.8` with `OPENSUITE_ENGINE_PATH` unset. Evidence: `apps/api/src/__tests__/engine-capability-reachability.test.ts`._

## Summary

| Metric | Value |
| --- | --- |
| Named N-API exports | 62 |
| Native operations | 63 |
| Semantic flags | 2 |
| Inventory rows | 65 |
| Direct agent | 58 |
| Internal application | 1 |
| Composed agent | 6 |
| Executed PASS | 65 |
| Missing integration | 0 |

## Classification rules

- **Direct agent** — loadable `document.*` tool maps to the native op.
- **Composed agent** — higher-level tool/workflow reaches the op (`document.inspect` focuses, workspace image assets, semantic selectors).
- **Internal application** — authorized app workflow (`workspace.create_blank_document`); not model-facing as a raw engine op.
- Binary `insert_picture` / `replace_picture` stay hidden from the model; agents use `insert_image_asset` / `replace_image_asset`.
- OPC/package verification is application-side (`verifyDocumentUpdate`), not a native operation.
- `document.render_layout` is an optional LibreOffice adapter on top of `layout_snapshot`, not a native op.

## Operation matrix

| Operation | Kind | Category | Path | Loaded | Invoked | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `inspect` | read | Direct agent | document.inspect | yes | yes | PASS | document.inspect overview |
| `style_snapshot` | read | Direct agent | document.style_snapshot | yes | yes | PASS | document.style_snapshot |
| `inspect_notes` | read | Direct agent | document.inspect_notes | yes | yes | PASS | document.inspect_notes |
| `insert_note` | mutate | Direct agent | document.insert_note | yes | yes | PASS | mutate |
| `update_note` | mutate | Direct agent | document.update_note | yes | yes | PASS | mutate |
| `delete_note` | mutate | Direct agent | document.delete_note | yes | yes | PASS | mutate |
| `inspect_comments` | read | Direct agent | document.inspect_comments | yes | yes | PASS | document.inspect_comments |
| `inspect_fields` | read | Direct agent | document.inspect_fields | yes | yes | PASS | document.inspect_fields |
| `insert_fields` | mutate | Direct agent | document.insert_fields | yes | yes | PASS | mutate |
| `insert_toc` | mutate | Direct agent | document.insert_toc | yes | yes | PASS | mutate |
| `inspect_tracked_changes` | read | Direct agent | document.inspect_tracked_changes | yes | yes | PASS | document.inspect_tracked_changes |
| `accept_revision` | mutate | Direct agent | document.accept_revision | yes | yes | PASS | mutate |
| `reject_revision` | mutate | Direct agent | document.reject_revision | yes | yes | PASS | mutate |
| `insert_tracked_text` | mutate | Direct agent | document.insert_tracked_text | yes | yes | PASS | mutate |
| `delete_tracked_text` | mutate | Direct agent | document.delete_tracked_text | yes | yes | PASS | mutate |
| `replace_text_with_tracked_change` | mutate | Direct agent | document.replace_text_with_tracked_change | yes | yes | PASS | mutate |
| `add_comment` | mutate | Direct agent | document.add_comment | yes | yes | PASS | mutate |
| `update_comment` | mutate | Direct agent | document.update_comment | yes | yes | PASS | mutate |
| `delete_comment` | mutate | Direct agent | document.delete_comment | yes | yes | PASS | mutate |
| `replace_text` | mutate | Direct agent | document.replace_text | yes | yes | PASS | mutate + find |
| `create_blank_docx` | create | Internal application | workspace.create_blank_document → createBlankDocx | n/a | yes | PASS | workspace.create_blank_document → createBlankDocxDocument → createBlankDocx |
| `body_blocks` | read | Composed agent | document.inspect kind=body_blocks | yes | yes | PASS | document.inspect body_blocks |
| `insert_page_break` | mutate | Direct agent | document.insert_page_break | yes | yes | PASS | mutate |
| `delete_page_break` | mutate | Direct agent | document.delete_page_break | yes | yes | PASS | mutate |
| `set_page_setup` | mutate | Direct agent | document.set_page_setup | yes | yes | PASS | mutate |
| `set_header_footer_text` | mutate | Direct agent | document.set_header_footer_text | yes | yes | PASS | mutate |
| `set_page_number` | mutate | Direct agent | document.set_page_number | yes | yes | PASS | mutate |
| `inspect_sections` | read | Direct agent | document.inspect_sections | yes | yes | PASS | document.inspect_sections |
| `layout_snapshot` | read | Direct agent | document.inspect_layout | yes | yes | PASS | document.inspect_layout / readOperation |
| `insert_section_break` | mutate | Direct agent | document.insert_section_break | yes | yes | PASS | mutate |
| `set_section_properties` | mutate | Direct agent | document.set_section_properties | yes | yes | PASS | mutate |
| `set_section_header_footer` | mutate | Direct agent | document.set_section_header_footer | yes | yes | PASS | mutate |
| `set_odd_even_headers` | mutate | Direct agent | document.set_odd_even_headers | yes | yes | PASS | mutate |
| `insert_paragraph` | mutate | Direct agent | document.insert_paragraph | yes | yes | PASS | mutate |
| `insert_paragraphs` | mutate | Direct agent | document.insert_paragraphs | yes | yes | PASS | mutate |
| `delete_paragraph` | mutate | Direct agent | document.delete_paragraph | yes | yes | PASS | mutate |
| `set_content_control_text` | mutate | Direct agent | document.set_content_control_text | yes | yes | PASS | mutate + find Filled Title |
| `set_paragraph_formatting` | mutate | Direct agent | document.set_paragraph_formatting | yes | yes | PASS | mutate |
| `set_text_formatting` | mutate | Direct agent | document.set_text_formatting | yes | yes | PASS | mutate |
| `set_hyperlink` | mutate | Direct agent | document.set_hyperlink | yes | yes | PASS | mutate |
| `set_paragraph_style` | mutate | Direct agent | document.set_paragraph_style | yes | yes | PASS | mutate |
| `create_style` | mutate | Direct agent | document.create_style | yes | yes | PASS | mutate |
| `update_style` | mutate | Direct agent | document.update_style | yes | yes | PASS | mutate |
| `set_paragraphs_list` | mutate | Direct agent | document.set_paragraphs_list | yes | yes | PASS | mutate |
| `replace_picture` | mutate | Composed agent | document.replace_image_asset → replace_picture | yes | yes | PASS | document.replace_image_asset |
| `delete_picture` | mutate | Direct agent | document.delete_picture | yes | yes | PASS | mutate |
| `set_picture_size` | mutate | Direct agent | document.set_picture_size | yes | yes | PASS | mutate |
| `set_picture_layout` | mutate | Direct agent | document.set_picture_layout | yes | yes | PASS | mutate |
| `insert_picture` | mutate | Composed agent | document.insert_image_asset → insert_picture | yes | yes | PASS | document.insert_image_asset |
| `insert_table_row` | mutate | Direct agent | document.insert_table_row | yes | yes | PASS | mutate |
| `insert_table_rows` | mutate | Direct agent | document.insert_table_rows | yes | yes | PASS | mutate |
| `set_table_cells_text` | mutate | Direct agent | document.set_table_cells_text | yes | yes | PASS | semantic cell target |
| `insert_table_column` | mutate | Direct agent | document.insert_table_column | yes | yes | PASS | mutate |
| `create_table` | mutate | Direct agent | document.create_table | yes | yes | PASS | mutate on blank |
| `delete_table` | mutate | Direct agent | document.delete_table | yes | yes | PASS | mutate |
| `delete_table_row` | mutate | Direct agent | document.delete_table_row | yes | yes | PASS | semantic row deletion |
| `delete_table_column` | mutate | Direct agent | document.delete_table_column | yes | yes | PASS | mutate |
| `set_table_formatting` | mutate | Direct agent | document.set_table_formatting | yes | yes | PASS | mutate |
| `set_table_column_widths` | mutate | Direct agent | document.set_table_column_widths | yes | yes | PASS | mutate |
| `set_table_cell_shading` | mutate | Direct agent | document.set_table_cell_shading | yes | yes | PASS | mutate |
| `set_table_cells_formatting` | mutate | Direct agent | document.set_table_cells_formatting | yes | yes | PASS | mutate |
| `find_text` | read | Direct agent | document.find | yes | yes | PASS | document.find |
| `inspect_context` | read | Composed agent | document.inspect kind=context | yes | yes | PASS | document.inspect context |
| `semantic_table_cell_targets` | flag | Composed agent | semantic selectors on set_table_cells_* / set_table_cell_shading | flag | yes | PASS | used label/header selectors |
| `semantic_table_row_deletion` | flag | Composed agent | semantic label selectors on delete_table_row | flag | yes | PASS | label selector |

## Engine limitations observed (not application gaps)

- `set_page_setup` / simple header-footer page-number helpers require a single terminal main-document section.
- `set_content_control_text` accepts only unlocked, unbound text controls without placeholder state.
- Complex tracked revisions (move/property/range) are inspected with diagnostics and refused for accept/reject.
- Picture insert/replace require owned workspace PNG/JPEG assets; raw bytes are never model inputs.

## False-coverage fixes from this audit

- `bound-docx` dispatcher inventory no longer skips `insert_fields` / `insert_toc` as non-mutations.
- `set_content_control_text` now has execution-backed coverage (previously registered but unexecuted).

