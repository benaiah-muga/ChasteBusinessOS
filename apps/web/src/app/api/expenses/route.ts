import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("submit"),
    amountMinor: z.number().int().positive(),
    memo: z.string().min(3).max(500),
    accountCode: z.string().optional(),
  }),
  z.object({
    action: z.literal("decide"),
    claimId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal("pay"),
    claimId: z.string().uuid(),
    amountMinor: z.number().int().positive(),
  }),
]);

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const result = await buildExecutor(db, buildRegistry(db)).execute("accounting.listExpenseClaims", ctx, {
    status:
      status && ["submitted", "approved", "rejected", "paid"].includes(status) ? status : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json(result.data);
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const capId =
    parsed.data.action === "submit"
      ? "accounting.submitExpenseClaim"
      : parsed.data.action === "decide"
        ? "accounting.decideExpenseClaim"
        : "accounting.payExpenseClaim";
  const input =
    parsed.data.action === "submit"
      ? {
          amountMinor: parsed.data.amountMinor,
          memo: parsed.data.memo,
          accountCode: parsed.data.accountCode,
        }
      : parsed.data.action === "decide"
        ? { claimId: parsed.data.claimId, decision: parsed.data.decision, reason: parsed.data.reason }
        : { claimId: parsed.data.claimId, amountMinor: parsed.data.amountMinor };

  const result = await buildExecutor(db, buildRegistry(db)).execute(capId, ctx, input);
  if (!result.ok) {
    const gated = Boolean(result.pendingApproval);
    return NextResponse.json(
      { error: result.error, pendingApproval: gated || undefined },
      { status: gated ? 202 : 422 },
    );
  }
  return NextResponse.json({ ok: true, data: result.data });
}
