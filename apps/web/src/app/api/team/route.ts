import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

const teamMembersSchema = z.object({
  members: z.array(z.object({
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    roleKeys: z.array(z.string()),
  }).strict()),
  roles: z.array(z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    isSystem: z.boolean(),
    permissions: z.array(z.string()),
  }).strict()),
}).strict();

const goActionOutputSchemas = {
  "iam.createRole": z.object({ roleId: z.string() }).strict(),
  "iam.updateRolePermissions": z.object({ permissionCount: z.number() }).strict(),
  "iam.assignRole": z.object({ assigned: z.boolean() }).strict(),
  "iam.inviteMember": z.object({ invitationId: z.string(), token: z.string(), expiresAt: z.string() }).strict(),
} as const;

function teamGoUnavailable() {
  return NextResponse.json(
    { error: "team service unavailable; check team status before retrying" },
    { status: 503, headers: noStore },
  );
}

async function goResponseBody(result: GoCapabilityBridgeResult): Promise<{ status: number; body: unknown } | null> {
  if (result.kind !== "response") return null;
  try {
    return { status: result.response.status, body: await result.response.json() };
  } catch {
    return null;
  }
}

async function teamGoListResponse(result: GoCapabilityBridgeResult, catalog: string[]) {
  const dispatched = await goResponseBody(result);
  if (!dispatched) return teamGoUnavailable();
  if (dispatched.status === 200) {
    const parsed = z.object({ ok: z.literal(true), data: teamMembersSchema, replayed: z.boolean().optional() }).safeParse(dispatched.body);
    if (!parsed.success) return teamGoUnavailable();
    return NextResponse.json({ ...parsed.data.data, catalog }, { headers: noStore });
  }
  if (dispatched.status === 401) {
    const parsed = z.object({ error: z.string() }).safeParse(dispatched.body);
    if (!parsed.success) return teamGoUnavailable();
    return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
  }
  if ([400, 403, 422].includes(dispatched.status)) {
    const parsed = dispatched.status === 422
      ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(dispatched.body)
      : z.object({ error: z.string() }).safeParse(dispatched.body);
    if (!parsed.success) return teamGoUnavailable();
    return NextResponse.json({ error: parsed.data.error }, { status: 422, headers: noStore });
  }
  return teamGoUnavailable();
}

async function teamGoActionResponse(result: GoCapabilityBridgeResult, capabilityId: keyof typeof goActionOutputSchemas) {
  const dispatched = await goResponseBody(result);
  if (!dispatched) return teamGoUnavailable();
  if (dispatched.status === 200) {
    const parsed = z.object({
      ok: z.literal(true),
      data: goActionOutputSchemas[capabilityId],
      replayed: z.boolean().optional(),
    }).safeParse(dispatched.body);
    if (!parsed.success) return teamGoUnavailable();
    return NextResponse.json({ ok: true, data: parsed.data.data }, { headers: noStore });
  }
  if (dispatched.status === 202) {
    const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(dispatched.body);
    if (!parsed.success) return teamGoUnavailable();
    return NextResponse.json(
      { ok: false, pendingApproval: true, reason: parsed.data.reason },
      { status: 202, headers: noStore },
    );
  }
  if (dispatched.status === 401) {
    const parsed = z.object({ error: z.string() }).safeParse(dispatched.body);
    if (!parsed.success) return teamGoUnavailable();
    return NextResponse.json({ error: parsed.data.error }, { status: 401, headers: noStore });
  }
  if ([400, 403, 422].includes(dispatched.status)) {
    const parsed = dispatched.status === 422
      ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(dispatched.body)
      : z.object({ error: z.string() }).safeParse(dispatched.body);
    if (!parsed.success) return teamGoUnavailable();
    return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
  }
  return teamGoUnavailable();
}

interface Member {
  userId: string;
  name: string | null;
  email: string;
  roleKeys: string[];
}
interface Role {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

/** Members, roles with permissions, plus the capability permission catalog. */
export async function GET() {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb().db;
  const registry = buildRegistry(db);
  if (process.env.GO_IAM_TEAM === "1") {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: "iam.listMembers",
        input: {},
      });
      const catalog = [...new Set(registry.all().map((capability) => capability.permission))].sort();
      return teamGoListResponse(result, catalog);
    } catch {
      return teamGoUnavailable();
    }
  }

  const executor = buildExecutor(db, registry);
  const result = await executor.execute("iam.listMembers", humanCtx, {});
  if (!result.ok || !result.data) return NextResponse.json({ error: result.error ?? "failed" }, { status: 422 });
  const membersData = result.data as { members: Member[]; roles: Role[] };

  return NextResponse.json({
    members: membersData.members,
    roles: membersData.roles,
    catalog: [...new Set(registry.all().map((capability) => capability.permission))].sort(),
  });
}

const teamIntentIdSchema = z.string().refine((value) =>
  value.trim().length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value),
);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createRole"),
    key: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(60),
    intentId: teamIntentIdSchema,
  }),
  z.object({
    action: z.literal("setPermissions"),
    roleId: z.string(),
    permissions: z.array(z.string().min(1)).max(200),
    intentId: teamIntentIdSchema,
  }),
  z.object({
    action: z.literal("assignRole"),
    userId: z.string(),
    roleId: z.string(),
    intentId: teamIntentIdSchema,
  }),
  z.object({
    action: z.literal("invite"),
    email: z.string().email(),
    roleId: z.string(),
    intentId: teamIntentIdSchema,
  }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const body = actionSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const humanCtx = actorFromResolved(resolved, { intentId: body.data.intentId });
  if (!humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb().db;
  const registry = buildRegistry(db);

  let capId: keyof typeof goActionOutputSchemas;
  let input: unknown;
  switch (body.data.action) {
    case "createRole":
      capId = "iam.createRole";
      input = { key: body.data.key, name: body.data.name };
      break;
    case "setPermissions":
      capId = "iam.updateRolePermissions";
      input = { roleId: body.data.roleId, permissions: body.data.permissions };
      break;
    case "assignRole":
      capId = "iam.assignRole";
      input = { userId: body.data.userId, roleId: body.data.roleId };
      break;
    case "invite":
      capId = "iam.inviteMember";
      input = { email: body.data.email, roleId: body.data.roleId };
      break;
  }

  if (process.env.GO_IAM_TEAM === "1") {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: capId,
        input,
      });
      return teamGoActionResponse(result, capId);
    } catch {
      return teamGoUnavailable();
    }
  }

  const executor = buildExecutor(db, registry);
  const result = await executor.execute(capId, humanCtx, input);
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
