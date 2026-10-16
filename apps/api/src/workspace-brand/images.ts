import sharp from "sharp";

export const workspaceLogoMaxWidthEmu = 1_371_600; // 1.5 inches
export const workspaceLogoMaxHeightEmu = 457_200; // 0.5 inches
export const workspaceLogoAltText = 'Workspace brand logo';

/** Fit the image inside a small brand mark without stretching or enlarging it. */
export async function workspaceLogoSize(bytes: Uint8Array, requested: { widthEmu?: number; heightEmu?: number } = {}) {
  const { width, height } = await sharp(Buffer.from(bytes), { limitInputPixels: 40_000_000 }).metadata();
  if (!width || !height) throw new Error('Could not read workspace logo dimensions');
  const widthEmu = width * 9525;
  const heightEmu = height * 9525;
  const scale = Math.min(1, workspaceLogoMaxWidthEmu / widthEmu, workspaceLogoMaxHeightEmu / heightEmu,
    (requested.widthEmu ?? Infinity) / widthEmu, (requested.heightEmu ?? Infinity) / heightEmu);
  return { widthEmu: Math.max(1, Math.floor(widthEmu * scale)), heightEmu: Math.max(1, Math.floor(heightEmu * scale)) };
}

/** Raster logos retain their format and transparency; small images are never enlarged. */
export async function optimizeWorkspaceImage(bytes: Buffer) {
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
  const metadata = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
    throw new Error("Use a static PNG, JPEG, or WebP image");
  }
  image.autoOrient().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true });
  // Sharp strips metadata by default. PNG/WebP are lossless; JPEG keeps high fidelity.
  if (metadata.format === "png") image.png({ compressionLevel: 9 });
  else if (metadata.format === "jpeg") image.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
  else image.webp({ lossless: true, effort: 6 });
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    contentType: `image/${info.format}`,
    width: info.width,
    height: info.height,
    originalSizeBytes: bytes.length,
  };
}
