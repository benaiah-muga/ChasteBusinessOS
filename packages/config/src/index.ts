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

export const aiProviderSchema = z.enum([
  "none",
  "openai",
  "openai_compatible",
  "ollama",
  "nvidia_nim",
  "auto",
]);

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
    adminEmail: z.string().email().default("admin@chaste.local"),
    adminName: z.string().default("System Admin"),
  }),

  ai: z.object({
    provider: aiProviderSchema.default("none"),
    model: z.string().default("meta/llama-3.1-8b-instruct"),
    /** Secret — never log. */
    apiKey: z.string().optional(),
    /** OpenAI-compatible or Ollama base URL. */
    baseUrl: z.string().url().optional(),
    /** Nvidia NIM API key — used when provider is "nvidia_nim" */
    nvidiaApiKey: z.string().optional(),
    /** Nvidia NIM base URL override */
    nvidiaBaseUrl: z.string().url().optional(),
    /**
     * Prefer this detected coding agent when provider is "auto". Ignored if
     * the agent isn't installed/authenticated (falls back to registry order).
     */
    codingAgentPrefer: z.string().nullable().default(null),
    /** R2 — where new approvals surface by default for attended sessions. */
    defaultInboxVisibility: z.enum(["inline", "inbox"]).default("inline"),
  }),

  /** Optional LLM tracing (Langfuse). Independent of any agent framework. */
  observability: z.object({
    enabled: z
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
    /** Auth token TTL in seconds (Bearer sessions). */
    tokenTtlSeconds: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
  }),

  /**
   * F1 remediation — HTTP auth posture.
   *
   * `allowAnonymousAdmin` keeps the legacy "no token ⇒ bootstrap admin"
   * fallback for local development only. It defaults to ON for
   * development/test and is HARD-REJECTED in production (fail closed), so a
   * deployed instance can never ship the auth bypass.
   */
  auth: z.object({
    allowAnonymousAdmin: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /**
     * Optional static credential minted for the bootstrap admin on first boot
     * (stored hashed at rest via `hashAuthToken`). Without a boot credential
     * and without the anonymous fallback, no one could authenticate at all —
     * this closes that chicken-and-egg gap for production installs.
     */
    bootstrapAdminToken: z.string().min(16).optional(),
  }),
});

/** Holds the actor/resolver wiring knobs surfaced as a single auth block. */

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
      codingAgentPrefer: env.CHASTE_AI_PREFER_CODING_AGENT ?? null,
      defaultInboxVisibility: env.CHASTE_DEFAULT_INBOX_VISIBILITY === "inbox" ? "inbox" : "inline",
    },
    observability: {
      // Prefer CHASTE_OBSERVABILITY_ENABLED; keep MASTRA_* as temporary aliases.
      enabled: env.CHASTE_OBSERVABILITY_ENABLED ?? env.MASTRA_OBSERVABILITY_ENABLED,
      langfusePublicKey: env.LANGFUSE_PUBLIC_KEY,
      langfuseSecretKey: env.LANGFUSE_SECRET_KEY,
      langfuseBaseUrl: env.LANGFUSE_BASE_URL,
    },
    session: {
      secret: env.CHASTE_SESSION_SECRET,
      tokenTtlSeconds: env.CHASTE_SESSION_TOKEN_TTL,
    },
    auth: {
      // The anonymous-admin fallback is a dev convenience only; production
      // must fail closed (enforced below).
      allowAnonymousAdmin:
        env.CHASTE_ALLOW_ANON_ADMIN ?? (env.NODE_ENV === "production" ? "false" : "true"),
      bootstrapAdminToken: env.CHASTE_ADMIN_TOKEN,
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
    // F1 fail-closed: the anonymous bootstrap-admin fallback must never ship.
    if (parsed.data.auth.allowAnonymousAdmin) {
      throw new ConfigError("CHASTE_ALLOW_ANON_ADMIN must be false in production");
    }
    if (
      parsed.data.allowFullAutonomous &&
      !parsed.data.ai.apiKey &&
      parsed.data.ai.provider !== "ollama" &&
      parsed.data.ai.provider !== "auto"
    ) {
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
    aiConfigured:
      Boolean(cfg.ai.apiKey) ||
      cfg.ai.provider === "ollama" ||
      Boolean(cfg.ai.nvidiaApiKey) ||
      cfg.ai.provider === "auto",
    preferredCodingAgent: cfg.ai.codingAgentPrefer,
    bootstrapEnabled: cfg.bootstrap.enabled,
    observabilityEnabled: cfg.observability.enabled,
    nvidiaConfigured: Boolean(cfg.ai.nvidiaApiKey),
  };
}
