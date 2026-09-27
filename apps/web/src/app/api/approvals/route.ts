import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { approvals, documents, getDb, users } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { decideApproval } from "@/server/approvals";
import { decideGoApproval } from "@/server/go-bridge";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const registry = buildRegistry(db);

  const [rows, historyRows] = await Promise.all([
    db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, resolved.orgId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt))
    .limit(100),
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orgId, resolved.orgId), inArray(approvals.status, ["approved", "executed", "rejected", "expired"])))
      .orderBy(desc(approvals.decidedAt))
      .limit(25),
  ]);

  // Attribution: whose action is waiting. The actor id doubles as the
  // on-behalf user for agent-raised requests (the workmate acts as the
  // human it works for); a sessionId marks the action as agent-originated.
  const allRows = [...rows, ...historyRows];
  const requesterIds = [...new Set(allRows.flatMap((row) => [row.requestedByUserId, row.decidedByUserId]).filter((value): value is string => Boolean(value)))];
  const namesById = requesterIds.length
    ? new Map(
        (
          await db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
        )
          .filter((u) => requesterIds.includes(u.id))
          .map((u) => [u.id, u.name ?? u.email]),
      )
    : new Map<string, string>();

  // Authority filter: you may only see (and decide) gates for capabilities
  // your own permissions cover. An accountant never sees IAM requests.
  const visible = allRows.filter((r) => {
    const cap = registry.get(r.capabilityId);
    return cap ? hasPermissionFor({ permissions: resolved.permissions }, cap.permission) : false;
  });
  const documentIds = [...new Set(visible.flatMap((approval) => collectDocumentIds(approval.payload)))];
  const relatedDocuments = documentIds.length
    ? await db.select({ id: documents.id, title: documents.title }).from(documents).where(and(eq(documents.orgId, resolved.orgId), inArray(documents.id, documentIds)))
    : [];
  const documentById = new Map(relatedDocuments.map((document) => [document.id, document]));
  const present = (approval: (typeof visible)[number]) => ({
    ...approval,
    createdAt: approval.createdAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    raisedBy: {
      name: (approval.requestedByUserId && namesById.get(approval.requestedByUserId)) || "Unknown",
      kind: approval.sessionId ? ("agent" as const) : ("human" as const),
    },
    decidedBy: approval.decidedByUserId ? namesById.get(approval.decidedByUserId) ?? "Unknown" : null,
    relatedDocuments: collectDocumentIds(approval.payload).flatMap((id) => {
      const document = documentById.get(id);
      return document ? [document] : [];
    }),
  });
  return NextResponse.json({
    approvals: visible.filter((approval) => approval.status === "pending").map(present),
    history: visible.filter((approval) => approval.status !== "pending").map(present),
  });
}

function collectDocumentIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectDocumentIds);
  const record = value as Record<string, unknown>;
  const ids = Object.entries(record).flatMap(([key, entry]) => {
    if (["documentId", "sourceDocumentId"].includes(key) && typeof entry === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry)) return [entry];
    return entry && typeof entry === "object" ? collectDocumentIds(entry) : [];
  });
  return [...new Set(ids)];
}

const decideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = decideSchema.safeParse(await req.json());
  const approvalId = new URL(req.url).searchParams.get("id");
  if (!body.success || !approvalId) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const db = getDb().db;
  if (process.env.GO_APPROVAL_DECISION === "1") {
    const [approval] = await db
      .select({ capabilityId: approvals.capabilityId, payload: approvals.payload })
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, resolved.orgId)))
      .limit(1);
    if (!approval) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

    const actionContext = actorFromResolved(resolved, {});
    if (!actionContext) return NextResponse.json({ ok: false, error: "onboarding required" }, { status: 428 });

    const outcome = await decideGoApproval(
      {
        actionContext,
        session: {
          userId: resolved.userId,
          orgId: resolved.orgId,
          authSessionId: resolved.authSessionId,
        },
        approvalId,
        capabilityId: approval.capabilityId,
        input: approval.payload,
        decision: body.data.decision,
        comment: body.data.comment,
      },
    );
    if (outcome.kind === "not-dispatched") {
      return NextResponse.json({ ok: false, error: "approval decision service unavailable" }, { status: 503 });
    }
    if (outcome.kind === "outcome-unknown") {
      return NextResponse.json(
        { ok: false, error: "approval decision outcome unknown; refresh before retrying" },
        { status: 503 },
      );
    }
    return outcome.response;
  }

  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // The decision pipeline lives in @/server/approvals so it can be tested
  // directly; it claims the gate atomically before executing (no double-fire).
  const outcome = await decideApproval(db, executor, registry, resolved, {
    approvalId,
    decision: body.data.decision,
    comment: body.data.comment,
  });
  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: outcome.code });
  }
  if (outcome.status === "rejected") {
    return NextResponse.json({ ok: true, status: "rejected" });
  }
  return NextResponse.json({ ok: true, status: outcome.status, result: outcome.result });
}
