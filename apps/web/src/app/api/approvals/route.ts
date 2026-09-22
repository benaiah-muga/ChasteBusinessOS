import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { approvals, getDb, users } from "@chaste/db";
import { buildExecutor, buildRegistry, hasPermissionFor } from "@/server/kernel";
import { decideApproval } from "@/server/approvals";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb().db;
  const registry = buildRegistry(db);

  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, resolved.orgId), eq(approvals.status, "pending")))
    .limit(100);

  // Attribution: whose action is waiting. The actor id doubles as the
  // on-behalf user for agent-raised requests (the workmate acts as the
  // human it works for); a sessionId marks the action as agent-originated.
  const requesterIds = [...new Set(rows.map((r) => r.requestedByUserId).filter((v): v is string => Boolean(v)))];
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
  const visible = rows.filter((r) => {
    const cap = registry.get(r.capabilityId);
    return cap ? hasPermissionFor({ permissions: resolved.permissions }, cap.permission) : false;
  });
  return NextResponse.json({
    approvals: visible.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      raisedBy: {
        name: (a.requestedByUserId && namesById.get(a.requestedByUserId)) || "Unknown",
        kind: a.sessionId ? ("agent" as const) : ("human" as const),
      },
    })),
  });
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
