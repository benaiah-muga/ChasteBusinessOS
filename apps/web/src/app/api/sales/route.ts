import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

function salesGoUnavailable() {
  return NextResponse.json(
    { error: "sales service unavailable; check order status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function salesGoResponse(result: GoCapabilityBridgeResult, action: "create" | "confirm" | "deliver" | "cancel") {
  if (result.kind !== "response") return salesGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const orderDataSchema = action === "create"
        ? z.object({ orderId: z.string(), orderNumber: z.number() })
        : action === "confirm"
          ? z.object({
              confirmed: z.literal(true),
              backordered: z.boolean(),
              reservedThousandths: z.number().int(),
            })
          : action === "deliver"
            ? z.object({
                invoiceId: z.string(),
                invoiceNumber: z.number(),
                invoiceTotalMinor: z.number(),
                orderStatus: z.string(),
              })
            : z.object({ status: z.literal("cancelled"), releasedThousandths: z.number().int() });
      const parsed = z.object({ ok: z.literal(true), data: orderDataSchema }).safeParse(body);
      if (!parsed.success) return salesGoUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return salesGoUnavailable();
      return NextResponse.json(
        { error: parsed.data.reason, pendingApproval: true },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return salesGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return salesGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return salesGoUnavailable();
  }

  return salesGoUnavailable();
}

const salesListOrdersOutputSchema = z.object({
  orders: z.array(z.object({
    id: z.string(),
    number: z.number().int(),
    customerId: z.string(),
    status: z.string(),
    backordered: z.boolean(),
    totalMinor: z.number().int(),
    createdAt: z.string().datetime(),
  })),
});

async function salesListOrdersGoResponse(result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return salesGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: salesListOrdersOutputSchema }).safeParse(body);
      if (!parsed.success) return salesGoUnavailable();
      return NextResponse.json(parsed.data.data, { headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return salesGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return salesGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return salesGoUnavailable();
  }

  return salesGoUnavailable();
}

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
  const input = { status: status && (ORDER_STATUSES as readonly string[]).includes(status) ? status : undefined };
  if (process.env.GO_SALES_LIST_ORDERS_READS === "1") {
    try {
      return await salesListOrdersGoResponse(await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId: "sales.listOrders",
        input,
      }));
    } catch {
      return salesGoUnavailable();
    }
  }
  const db = getDb().db;
  const result = await buildExecutor(db, buildRegistry(db)).execute("sales.listOrders", ctx, input);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json(result.data);
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId });
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

  if (process.env.GO_SALES_WRITE === "1") {
    try {
      const goResult = await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId: capId,
        input,
      });
      return salesGoResponse(goResult, d.action);
    } catch {
      return salesGoUnavailable();
    }
  }

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
