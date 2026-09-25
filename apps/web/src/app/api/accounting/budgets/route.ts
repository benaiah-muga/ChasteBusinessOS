import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { buildExecutor, buildRegistry, actorFromResolved } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { accounts, getDb } from "@chaste/db";

const querySchema = z.object({ fiscalYear: z.coerce.number().int().min(2000).max(2100).optional(), scenarioId: z.string().uuid().optional() });

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "accounting.read");
  if (denied) return denied;
  const query = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid query" }, { status: 400 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const scenarios = await executor.execute("accounting.listBudgetScenarios", ctx, { fiscalYear: query.data.fiscalYear });
  if (!scenarios.ok) return respond(scenarios);
  const comparison = query.data.scenarioId ? await executor.execute("accounting.budgetActualVsPlan", ctx, { scenarioId: query.data.scenarioId }) : null;
  if (comparison && !comparison.ok) return respond(comparison);
  const chartAccounts = await db.select({ code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.orgId, resolved.orgId), inArray(accounts.type, ["income", "expense"])))
    .orderBy(asc(accounts.code));
  return NextResponse.json({ ok: true, scenarios: scenarios.data, comparison: comparison?.data ?? null, accounts: chartAccounts });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const bodySchema = z.object({ action: z.enum(["save", "undo"]), intentId: z.string().optional(), scenarioId: z.string().uuid().optional(), previousScenarioId: z.string().uuid().nullable().optional(), scenarioKey: z.string().optional(), name: z.string().optional(), fiscalYear: z.number().int().optional(), currency: z.string().optional(), assumptions: z.unknown().optional(), lines: z.array(z.unknown()).optional() });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;
  const denied = missingPermission(resolved, "accounting.write");
  if (denied) return denied;
  const ctx = actorFromResolved(resolved, { intentId: body.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  if (body.action === "undo" && body.scenarioId) return respond(await executor.execute("accounting.undoBudgetScenarioVersion", ctx, { scenarioId: body.scenarioId, previousScenarioId: body.previousScenarioId ?? null }));
  if (body.action === "save") return respond(await executor.execute("accounting.saveBudgetScenario", ctx, {
    scenarioKey: body.scenarioKey,
    name: body.name,
    fiscalYear: body.fiscalYear,
    currency: body.currency,
    assumptions: body.assumptions,
    lines: body.lines,
  }));
  return NextResponse.json({ error: "scenarioId is required" }, { status: 400 });
}
