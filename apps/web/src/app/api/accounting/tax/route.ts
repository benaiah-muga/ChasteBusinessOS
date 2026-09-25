import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, salesTaxFilings, taxCodes, taxProfiles, taxReturns } from "@chaste/db";
import { buildExecutor, buildRegistry, actorFromResolved } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "accounting.read");
  if (denied) return denied;
  const db = getDb().db;
  const [profiles, codes, allReturns, settlements] = await Promise.all([
    db.select().from(taxProfiles).where(eq(taxProfiles.orgId, resolved.orgId)).limit(1),
    db.select().from(taxCodes).where(eq(taxCodes.orgId, resolved.orgId)).orderBy(desc(taxCodes.active), desc(taxCodes.createdAt)),
    db.select().from(taxReturns).where(eq(taxReturns.orgId, resolved.orgId)).orderBy(desc(taxReturns.createdAt)).limit(500),
    db.select().from(salesTaxFilings).where(eq(salesTaxFilings.orgId, resolved.orgId)).orderBy(desc(salesTaxFilings.createdAt)).limit(20),
  ]);
  const returnById = new Map(allReturns.map((row) => [row.id, row]));
  const visibleReturns = allReturns.slice(0, 50);
  const activeAmendmentParents = new Set(allReturns.filter((candidate) => candidate.status !== "cancelled" && candidate.amendsReturnId).map((candidate) => candidate.amendsReturnId!));
  const settlementDeltaFor = (row: (typeof allReturns)[number]): { outputMinor: number; inputMinor: number; netMinor: number } | null => {
    let parentId = row.amendsReturnId;
    const visited = new Set<string>();
    let baselineOutput = 0;
    let baselineInput = 0;
    while (parentId) {
      if (visited.has(parentId)) return null;
      visited.add(parentId);
      const parent = returnById.get(parentId);
      if (!parent) return null;
      if (parent.settlementEntryId) {
        baselineOutput = Number(parent.outputTaxMinor);
        baselineInput = Number(parent.inputTaxMinor);
        break;
      }
      parentId = parent.amendsReturnId;
    }
    const outputMinor = Number(row.outputTaxMinor) - baselineOutput;
    const inputMinor = Number(row.inputTaxMinor) - baselineInput;
    return { outputMinor, inputMinor, netMinor: outputMinor - inputMinor };
  };
  return NextResponse.json({
    profile: profiles[0] ? { jurisdictionCode: profiles[0].jurisdictionCode, registrationNumber: profiles[0].registrationNumber, filingFrequency: profiles[0].filingFrequency, providerMode: profiles[0].providerMode } : null,
    codes: codes.map((code) => ({ id: code.id, code: code.code, name: code.name, jurisdictionCode: code.jurisdictionCode, direction: code.direction, rateBasisPoints: code.rateBasisPoints, priceIncludesTax: code.priceIncludesTax, recoverable: code.recoverable, active: code.active })),
    returns: visibleReturns.map((row) => ({
      id: row.id,
      jurisdictionCode: row.jurisdictionCode,
      periodFrom: row.periodFrom.toISOString().slice(0, 10),
      periodTo: new Date(row.periodTo.getTime() - 86_400_000).toISOString().slice(0, 10),
      currency: row.currency,
      outputTaxMinor: Number(row.outputTaxMinor),
      inputTaxMinor: Number(row.inputTaxMinor),
      taxMinor: Number(row.taxMinor),
      taxBreakdown: row.taxBreakdown,
      status: row.status,
      submissionReference: row.submissionReference,
      acknowledgment: row.acknowledgment,
      evidenceReference: row.evidenceReference,
      amendsReturnId: row.amendsReturnId,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      settledAt: row.settledAt?.toISOString() ?? null,
      settlementEntryId: row.settlementEntryId,
      settlementDelta: settlementDeltaFor(row),
      hasActiveAmendment: activeAmendmentParents.has(row.id),
    })),
    settlements: settlements.map((row) => ({ id: row.id, taxReturnId: row.taxReturnId, periodFrom: row.periodFrom.toISOString().slice(0, 10), periodTo: new Date(row.periodTo.getTime() - 1).toISOString().slice(0, 10), taxMinor: Number(row.taxMinor), settledAt: row.createdAt.toISOString() })),
  });
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("report"), intentId: z.string().optional(), from: z.string(), to: z.string() }),
  z.object({ action: z.literal("profile"), intentId: z.string().optional(), jurisdictionCode: z.string(), registrationNumber: z.string().optional(), filingFrequency: z.enum(["monthly", "quarterly", "annual"]) }),
  z.object({ action: z.literal("removeProfile"), intentId: z.string().optional(), profileId: z.string().uuid() }),
  z.object({ action: z.literal("createCode"), intentId: z.string().optional(), code: z.string(), name: z.string(), direction: z.enum(["output", "input"]), rateBasisPoints: z.number().int(), priceIncludesTax: z.boolean(), recoverable: z.boolean() }),
  z.object({ action: z.literal("archiveCode"), intentId: z.string().optional(), taxCodeId: z.string().uuid() }),
  z.object({ action: z.literal("activateCode"), intentId: z.string().optional(), taxCodeId: z.string().uuid() }),
  z.object({ action: z.literal("prepare"), intentId: z.string().optional(), periodFrom: z.string(), periodTo: z.string(), amendsReturnId: z.string().uuid().optional() }),
  z.object({ action: z.literal("submit"), intentId: z.string().optional(), taxReturnId: z.string().uuid(), submissionReference: z.string(), evidenceReference: z.string() }),
  z.object({ action: z.literal("acknowledge"), intentId: z.string().optional(), taxReturnId: z.string().uuid(), status: z.enum(["accepted", "rejected", "unknown"]), acknowledgmentReference: z.string().optional(), details: z.string().optional(), evidenceReference: z.string().optional() }),
  z.object({ action: z.literal("amend"), intentId: z.string().optional(), taxReturnId: z.string().uuid() }),
  z.object({ action: z.literal("cancelDraft"), intentId: z.string().optional(), taxReturnId: z.string().uuid() }),
  z.object({ action: z.literal("settle"), intentId: z.string().optional(), taxReturnId: z.string().uuid() }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;
  const writePermission = body.action === "report" ? "accounting.read"
    : ["profile", "removeProfile", "createCode", "archiveCode", "activateCode", "acknowledge"].includes(body.action) ? "accounting.admin"
    : ["submit", "settle"].includes(body.action) ? "accounting.post"
    : "accounting.write";
  const denied = missingPermission(resolved, writePermission);
  if (denied) return denied;
  const ctx = actorFromResolved(resolved, { intentId: body.intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  switch (body.action) {
    case "report": return respond(await executor.execute("accounting.salesTaxReport", ctx, { from: body.from, to: body.to }));
    case "profile": return respond(await executor.execute("accounting.createTaxProfile", ctx, { jurisdictionCode: body.jurisdictionCode, registrationNumber: body.registrationNumber, filingFrequency: body.filingFrequency }));
    case "removeProfile": return respond(await executor.execute("accounting.removeTaxProfile", ctx, { profileId: body.profileId }));
    case "createCode": return respond(await executor.execute("accounting.createTaxCode", ctx, { code: body.code, name: body.name, direction: body.direction, rateBasisPoints: body.rateBasisPoints, priceIncludesTax: body.priceIncludesTax, recoverable: body.recoverable }));
    case "archiveCode": return respond(await executor.execute("accounting.archiveTaxCode", ctx, { taxCodeId: body.taxCodeId }));
    case "activateCode": return respond(await executor.execute("accounting.activateTaxCode", ctx, { taxCodeId: body.taxCodeId }));
    case "prepare": return respond(await executor.execute("accounting.createTaxReturn", ctx, { periodFrom: body.periodFrom, periodTo: body.periodTo, amendsReturnId: body.amendsReturnId }));
    case "submit": return respond(await executor.execute("accounting.recordTaxReturnSubmission", ctx, { taxReturnId: body.taxReturnId, submissionReference: body.submissionReference, evidenceReference: body.evidenceReference }));
    case "acknowledge": return respond(await executor.execute("accounting.recordTaxReturnAcknowledgment", ctx, { taxReturnId: body.taxReturnId, status: body.status, acknowledgmentReference: body.acknowledgmentReference, details: body.details, evidenceReference: body.evidenceReference }));
    case "amend": return respond(await executor.execute("accounting.createTaxReturnAmendment", ctx, { taxReturnId: body.taxReturnId }));
    case "cancelDraft": return respond(await executor.execute("accounting.cancelTaxReturnDraft", ctx, { taxReturnId: body.taxReturnId }));
    case "settle": return respond(await executor.execute("accounting.fileSalesTaxReturn", ctx, { taxReturnId: body.taxReturnId }));
  }
}
