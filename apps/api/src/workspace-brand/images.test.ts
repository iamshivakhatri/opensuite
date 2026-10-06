import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { optimizeWorkspaceImage } from "./images.js";

test("large PNG logo shrinks without losing transparency and strips metadata", async () => {
  const source = await sharp({
    create: {
      width: 3200,
      height: 800,
      channels: 4,
      background: { r: 24, g: 64, b: 128, alpha: 0.5 },
    },
  })
    .withMetadata({ density: 300 })
    .png({ compressionLevel: 1 })
    .toBuffer();
  const result = await optimizeWorkspaceImage(source);
  assert.equal(result.width, 2000);
  assert.equal(result.height, 500);
  assert.equal(result.contentType, "image/png");
  assert.ok(result.bytes.length < source.length);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  const pixel = await sharp(result.bytes)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  assert.ok(Math.abs(pixel[3]! - 128) <= 1);
  console.log(
    `PNG logo: ${source.length} → ${result.bytes.length} bytes; 3200×800 → ${result.width}×${result.height}`,
  );
});

test("small PNG/WebP keep pixels and transparency; JPEG orientation is normalized", async () => {
  for (const format of ["png", "webp"] as const) {
    const source = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 0.5 },
      },
    })
      .toFormat(format, format === "webp" ? { lossless: true } : {})
      .toBuffer();
    const result = await optimizeWorkspaceImage(source);
    assert.equal(result.width, 40);
    assert.equal(result.height, 20);
    assert.deepEqual(
      await sharp(result.bytes).raw().toBuffer(),
      await sharp(source).raw().toBuffer(),
    );
  }
  const source = await sharp({
    create: { width: 60, height: 30, channels: 3, background: "#234567" },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 })
    .toBuffer();
  const result = await optimizeWorkspaceImage(source);
  assert.equal(result.width, 30);
  assert.equal(result.height, 60);
  assert.equal((await sharp(result.bytes).metadata()).exif, undefined);
});

test("invalid, truncated and SVG inputs are rejected", async () => {
  const valid = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "#234567" },
  })
    .png()
    .toBuffer();
  for (const bytes of [
    Buffer.from("not an image"),
    valid.subarray(0, 24),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    ),
  ]) {
    await assert.rejects(() => optimizeWorkspaceImage(bytes));
  }
});
