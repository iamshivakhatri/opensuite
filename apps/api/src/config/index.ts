import { z } from "zod";

const AgentModelProviderSchema = z.enum([
  "unconfigured",
  "fake",
  "anthropic",
  "openai",
  "openrouter",
]);

const EnvSchema = z
  .object({
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
    RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY must not be empty"),
    EMAIL_FROM: z
      .string()
      .min(1, "EMAIL_FROM must not be empty")
      .refine(
        (value) => value.includes("@"),
        "EMAIL_FROM must contain an email address, e.g. \"OpenSuite <noreply@example.com>\"",
      ),
    S3_ENDPOINT: z.url("S3_ENDPOINT must be a valid URL"),
    S3_ACCESS_KEY_ID: z.string().min(1, "S3_ACCESS_KEY_ID must not be empty"),
    S3_SECRET_ACCESS_KEY: z
      .string()
      .min(1, "S3_SECRET_ACCESS_KEY must not be empty"),
    S3_BUCKET: z.string().min(1, "S3_BUCKET must not be empty"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    AGENT_MODEL_PROVIDER: AgentModelProviderSchema.default("unconfigured"),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-5"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-4.1"),
    OPENROUTER_API_KEY: z.string().optional(),
    /** Required when provider=openrouter — no default; pick an explicit model slug. */
    OPENROUTER_MODEL: z.string().optional(),
    /** 32-byte base64 or 64-character hex key, used only for BYOK secrets. */
    AI_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
    MANAGED_AI_TRIAL_CREDIT_MICROS: z.coerce.number().int().nonnegative().default(0),
    USER_STORAGE_QUOTA_BYTES: z.coerce.number().int().nonnegative().default(500 * 1024 * 1024),
  })
  .superRefine((data, ctx) => {
    if (data.AGENT_MODEL_PROVIDER === "fake" && data.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["AGENT_MODEL_PROVIDER"],
        message:
          "AGENT_MODEL_PROVIDER=fake is not allowed when NODE_ENV=production",
      });
    }

    if (data.AGENT_MODEL_PROVIDER === "anthropic") {
      if (!(data.ANTHROPIC_API_KEY?.trim() ?? "")) {
        ctx.addIssue({
          code: "custom",
          path: ["ANTHROPIC_API_KEY"],
          message:
            "ANTHROPIC_API_KEY is required when AGENT_MODEL_PROVIDER=anthropic",
        });
      }
    }

    if (data.AGENT_MODEL_PROVIDER === "openai") {
      if (!(data.OPENAI_API_KEY?.trim() ?? "")) {
        ctx.addIssue({
          code: "custom",
          path: ["OPENAI_API_KEY"],
          message:
            "OPENAI_API_KEY is required when AGENT_MODEL_PROVIDER=openai",
        });
      }
    }

    if (data.AGENT_MODEL_PROVIDER === "openrouter") {
      if (!(data.OPENROUTER_API_KEY?.trim() ?? "")) {
        ctx.addIssue({
          code: "custom",
          path: ["OPENROUTER_API_KEY"],
          message:
            "OPENROUTER_API_KEY is required when AGENT_MODEL_PROVIDER=openrouter",
        });
      }
      if (!(data.OPENROUTER_MODEL?.trim() ?? "")) {
        ctx.addIssue({
          code: "custom",
          path: ["OPENROUTER_MODEL"],
          message:
            "OPENROUTER_MODEL is required when AGENT_MODEL_PROVIDER=openrouter (e.g. meta-llama/llama-3.3-70b-instruct)",
        });
      }
    }
  });

export type AgentModelProvider = z.infer<typeof AgentModelProviderSchema>;

export interface S3Config {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
}

export interface AgentModelConfig {
  readonly provider: AgentModelProvider;
  readonly anthropicApiKey: string | null;
  readonly anthropicModel: string;
  readonly openaiApiKey: string | null;
  readonly openaiModel: string;
  readonly openrouterApiKey: string | null;
  readonly openrouterModel: string | null;
}

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
  readonly resendApiKey: string;
  readonly emailFrom: string;
  readonly s3: S3Config;
  readonly uploadMaxBytes: number;
  readonly aiCredentialEncryptionKey: string | null;
  readonly managedAiTrialCreditMicros: number;
  readonly userStorageQuotaBytes: number;
  readonly agent: AgentModelConfig;
}

/**
 * Maps legacy `MINIO_*` variables onto the application-facing `S3_*` names
 * so open-source code stays provider-agnostic while existing local `.env`
 * files keep working.
 */
function normalizeStorageEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    S3_ENDPOINT: env.S3_ENDPOINT ?? env.MINIO_ENDPOINT,
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID ?? env.MINIO_ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY ?? env.MINIO_SECRET_KEY,
    S3_BUCKET: env.S3_BUCKET ?? env.MINIO_BUCKET,
    S3_REGION: env.S3_REGION ?? "us-east-1",
    S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE ?? "true",
  };
}

/**
 * Loads and validates process configuration from environment variables.
 * Defaults to `process.env`; accepts an explicit env object for tests.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = EnvSchema.safeParse(normalizeStorageEnv(env));

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const provider = result.data.AGENT_MODEL_PROVIDER;
  const anthropicKey = result.data.ANTHROPIC_API_KEY?.trim() || null;
  const openaiKey = result.data.OPENAI_API_KEY?.trim() || null;
  const openrouterKey = result.data.OPENROUTER_API_KEY?.trim() || null;
  const openrouterModel = result.data.OPENROUTER_MODEL?.trim() || null;

  return {
    nodeEnv: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
    databaseUrl: result.data.DATABASE_URL,
    betterAuthSecret: result.data.BETTER_AUTH_SECRET,
    betterAuthUrl: result.data.BETTER_AUTH_URL,
    webOrigin: result.data.WEB_ORIGIN,
    resendApiKey: result.data.RESEND_API_KEY,
    emailFrom: result.data.EMAIL_FROM,
    s3: {
      endpoint: result.data.S3_ENDPOINT,
      accessKeyId: result.data.S3_ACCESS_KEY_ID,
      secretAccessKey: result.data.S3_SECRET_ACCESS_KEY,
      bucket: result.data.S3_BUCKET,
      region: result.data.S3_REGION,
      forcePathStyle: result.data.S3_FORCE_PATH_STYLE,
    },
    uploadMaxBytes: result.data.UPLOAD_MAX_BYTES,
    aiCredentialEncryptionKey:
      result.data.AI_CREDENTIAL_ENCRYPTION_KEY?.trim() || null,
    managedAiTrialCreditMicros: result.data.MANAGED_AI_TRIAL_CREDIT_MICROS,
    userStorageQuotaBytes: result.data.USER_STORAGE_QUOTA_BYTES,
    agent: {
      provider,
      anthropicApiKey: provider === "anthropic" ? anthropicKey : null,
      anthropicModel: result.data.ANTHROPIC_MODEL,
      openaiApiKey: provider === "openai" ? openaiKey : null,
      openaiModel: result.data.OPENAI_MODEL,
      // Always surface OpenRouter key when present — managed gateway + catalog.
      openrouterApiKey: openrouterKey,
      openrouterModel: provider === "openrouter" ? openrouterModel : null,
    },
  };
}
