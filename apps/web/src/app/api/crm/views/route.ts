import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const filterSchema = z.object({
  status: z.enum(["active", "inactive", "all"]),
  owner: z.string().max(64),
  staleOnly: z.boolean(),
  duplicateOnly: z.boolean(),
  tag: z.string().max(40),
});
const bodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: filterSchema,
  isShared: z.boolean(),
  isPinned: z.boolean(),
  id: z.string().uuid().optional(),
});

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("crm.listCustomerViews", ctx, {});
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ views: (result.data as { views: unknown[] } | undefined)?.views ?? [] });
}

export async function POST(request: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const body = bodySchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.issues }, { status: 400 });
  const ctx = actorFromResolved(resolved, { intentId: typeof raw?.intentId === "string" ? raw.intentId : undefined });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("crm.saveCustomerView", ctx, body.data);
  if (result.pendingApproval) return NextResponse.json({ pendingApproval: true, error: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
