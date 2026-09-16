import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    customerId: z.string().uuid(),
    note: z.string().max(500).optional(),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          quantity: z.number().int().positive(),
          unitPriceMinor: z.number().int().nonnegative(),
          taxMinor: z.number().int().nonnegative().optional(),
          sku: z.string().optional(),
        }),
      )
      .min(1),
  }),
  z.object({ action: z.literal("confirm"), orderId: z.string().uuid(), allowBackorder: z.boolean().optional() }),
  z.object({
    action: z.literal("deliver"),
    orderId: z.string().uuid(),
    lines: z
      .array(z.object({ lineId: z.string().uuid(), quantityThousandths: z.number().int().positive() }))
      .optional(),
  }),
  z.object({ action: z.literal("cancel"), orderId: z.string().uuid() }),
]);

const ORDER_STATUSES = ["draft", "confirmed", "delivered", "cancelled"] as const;

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const result = await buildExecutor(getDb().db, buildRegistry(getDb().db)).execute("sales.listOrders", ctx, {
    status: status && (ORDER_STATUSES as readonly string[]).includes(status) ? status : undefined,
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

  const d = parsed.data;
  const capId =
    d.action === "create"
      ? "sales.createOrder"
      : d.action === "confirm"
        ? "sales.confirmOrder"
        : d.action === "deliver"
          ? "sales.deliverOrder"
          : "sales.cancelOrder";
  const input =
    d.action === "create"
      ? { customerId: d.customerId, note: d.note, lines: d.lines }
      : d.action === "confirm"
        ? { orderId: d.orderId, allowBackorder: d.allowBackorder }
        : d.action === "deliver"
          ? { orderId: d.orderId, lines: d.lines }
          : { orderId: d.orderId };

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
