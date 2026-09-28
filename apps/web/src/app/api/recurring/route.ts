import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

function recurringGoUnavailable() {
  return NextResponse.json(
    { error: "recurring template service unavailable; check template status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function recurringGoResponse(result: GoCapabilityBridgeResult, action: "create" | "pause" | "resume") {
  if (result.kind !== "response") return recurringGoUnavailable();

  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const recurringDataSchema = action === "create"
        ? z.object({ templateId: z.string(), nextRunAt: z.string() })
        : z.object({ active: z.boolean() });
      const parsed = z.object({ ok: z.literal(true), data: recurringDataSchema }).safeParse(body);
      if (!parsed.success) return recurringGoUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return recurringGoUnavailable();
      return NextResponse.json(
        { error: parsed.data.reason, pendingApproval: true },
        { status: 202, headers: noStore },
      );
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return recurringGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
    }
    if ([400, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return recurringGoUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
  } catch {
    return recurringGoUnavailable();
  }

  return recurringGoUnavailable();
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    customerId: z.string().uuid(),
    frequency: z.enum(["weekly", "monthly", "quarterly"]),
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
  z.object({ action: z.literal("pause"), templateId: z.string().uuid() }),
  z.object({ action: z.literal("resume"), templateId: z.string().uuid() }),
]);

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const result = await buildExecutor(db, buildRegistry(db)).execute(
    "accounting.listRecurringTemplates",
    ctx,
    {},
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
      ? "accounting.createRecurringTemplate"
      : parsed.data.action === "pause"
        ? "accounting.pauseRecurringTemplate"
        : "accounting.resumeRecurringTemplate";
  const input =
    parsed.data.action === "create"
      ? {
          customerId: parsed.data.customerId,
          frequency: parsed.data.frequency,
          memo: parsed.data.memo,
          lines: parsed.data.lines,
        }
      : { templateId: parsed.data.templateId };

  if (process.env.GO_ACCOUNTING_RECURRING_WRITE === "1") {
    try {
      const goResult = await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId: capId,
        input,
      });
      return recurringGoResponse(goResult, parsed.data.action);
    } catch {
      return recurringGoUnavailable();
    }
  }

  const result = await buildExecutor(db, buildRegistry(db)).execute(capId, ctx, input);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
