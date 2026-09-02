import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL must not be empty")
    .refine(
      (url) =>
        url.startsWith("postgresql://") || url.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection string (postgresql://...)",
    ),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be a valid URL"),
  WEB_ORIGIN: z.url("WEB_ORIGIN must be a valid URL"),
});

export interface AppConfig {
  readonly nodeEnv: "development" | "production" | "test";
  readonly host: string;
  readonly port: number;
  readonly logLevel:
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent";
  readonly databaseUrl: string;
  readonly betterAuthSecret: string;
  readonly betterAuthUrl: string;
  readonly webOrigin: string;
}

/**
 * Loads and validates process configuration from environment variables.
 * Defaults to `process.env`; accepts an explicit env object for tests.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
    databaseUrl: result.data.DATABASE_URL,
    betterAuthSecret: result.data.BETTER_AUTH_SECRET,
    betterAuthUrl: result.data.BETTER_AUTH_URL,
    webOrigin: result.data.WEB_ORIGIN,
  };
}
