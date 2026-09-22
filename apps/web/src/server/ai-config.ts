import { and, eq } from "drizzle-orm";
import { aiSettings, decryptSecret, type Database } from "@chaste/db";
import { groqClient, mistralClient, nimClient, stripProviderPrefix, zaiClient, compatClient, type ModelRef, type OpenAIClient } from "@chaste/ai";

/**
 * Org-aware AI client resolution. An org with its own credentials gets its
 * own provider, key (decrypted server-side only), base URL, and model per
 * role; everyone else falls back to the server's env configuration. The
 * decrypted key exists only inside the OpenAI client - it is never logged
 * and never returned to a browser.
 */

export type AiRole = "primary" | "fast" | "reasoning" | "embeddings" | "ocr";

export interface OrgAiClient {
  client: OpenAIClient;
  model: string;
  /** "nim" (default) or an explicit provider prefix for resolveClient-style calls. */
  provider: string;
  /** True when the org configured its own credentials. */
  orgManaged: boolean;
}

export async function loadOrgAiSettings(db: Database["db"], orgId: string) {
  const [row] = await db
    .select({
      provider: aiSettings.provider,
      encryptedApiKey: aiSettings.encryptedApiKey,
      keyLast4: aiSettings.keyLast4,
      baseUrl: aiSettings.baseUrl,
      modelRouting: aiSettings.modelRouting,
    })
    .from(aiSettings)
    .where(and(eq(aiSettings.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

function clientFor(provider: string, apiKey: string | undefined, baseUrl: string | null): OpenAIClient {
  const opts = { apiKey, baseUrl: baseUrl ?? undefined };
  switch (provider) {
    case "openrouter":
      return compatClient(apiKey ? opts : {});
    case "groq":
      return groqClient(apiKey ? opts : {});
    case "mistral":
      return mistralClient(apiKey ? opts : {});
    case "zai":
      return zaiClient(apiKey ? opts : {});
    default:
      return nimClient(apiKey ? opts : {});
  }
}

/**
 * Client + model for the org's given role. When the org has no managed
 * configuration for that role, env defaults apply (resolveClient semantics
 * live in @chaste/ai; here we only override what the org actually set).
 */
export async function resolveOrgModel(db: Database["db"], orgId: string, role: AiRole = "primary"): Promise<ModelRef & { provider: string; orgManaged: boolean }> {
  const row = await loadOrgAiSettings(db, orgId);
  const routing = (row?.modelRouting ?? {}) as Partial<Record<AiRole, string>>;
  const provider = row?.provider ?? "nim";
  const routed = routing[role];
  const envModel =
    role === "primary"
      ? process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6"
      : role === "fast"
        ? process.env.MODEL_FAST ?? "meta/muse-glimmer-30b"
        : role === "reasoning"
          ? process.env.MODEL_REASONING ?? "nvidia/nemotron-3-ultra-550b-a55b"
          : role === "embeddings"
            ? process.env.MODEL_EMBEDDINGS ?? "nvidia/nv-embedqa-e5-v5"
            : process.env.MODEL_OCR ?? process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6";
  const raw = routed ?? envModel;
  return {
    provider,
    model: stripProviderPrefix(raw),
    orgManaged: Boolean(row),
  };
}

/** Full client for the org, using its own key when it has one. */
export async function resolveOrgClient(db: Database["db"], orgId: string, role: AiRole = "primary"): Promise<OrgAiClient> {
  const row = await loadOrgAiSettings(db, orgId);
  const resolved = await resolveOrgModel(db, orgId, role);
  if (!row) {
    // Env fallback: resolveClient picks provider + key from env exactly as
    // every caller did before org-managed settings existed.
    const { resolveClient } = await import("@chaste/ai");
    return { client: resolveClient(), model: resolved.model, provider: "env", orgManaged: false };
  }
  const apiKey = row.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : undefined;
  return { client: clientFor(row.provider, apiKey, row.baseUrl), model: resolved.model, provider: row.provider, orgManaged: true };
}
