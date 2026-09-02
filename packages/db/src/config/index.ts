import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL must not be empty")
    .refine(
      (url) =>
        url.startsWith("postgresql://") || url.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection string (postgresql://...)",
    ),
});

export interface DatabaseConfig {
  readonly databaseUrl: string;
}

/**
 * Loads and validates database configuration from environment variables.
 * Accepts an explicit env object for tests; defaults to `process.env`.
 *
 * Throws a single descriptive error if DATABASE_URL is missing or invalid,
 * so misconfiguration fails loudly at startup rather than at query time.
 */
export function loadDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid database configuration: ${issues}`);
  }

  return { databaseUrl: result.data.DATABASE_URL };
}
