import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

function quotesGoUnavailable() {
  return NextResponse.json(
    { error: "quotes service unavailable; check quote status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function quotesGoResponse(result: GoCapabilityBridgeResult, action: "create" | "accept" | "decline" | "expire") {
  if (result.kind !== "response") return quotesGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const quoteDataSchema = action === "create"
        ? z.object({ quoteId: z.string(), quoteNumber: z.number(), totalMinor: z.number() })
        : action === "accept"
          ? z.object({ invoiceId: z.string(), invoiceNumber: z.number(), totalMinor: z.number() })
          : action === "decline"
            ? z.object({ status: z.string() })
            : z.object({ expiredCount: z.number() });
      const parsed = z.object({ ok: z.literal(true), data: quoteDataSchema }).safeParse(body);
      if (!parsed.success) return quotesGoUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return quotesGoUnavailable();
      return NextResponse.json(
        { error: parsed.data.reason, pendingApproval: true },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return quotesGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return quotesGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return quotesGoUnavailable();
  }

  return quotesGoUnavailable();
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    customerId: z.string().uuid(),
    memo: z.string().max(300).optional(),
    expiresAt: z.string().date().optional(),
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
  z.object({ action: z.literal("expire") }),
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
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const capId =
    parsed.data.action === "create"
      ? "accounting.createQuote"
      : parsed.data.action === "accept"
        ? "accounting.acceptQuote"
        : parsed.data.action === "decline"
          ? "accounting.declineQuote"
          : "accounting.expireQuote";
  const input =
    parsed.data.action === "create"
      ? {
          customerId: parsed.data.customerId,
          memo: parsed.data.memo,
          expiresAt: parsed.data.expiresAt
            ? new Date(`${parsed.data.expiresAt}T23:59:59.999Z`).toISOString()
            : undefined,
          lines: parsed.data.lines,
        }
      : parsed.data.action === "expire"
        ? {}
        : { quoteId: parsed.data.quoteId };

  if (process.env.GO_ACCOUNTING_QUOTES_WRITE === "1") {
    try {
      const goResult = await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId: capId,
        input,
      });
      return quotesGoResponse(goResult, parsed.data.action);
    } catch {
      return quotesGoUnavailable();
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
