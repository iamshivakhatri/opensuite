import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DocxStyleInspectionDiagnostic } from "./docx-style-snapshot.js";

const run = promisify(execFile);
export interface DocxRenderedLayout {
  ok: boolean; kind: "rendered"; provider: "libreoffice-pdf"; pageCount: number | null;
  pages: { number: number; widthPoints: number; heightPoints: number }[];
  truncated: boolean; blockPageMapping: "unavailable"; diagnostics: DocxStyleInspectionDiagnostic[];
  pdf?: Uint8Array;
}
/** Optional external applications only. No heuristic fallback or source mutation. */
export async function renderDocxLayout(bytes: Uint8Array, options: {
  sofficePath?: string; pdfinfoPath?: string; includePdf?: boolean;
} = {}): Promise<DocxRenderedLayout> {
  let folder: string | undefined;
  const result: DocxRenderedLayout = { ok: false, kind: "rendered", provider: "libreoffice-pdf", pageCount: null,
    pages: [], truncated: false, blockPageMapping: "unavailable", diagnostics: [] };
  const processOptions = { timeout: 30_000, maxBuffer: 1_048_576, env: { ...process.env, LC_ALL: "C" } };
  try {
    folder = await mkdtemp(join(tmpdir(), "opensuite-layout-"));
    const source = join(folder, "input.docx");
    const pdf = join(folder, "input.pdf");
    await writeFile(source, bytes);
    await run(options.sofficePath ?? "soffice", ["-env:UserInstallation=" + pathToFileURL(join(folder, "profile")).href,
      "--headless", "--convert-to", "pdf:writer_pdf_Export", "--outdir", folder, source], processOptions);
    const info = await run(options.pdfinfoPath ?? "pdfinfo", [pdf], processOptions);
    const count = Number(/^Pages:\s+(\d+)$/m.exec(info.stdout)?.[1]);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("PDF page count unavailable");
    const detailed = await run(options.pdfinfoPath ?? "pdfinfo", ["-f", "1", "-l", String(Math.min(count, 64)), pdf], processOptions);
    for (const match of detailed.stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
      result.pages.push({ number: Number(match[1]), widthPoints: Number(match[2]), heightPoints: Number(match[3]) });
    }
    if (result.pages.length !== Math.min(count, 64)) throw new Error("PDF page dimensions unavailable");
    result.pageCount = count; result.truncated = count > 64; result.ok = true;
    if (options.includePdf) result.pdf = new Uint8Array(await readFile(pdf));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    result.diagnostics.push({ code: missing ? "RENDERED_LAYOUT_UNAVAILABLE" : "RENDERED_LAYOUT_FAILED",
      message: missing ? "LibreOffice or pdfinfo is unavailable; no page count was estimated." : "Renderer failed or timed out; no page count was estimated." });
    result.pageCount = null; result.pages = []; result.ok = false;
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
  }
  return result;
}
