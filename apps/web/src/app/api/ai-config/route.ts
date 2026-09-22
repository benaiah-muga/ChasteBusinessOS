import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import {
  AI_PROVIDER_IDS,
  aiModelsSchema,
  encryptProviderKey,
  providerDefaults,
  publicAiConfig,
  storedAiConfigForOrg,
} from "@/server/ai-settings";

const bodySchema = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  baseUrl: z.string().url().max(500),
  models: aiModelsSchema,
  apiKey: z.string().trim().min(1).max(1000).optional(),
  clearApiKey: z.boolean().optional(),
});

/**
 * Which model configuration the workmate actually runs on. Read-only: keys
 * live in the server environment and are never echoed, only their presence.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await publicAiConfig(getDb().db, resolved.orgId));
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid model configuration" }, { status: 400 });

  const db = getDb().db;
  const current = await storedAiConfigForOrg(db, resolved.orgId);
  const apiKey = parsed.data.clearApiKey
    ? null
    : parsed.data.apiKey
      ? encryptProviderKey(parsed.data.apiKey)
      : current?.encryptedApiKey ?? null;
  const rawKey = parsed.data.apiKey;
  const input = {
    provider: parsed.data.provider,
    baseUrl: parsed.data.baseUrl || providerDefaults[parsed.data.provider],
    models: parsed.data.models,
    encryptedApiKey: apiKey,
    keyHint: parsed.data.clearApiKey ? null : rawKey ? `••••${rawKey.slice(-4)}` : current?.keyHint ?? null,
    updatedAt: new Date().toISOString(),
  };
  const ctx = actorFromResolved(resolved);
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const result = await buildExecutor(db, buildRegistry(db)).execute("settings.configureAiProvider", ctx, { config: input });
  if (result.pendingApproval) return NextResponse.json({ pendingApproval: true, error: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, ...(await publicAiConfig(db, resolved.orgId)) });
}
