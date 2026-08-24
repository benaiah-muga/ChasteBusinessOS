import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    customerId: z.string().uuid(),
    memo: z.string().max(300).optional(),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          quantity: z.number().int().positive(),
          unitPriceMinor: z.number().int().nonnegative(),
          taxMinor: z.number().int().nonnegative().default(0),
        }),
      )
      .min(1),
  }),
  z.object({ action: z.literal("accept"), quoteId: z.string().uuid() }),
  z.object({ action: z.literal("decline"), quoteId: z.string().uuid() }),
]);

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const result = await buildExecutor(getDb().db, buildRegistry(getDb().db)).execute(
    "accounting.listQuotes",
    ctx,
    { status: status && ["draft", "sent", "accepted", "declined", "expired"].includes(status) ? status : undefined },
  );
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
    parsed.data.action === "create"
      ? "accounting.createQuote"
      : parsed.data.action === "accept"
        ? "accounting.acceptQuote"
        : "accounting.declineQuote";
  const input =
    parsed.data.action === "create"
      ? { customerId: parsed.data.customerId, memo: parsed.data.memo, lines: parsed.data.lines }
      : { quoteId: parsed.data.quoteId };

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
