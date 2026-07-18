import { z } from "zod";

/**
 * Platform configuration.
 *
 * Secrets and infrastructure settings come from environment variables
 * (local `.env`, or secret managers injected as env in production).
 * Business/org policy lives in PostgreSQL, not here.
 */
export const autonomyLevelSchema = z.enum([
  "recommend",
  "confirm",
  "guarded_auto",
  "full_autonomous",
]);

export const aiProviderSchema = z.enum(["none", "openai", "openai_compatible", "ollama", "nvidia_nim"]);

export const appConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(3001),
  publicApiUrl: z.string().url().default("http://localhost:3001"),
  webOrigin: z.string().url().default("http://localhost:3000"),

  /** Required for all non-memory operation. */
  databaseUrl: z.string().min(1),
  redisUrl: z.string().optional(),

  /** Region label for multi-region deployments (routing/affinity). */
  region: z.string().min(1).default("local"),
  /** Optional list of known regions for marketplace/geo features. */
  regions: z
    .string()
    .default("local")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),

  defaultAutonomy: autonomyLevelSchema.default("confirm"),
  /** When true, full autonomous may be selected; UI must show legal warning. */
  allowFullAutonomous: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  bootstrap: z.object({
    enabled: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    orgName: z.string().default("Primary Organization"),
    adminEmail: z.string().email().default("admin@localhost"),
    adminName: z.string().default("System Admin"),
  }),

  ai: z.object({
    provider: aiProviderSchema.default("none"),
    model: z.string().default("nvidia/llama-3.3-nemotron-super-49b-v1.5"),
    /** Secret — never log. */
    apiKey: z.string().optional(),
    /** OpenAI-compatible or Ollama base URL. */
    baseUrl: z.string().url().optional(),
    /** Nvidia NIM API key — used when provider is "nvidia_nim" */
    nvidiaApiKey: z.string().optional(),
    /** Nvidia NIM base URL override */
    nvidiaBaseUrl: z.string().url().optional(),
  }),

  mastra: z.object({
    storageSchema: z.string().min(1).default("mastra"),
    observabilityEnabled: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    langfusePublicKey: z.string().optional(),
    langfuseSecretKey: z.string().optional(),
    langfuseBaseUrl: z.string().url().optional(),
  }),

  session: z.object({
    /** HMAC secret for signed session tokens (dev default only). */
    secret: z.string().min(16).default("dev-only-change-me-32chars!!"),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    host: env.HOST,
    port: env.PORT,
    publicApiUrl: env.API_URL ?? env.NEXT_PUBLIC_API_URL,
    webOrigin: env.WEB_ORIGIN ?? env.NEXT_PUBLIC_WEB_URL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    region: env.CHASTE_REGION,
    regions: env.CHASTE_REGIONS,
    defaultAutonomy: env.CHASTE_DEFAULT_AUTONOMY,
    allowFullAutonomous: env.CHASTE_ALLOW_FULL_AUTONOMOUS,
    bootstrap: {
      enabled: env.CHASTE_BOOTSTRAP ?? env.CHASTE_BOOTSTRAP_DEMO,
      orgName: env.CHASTE_ORG_NAME ?? env.CHASTE_DEMO_ORG_NAME,
      adminEmail: env.CHASTE_ADMIN_EMAIL ?? env.CHASTE_DEMO_USER_EMAIL,
      adminName: env.CHASTE_ADMIN_NAME ?? env.CHASTE_DEMO_USER_NAME,
    },
    ai: {
      provider: env.CHASTE_AI_PROVIDER,
      model: env.CHASTE_AI_MODEL,
      apiKey: env.OPENAI_API_KEY ?? env.CHASTE_AI_API_KEY,
      baseUrl: env.CHASTE_AI_BASE_URL,
      nvidiaApiKey: env.NVIDIA_API_KEY,
      nvidiaBaseUrl: env.NVIDIA_BASE_URL,
    },
    mastra: {
      storageSchema: env.MASTRA_STORAGE_SCHEMA,
      observabilityEnabled: env.MASTRA_OBSERVABILITY_ENABLED,
      langfusePublicKey: env.LANGFUSE_PUBLIC_KEY,
      langfuseSecretKey: env.LANGFUSE_SECRET_KEY,
      langfuseBaseUrl: env.LANGFUSE_BASE_URL,
    },
    session: {
      secret: env.CHASTE_SESSION_SECRET,
    },
  };

  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${msg}`);
  }

  if (parsed.data.nodeEnv === "production") {
    if (parsed.data.session.secret === "dev-only-change-me-32chars!!") {
      throw new ConfigError("CHASTE_SESSION_SECRET must be set in production");
    }
    if (parsed.data.allowFullAutonomous && !parsed.data.ai.apiKey && parsed.data.ai.provider !== "ollama") {
      // allow but warn via log level — full auto without LLM is still rule-based
    }
  }

  return parsed.data;
}

/** Redacted view safe for logs/health (no secrets). */
export function publicConfigView(cfg: AppConfig) {
  return {
    nodeEnv: cfg.nodeEnv,
    region: cfg.region,
    regions: cfg.regions,
    defaultAutonomy: cfg.defaultAutonomy,
    allowFullAutonomous: cfg.allowFullAutonomous,
    aiProvider: cfg.ai.provider,
    aiModel: cfg.ai.model,
    aiConfigured: Boolean(cfg.ai.apiKey) || cfg.ai.provider === "ollama" || Boolean(cfg.ai.nvidiaApiKey),
    bootstrapEnabled: cfg.bootstrap.enabled,
    mastraObservability: cfg.mastra.observabilityEnabled,
    nvidiaConfigured: Boolean(cfg.ai.nvidiaApiKey),
  };
}
