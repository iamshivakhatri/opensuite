import { deflateSync } from "node:zlib";

/** Temporary, valid PDFs with real text streams, an image page, labels and bookmarks. */
export function buildTestPdf(pages: (string[] | null)[], options: { title?: string; structure?: boolean; encrypted?: boolean; image?: { jpeg: Buffer; width: number; height: number } } = {}) {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => { objects.push(Buffer.from(body)); return objects.length; };
  const literal = (value: string) => `(${value.replace(/[\\()]/g, "\\$&")})`;
  const stream = (body: Buffer, extra = "") => Buffer.concat([Buffer.from(`<< /Length ${body.length} ${extra} >>\nstream\n`), body, Buffer.from("\nendstream")]);
  add(""); add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const picture = options.image;
  const image = add(stream(picture?.jpeg ?? Buffer.from([40, 120, 220]), `/Type /XObject /Subtype /Image /Width ${picture?.width ?? 1} /Height ${picture?.height ?? 1} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${picture ? "/Filter /DCTDecode" : ""}`));
  const refs = pages.map(lines => {
    const commands = lines === null ? (picture ? "q 480 0 0 288 72 350 cm /Image Do Q" : "q 200 0 0 200 72 500 cm /Image Do Q") : `BT /F1 11 Tf 16 TL 72 740 Td\n${lines.map(line => `${literal(line)} Tj T*`).join("\n")}\nET`;
    const content = add(stream(deflateSync(commands), "/Filter /FlateDecode"));
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Image ${image} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  let structure = "";
  if (options.structure) {
    const root = add("");
    const first = add(`<< /Title (Overview) /Parent ${root} 0 R /Dest [${refs[0]} 0 R /Fit] /Next ${objects.length + 2} 0 R >>`);
    const last = add(`<< /Title (Appendix numbers) /Parent ${root} 0 R /Dest [${refs.at(-1)} 0 R /Fit] /Prev ${first} 0 R >>`);
    objects[root - 1] = Buffer.from(`<< /Type /Outlines /First ${first} 0 R /Last ${last} 0 R /Count 2 >>`);
    structure = `/Outlines ${root} 0 R /PageLabels << /Nums [0 << /S /r >> 1 << /S /D /St 1 >>] >>`;
  }
  objects[0] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R ${structure} >>`);
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${refs.map(ref => `${ref} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const info = add(`<< /Producer (OpenSuite test PDF writer) ${options.title ? `/Title ${literal(options.title)}` : ""} >>`);
  // Real Standard security dictionary requiring a password; content must never be inspected.
  const encrypt = options.encrypted ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"01".repeat(32)}> /U <${"02".repeat(32)}> /P -4 >>`) : undefined;
  const chunks = [Buffer.from("%PDF-1.7\n%\xff\xff\xff\xff\n", "binary")];
  const offsets = [0];
  let position = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    position += chunk.length; chunks.push(chunk);
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R ${encrypt ? `/Encrypt ${encrypt} 0 R /ID [<0123456789abcdef> <0123456789abcdef>]` : ""} >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
