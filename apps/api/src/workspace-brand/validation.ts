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
        website: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(500)]),
        email: z.union([z.literal(""), z.email().max(254)]),
        phone: text(80),
        address: text(1000),
      })
      .strict(),
    logoAssetId: z.uuid().nullable(),
    colors: z.object({ primary: color, secondary: color, accent: color }).strict(),
    typography: z.object({ headingFont: text(100), bodyFont: text(100) }).strict(),
  })
  .strict() satisfies z.ZodType<WorkspaceBrandData>;

export const assetMaxBytes = 2 * 1024 * 1024;
