/** English Metric Units (EMU): 914,400 per inch. One dimension preserves aspect ratio. */
export interface DocxImageSize { widthEmu?: number; heightEmu?: number }
export type DocxImagePosition<R extends string> = { reference: R } & (
  { alignment: "start" | "center" | "end"; offsetEmu?: never } |
  { offsetEmu: number; alignment?: never }
);
/** Omitted fields stay unchanged on update. Floating insertion requires both axes. */
export interface DocxImageLayoutPatch {
  horizontal?: DocxImagePosition<"page" | "margin" | "column">;
  vertical?: DocxImagePosition<"page" | "margin"> | { reference: "paragraph"; offsetEmu: number; alignment?: never };
  wrap?: "square" | "topAndBottom" | "behindText" | "inFrontOfText";
  distance?: { topEmu?: number; bottomEmu?: number; leftEmu?: number; rightEmu?: number };
}
export type DocxFloatingImageLayout = DocxImageLayoutPatch & Required<Pick<DocxImageLayoutPatch, "horizontal" | "vertical">>;
export interface DocxInsertPictureOperation extends DocxImageSize {
  imageBytes: Uint8Array; placement: { kind: "start" | "end" | "before" | "after"; handle?: string };
  altText?: string; layout?: DocxFloatingImageLayout; baseRevision?: string;
}
export interface DocxSetPictureLayoutOperation { handle: string; layout: DocxImageLayoutPatch; baseRevision?: string }
export interface DocxSetPictureSizeOperation extends DocxImageSize { handle: string; baseRevision?: string }
export interface DocxReplacePictureOperation { handle: string; replacementBytes: Uint8Array; contentType: "image/png" | "image/jpeg"; baseRevision?: string }
