import { NextResponse } from "next/server";
import { z } from "zod";
import { encryptionConfigured, getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { loadOrgAiSettings } from "@/server/ai-config";
import { getResolvedUser } from "@/server/session";

/**
 * The org's AI configuration. Reads are masked: provider, key last-4, base
 * URL, and routing only - the key itself never leaves the server. Writes go
 * through the governed iam.setAiSettings capability (secret-class: the
 * ledger and the approvals inbox redact the payload).
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const row = await loadOrgAiSettings(getDb().db, resolved.orgId);
  const envKeySet = Boolean(process.env.NVIDIA_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY);
  return NextResponse.json({
    settings: row
      ? {
          provider: row.provider,
          keyLast4: row.keyLast4,
          hasKey: Boolean(row.encryptedApiKey),
          baseUrl: row.baseUrl,
          routing: row.modelRouting,
        }
      : null,
    canEdit: hasPermissionFor({ permissions: resolved.permissions }, "iam.admin"),
    encryptionReady: encryptionConfigured(),
    envFallback: {
      provider: process.env.MODEL_PROVIDER || "nim",
      models: {
        primary: process.env.MODEL_PRIMARY ?? "moonshotai/kimi-k2.6",
        fast: process.env.MODEL_FAST ?? "meta/muse-glimmer-30b",
        reasoning: process.env.MODEL_REASONING ?? "nvidia/nemotron-3-ultra-550b-a55b",
        embeddings: process.env.MODEL_EMBEDDINGS ?? "nvidia/nv-embedqa-e5-v5",
      },
      keyConfigured: envKeySet,
    },
  });
}

const routingSchema = z
  .object({
    primary: z.string().trim().min(1).max(120).optional(),
    fast: z.string().trim().min(1).max(120).optional(),
    reasoning: z.string().trim().min(1).max(120).optional(),
    embeddings: z.string().trim().min(1).max(120).optional(),
    ocr: z.string().trim().min(1).max(120).optional(),
  })
  .default({});

const bodySchema = z.object({
  provider: z.enum(["nim", "openrouter", "groq", "mistral", "zai"]).default("nim"),
  apiKey: z.string().trim().min(8).max(400).optional(),
  baseUrl: z.string().trim().url().max(300).optional(),
  routing: routingSchema,
  intentId: z.string().optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  if (!encryptionConfigured()) {
    return NextResponse.json(
      {
        error:
          "Secret storage is not configured on this server: set CHASTE_ENCRYPTION_KEY first. Until then the server's env-based AI configuration applies.",
      },
      { status: 503 },
    );
  }

  const ctx = actorFromResolved(resolved, { intentId: parsed.data.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.setAiSettings", ctx, {
    provider: parsed.data.provider,
    ...(parsed.data.apiKey ? { apiKey: parsed.data.apiKey } : {}),
    ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : {}),
    routing: parsed.data.routing,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  if (result.pendingApproval) {
    return NextResponse.json(
      { pendingApproval: true, hint: "AI configuration changes proposed by the workmate wait for approval in the Approvals inbox." },
      { status: 202 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
