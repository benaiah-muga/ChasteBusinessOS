import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations, type Database } from "@chaste/db";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import type { ModelProviderId, RuntimeProviderConfig } from "@chaste/ai";

export const AI_PROVIDER_IDS = ["nvidia", "openrouter", "groq", "mistral", "zai", "openai", "custom"] as const;
export const aiProviderIdSchema = z.enum(AI_PROVIDER_IDS);

export const aiModelsSchema = z.object({
  primary: z.string().trim().min(1).max(200),
  fast: z.string().trim().min(1).max(200),
  reasoning: z.string().trim().min(1).max(200),
  embeddings: z.string().trim().min(1).max(200),
});

export const storedAiProviderConfigSchema = z.object({
  provider: aiProviderIdSchema,
  baseUrl: z.string().url().max(500),
  models: aiModelsSchema,
  encryptedApiKey: z.string().min(1).max(2000).nullable(),
  keyHint: z.string().max(12).nullable(),
  updatedAt: z.string().datetime(),
});

export type StoredAiProviderConfig = z.infer<typeof storedAiProviderConfigSchema>;

export const configureAiProviderInputSchema = z.object({ config: storedAiProviderConfigSchema.nullable() });
export const configureAiProviderOutputSchema = z.object({
  previous: storedAiProviderConfigSchema.nullable(),
  current: storedAiProviderConfigSchema.nullable(),
});
export type ConfigureAiProviderInput = z.infer<typeof configureAiProviderInputSchema>;

const AI_CONFIG_CAPABILITY = "settings.configureAiProvider";
const AI_CONFIG_RESTORE_CAPABILITY = "settings.restoreAiProvider";

const defaultModels = {
  primary: process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6",
  fast: process.env.MODEL_FAST ?? "meta/muse-glimmer-30b",
  reasoning: process.env.MODEL_REASONING ?? "nvidia/nemotron-3-ultra-550b-a55b",
  embeddings: process.env.MODEL_EMBEDDINGS ?? "nvidia/nv-embedqa-e5-v5",
};

export const providerDefaults: Record<ModelProviderId, string> = {
  nvidia: process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  zai: process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4",
  openai: "https://api.openai.com/v1",
  custom: "",
};

function envProvider(): ModelProviderId {
  const value = process.env.MODEL_PROVIDER;
  return AI_PROVIDER_IDS.includes(value as ModelProviderId) ? (value as ModelProviderId) : "nvidia";
}

function envKey(provider: ModelProviderId): string | undefined {
  const names: Record<ModelProviderId, string> = {
    nvidia: "NVIDIA_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    mistral: "MISTRAL_API_KEY",
    zai: "ZAI_API_KEY",
    openai: "OPENAI_API_KEY",
    custom: "",
  };
  const name = names[provider];
  return name ? process.env[name] : undefined;
}

function masterKey(): Buffer {
  const secret = process.env.AI_CONFIG_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("AI_CONFIG_ENCRYPTION_KEY or BETTER_AUTH_SECRET is required");
  return createHash("sha256").update(secret).digest();
}

/** Encrypts provider credentials before they enter the kernel payload or database. */
export function encryptProviderKey(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptProviderKey(value: string): string {
  const [version, ivText, tagText, ciphertextText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("invalid encrypted provider key");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

function orgSettings(settings: unknown): Record<string, unknown> {
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? { ...(settings as Record<string, unknown>) }
    : {};
}

export async function storedAiConfigForOrg(db: Database["db"], orgId: string): Promise<StoredAiProviderConfig | null> {
  const [row] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const parsed = z.object({ ai: storedAiProviderConfigSchema }).safeParse(orgSettings(row?.settings));
  return parsed.success ? parsed.data.ai : null;
}

export function envAiConfig() {
  const provider = envProvider();
  return {
    provider,
    baseUrl: providerDefaults[provider],
    models: defaultModels,
    configured: Boolean(envKey(provider)),
    source: "environment" as const,
  };
}

export async function publicAiConfig(db: Database["db"], orgId: string) {
  const stored = await storedAiConfigForOrg(db, orgId);
  if (!stored) return { ...envAiConfig(), keyHint: envKey(envProvider()) ? `••••${envKey(envProvider())!.slice(-4)}` : null };
  let configured = false;
  try {
    configured = Boolean(stored.encryptedApiKey && decryptProviderKey(stored.encryptedApiKey));
  } catch {
    configured = false;
  }
  return {
    provider: stored.provider,
    baseUrl: stored.baseUrl,
    models: stored.models,
    configured,
    keyHint: stored.keyHint,
    source: "workspace" as const,
  };
}

export async function runtimeAiConfig(db: Database["db"], orgId: string) {
  const stored = await storedAiConfigForOrg(db, orgId);
  if (!stored) {
    const env = envAiConfig();
    return {
      runtime: { provider: env.provider, apiKey: envKey(env.provider), baseUrl: env.baseUrl } satisfies RuntimeProviderConfig,
      models: env.models,
    };
  }
  let apiKey: string | undefined;
  if (stored.encryptedApiKey) {
    try {
      apiKey = decryptProviderKey(stored.encryptedApiKey);
    } catch {
      apiKey = undefined;
    }
  }
  return {
    runtime: { provider: stored.provider, apiKey, baseUrl: stored.baseUrl } satisfies RuntimeProviderConfig,
    models: stored.models,
  };
}

async function saveConfig(db: Database["db"], orgId: string, config: StoredAiProviderConfig | null): Promise<StoredAiProviderConfig | null> {
  const [row] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const settings = orgSettings(row?.settings);
  const previous = storedAiProviderConfigSchema.nullable().parse(settings.ai ?? null);
  if (config) settings.ai = config;
  else delete settings.ai;
  await db.update(organizations).set({ settings }).where(eq(organizations.id, orgId));
  return previous;
}

export function registerAiSettingsCapabilities(registry: CapabilityRegistry, deps: { db: Database["db"] }): void {
  registry.register(
    defineCapability({
      id: AI_CONFIG_CAPABILITY,
      title: "Configure workspace model provider",
      intent: "Set the workspace model provider, endpoint, model roles, and encrypted API credential for governed agent runs",
      module: "settings",
      risk: "secret",
      permission: "iam.admin",
      input: configureAiProviderInputSchema,
      output: configureAiProviderOutputSchema,
      inverse: {
        capabilityId: AI_CONFIG_RESTORE_CAPABILITY,
        buildInput: (_input, output) => ({ config: output.previous }),
      },
      execute: async (ctx, input) => {
        const previous = await saveConfig(deps.db, ctx.actor.orgId, input.config);
        return { previous, current: input.config };
      },
    }),
  );
  registry.register(
    defineCapability({
      id: AI_CONFIG_RESTORE_CAPABILITY,
      title: "Restore workspace model provider",
      intent: "Restore a previously saved workspace model provider configuration after a governed configuration change",
      module: "settings",
      risk: "secret",
      permission: "iam.admin",
      input: z.object({ config: storedAiProviderConfigSchema.nullable() }),
      output: configureAiProviderOutputSchema,
      inverse: {
        capabilityId: AI_CONFIG_CAPABILITY,
        buildInput: (_input, output) => ({ config: output.previous ?? output.current }),
      },
      execute: async (ctx, input) => {
        const previous = await storedAiConfigForOrg(deps.db, ctx.actor.orgId);
        if (input.config) await saveConfig(deps.db, ctx.actor.orgId, input.config);
        else await saveConfig(deps.db, ctx.actor.orgId, null);
        return { previous, current: input.config };
      },
    }),
  );
}
