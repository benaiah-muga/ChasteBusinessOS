import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const querySchema = z.object({
  type: z.enum(["customer", "supplier", "employee", "invoice", "quote", "purchase_order", "sales_order"]),
  q: z.string().max(120).default(""),
  id: z.string().uuid().optional(),
});

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ type: url.searchParams.get("type"), q: url.searchParams.get("q") ?? "", id: url.searchParams.get("id") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: "invalid record search" }, { status: 400 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("documents.searchRecords", ctx, {
    type: parsed.data.type,
    query: parsed.data.q,
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json(result.data ?? { records: [] });
}
