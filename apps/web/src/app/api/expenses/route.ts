import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { expensePolicies, getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

const expenseOutputSchemas = {
  submit: z.object({
    claimId: z.string(),
    status: z.literal("submitted"),
    category: z.string(),
    overPolicyLimit: z.boolean(),
    policyLimitMinor: z.number().nullable(),
  }),
  decide: z.object({ claimId: z.string(), status: z.enum(["approved", "rejected"]) }),
  pay: z.object({ claimId: z.string(), entryId: z.string(), paidMinor: z.number() }),
  setPolicy: z.object({ set: z.literal(true), category: z.string(), limitMinor: z.number() }),
} as const;

type ExpenseAction = keyof typeof expenseOutputSchemas;

function goUnavailable() {
  return NextResponse.json({ error: "expenses service unavailable; check claim status before retrying" }, { status: 503, headers: noStore });
}

function goReadUnavailable() {
  return NextResponse.json({ error: "expenses service unavailable" }, { status: 503, headers: noStore });
}

async function expenseGoReadData(result: GoCapabilityBridgeResult): Promise<
  | { data: Record<string, unknown> }
  | { response: Response }
> {
  if (result.kind !== "response") return { response: goReadUnavailable() };
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).safeParse(body);
      return parsed.success ? { data: parsed.data.data } : { response: goReadUnavailable() };
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      return parsed.success
        ? { response: NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore }) }
        : { response: goReadUnavailable() };
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      return parsed.success
        ? { response: NextResponse.json(parsed.data, { status: result.response.status, headers: noStore }) }
        : { response: goReadUnavailable() };
    }
  } catch {
    return { response: goReadUnavailable() };
  }
  return { response: goReadUnavailable() };
}

async function expenseGoResponse(action: ExpenseAction, result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return goUnavailable();
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: expenseOutputSchemas[action] }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.reason, pendingApproval: true }, { status: 202, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
    if (result.response.status === 400 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 401, headers: noStore });
    }
  } catch {
    return goUnavailable();
  }
  return goUnavailable();
}

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
  z.object({
    action: z.literal("setPolicy"),
    category: z.string().min(2).max(40),
    limitMinor: z.number().int().nonnegative(),
  }),
]);

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const db = getDb().db;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  if (process.env.GO_ACCOUNTING_EXPENSE_READS === "1") {
    const input = status && ["submitted", "approved", "rejected", "paid"].includes(status) ? { status } : {};
    try {
      const [claimsResult, policiesResult] = await Promise.all([
        executeGoCapability({ actionContext: ctx, session: resolved, capabilityId: "accounting.listExpenseClaims", input }),
        executeGoCapability({ actionContext: ctx, session: resolved, capabilityId: "accounting.listExpensePolicies", input: {} }),
      ]);
      const [claims, policies] = await Promise.all([
        expenseGoReadData(claimsResult),
        expenseGoReadData(policiesResult),
      ]);
      if ("response" in claims) return claims.response;
      if ("response" in policies) return policies.response;
      const payload = z.object({ claims: z.array(z.unknown()) }).safeParse(claims.data);
      const policyRows = z.object({ policies: z.array(z.object({ category: z.string(), limitMinor: z.number() })) }).safeParse(policies.data);
      if (!payload.success || !policyRows.success) return goReadUnavailable();
      return NextResponse.json({ claims: payload.data.claims, policies: policyRows.data.policies }, { headers: noStore });
    } catch {
      return goReadUnavailable();
    }
  }
  const result = await buildExecutor(db, buildRegistry(db)).execute("accounting.listExpenseClaims", ctx, {
    status:
      status && ["submitted", "approved", "rejected", "paid"].includes(status) ? status : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
  // Policy limits have no list capability; the current caps are a plain read.
  const policies = await db
    .select({ category: expensePolicies.category, limitMinor: expensePolicies.limitMinor })
    .from(expensePolicies)
    .where(eq(expensePolicies.orgId, resolved.orgId))
    .orderBy(desc(expensePolicies.limitMinor));
  return NextResponse.json({ ...(result.data as Record<string, unknown>), policies });
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
    parsed.data.action === "submit"
      ? "accounting.submitExpenseClaim"
      : parsed.data.action === "decide"
        ? "accounting.decideExpenseClaim"
        : parsed.data.action === "pay"
          ? "accounting.payExpenseClaim"
          : "accounting.setExpensePolicy";
  const input =
    parsed.data.action === "submit"
      ? {
          amountMinor: parsed.data.amountMinor,
          memo: parsed.data.memo,
          accountCode: parsed.data.accountCode,
        }
      : parsed.data.action === "decide"
        ? { claimId: parsed.data.claimId, decision: parsed.data.decision, reason: parsed.data.reason }
        : parsed.data.action === "pay"
          ? { claimId: parsed.data.claimId, amountMinor: parsed.data.amountMinor }
          : { category: parsed.data.category, limitMinor: parsed.data.limitMinor };

  if (process.env.GO_ACCOUNTING_EXPENSE_WRITES === "1") {
    try {
      return await expenseGoResponse(parsed.data.action, await executeGoCapability({
        actionContext: ctx,
        session: resolved,
        capabilityId: capId,
        input,
      }));
    } catch {
      return goUnavailable();
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
