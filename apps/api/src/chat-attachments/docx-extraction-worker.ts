import { createNapiDocxEngineBinding, type DocxInspectFocus } from "@opensuite/engine-client";
import { checkExtractionSize, type AttachmentUnit } from "./extraction.js";

process.once("message", async (input: Buffer) => {
  try {
    const binding = await createNapiDocxEngineBinding();
    const inspect = async (focus: DocxInspectFocus) => {
      const result = await binding.inspectDocx(input, { focus });
      if (!result.ok) throw new Error("Invalid DOCX");
      return result;
    };
    const units: AttachmentUnit[] = [];
    let characters = 0;
    let section: string[] = [];
    let headings: { level: number; title: string }[] = [];
    let paragraphIndex = 0;
    let tableIndex = 0;
    const limitations = ["Only main-body text and table cells are inspected. Headers, footers, notes, comments, deleted revisions, text boxes, embedded objects, images, links, and page layout are not represented. Merged and nested table relationships are not represented; row/column locations follow native cell order. No visual completeness is claimed."];
    function add(unit: AttachmentUnit) {
      units.push(unit);
      characters += unit.text.length + unit.section.join("/").length;
      checkExtractionSize(units, characters);
    }
    // Paragraph facts supply list membership; body blocks preserve paragraph/table order.
    const paragraphs = new Map<string, { index: number; list: AttachmentUnit["list"] }>();
    for (let offset = 0; ; offset += 100) {
      const page = (await inspect({ kind: "paragraphs", offset, limit: 100 })).paragraphs;
      if (!page) throw new Error("Paragraph inspection unavailable");
      for (const [index, paragraph] of page.items.entries()) if (paragraph.handle) paragraphs.set(paragraph.handle, { index: paragraph.index ?? offset + index, list: paragraph.list });
      if (!page.page.hasMore) break;
      if (offset + 100 >= 20_000) throw new Error("EXTRACTION_LIMIT");
    }
    for (let offset = 0; ; offset += 100) {
      const page = (await inspect({ kind: "body_blocks", offset, limit: 100 })).bodyBlocks;
      if (!page) throw new Error("Body inspection unavailable");
      for (const block of page.items) {
        if (block.kind === "paragraph") {
          const level = block.headingLevel ?? undefined;
          if (level) {
            headings = [...headings.filter(heading => heading.level < level), { level, title: block.text ?? "" }];
            section = headings.map(heading => heading.title);
          }
          const facts = paragraphs.get(block.handle);
          const list = facts?.list;
          paragraphIndex = (facts?.index ?? paragraphIndex) + 1;
          add({ location: `paragraph:${paragraphIndex}`, text: block.text ?? "", section: [...section], ...(level ? { headingLevel: level } : {}), ...(list ? { list } : {}) });
        } else if (block.kind === "table" && block.tableHandle) {
          tableIndex++;
          for (let rowOffset = 0; ; rowOffset += 10) {
            const table = (await inspect({ kind: "table_rows", tableHandle: block.tableHandle, rowOffset, rowLimit: 10 })).tableRows;
            if (!table) throw new Error("Table inspection unavailable");
            for (const row of table.rows) {
              for (const [column, text] of row.cells.entries()) {
                add({ location: `table:${tableIndex}/row:${row.index + 1}/column:${column + 1}`, text, section: [...section] });
              }
            }
            if (rowOffset + table.rows.length >= table.rowCount) break;
            if (!table.rows.length || rowOffset >= 20_000) throw new Error("EXTRACTION_LIMIT");
          }
        } else limitations.push(`Unrepresented body block ${offset + page.items.indexOf(block) + 1}: ${block.kind}`);
      }
      if (!page.page.hasMore) break;
      if (offset + 100 >= 20_000) throw new Error("EXTRACTION_LIMIT");
    }
    process.send?.({ content: { units, limitations: [...new Set(limitations)].slice(0, 40) } });
  } catch (error) {
    process.send?.({ code: error instanceof Error && (error.message === "EXTRACTION_LIMIT" || "code" in error && error.code === "EXTRACTION_LIMIT") ? "EXTRACTION_LIMIT" : "INVALID_DOCX" });
  }
});
