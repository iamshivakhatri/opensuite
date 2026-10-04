import { z } from "zod";
import type { WorkspaceBrandData } from "@opensuite/contracts";

const text = (max: number) => z.string().trim().max(max);
const color = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color, such as #234567")
  .transform((value) => value.toUpperCase())
  .nullable();
export const workspaceBrandSchema = z
  .object({
    schemaVersion: z.literal(1),
    organization: z
      .object({
        name: text(160).min(1, "Company name is required"),
        website: z.union([
          z.literal(""),
          z.url({ protocol: /^https?$/ }).max(500),
        ]),
        email: z.union([z.literal(""), z.email().max(254)]),
        phone: text(80),
        address: text(1000),
      })
      .strict(),
    logoAssetId: z.uuid().nullable(),
    colors: z
      .object({ primary: color, secondary: color, accent: color })
      .strict(),
    typography: z
      .object({ headingFont: text(100), bodyFont: text(100) })
      .strict(),
    document: z
      .object({
        headerText: text(2000),
        footerText: text(2000),
        showLogo: z.boolean(),
        showOrganizationName: z.boolean(),
        showPageNumbers: z.boolean(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<WorkspaceBrandData>;

export const assetMaxBytes = 2 * 1024 * 1024;
/** Accept passive raster formats only; never serve uploaded SVG/HTML as images. */
export function imageContentType(bytes: Buffer): string | null {
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    return "image/png";
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  )
    return "image/jpeg";
  if (
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}
