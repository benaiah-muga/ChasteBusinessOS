import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

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
  const executor = buildExecutor(db, buildRegistry(db));
  const result = await executor.execute("iam.listMembers", humanCtx, {});
  if (!result.ok || !result.data) return NextResponse.json({ error: result.error ?? "failed" }, { status: 422 });
  const membersData = result.data as { members: Member[]; roles: Role[] };

  return NextResponse.json({
    members: membersData.members,
    roles: membersData.roles,
    catalog: [...new Set(buildRegistry(db).all().map((c) => c.permission))].sort(),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createRole"),
    key: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(60),
  }),
  z.object({
    action: z.literal("setPermissions"),
    roleId: z.string(),
    permissions: z.array(z.string().min(1)).max(200),
  }),
  z.object({
    action: z.literal("assignRole"),
    userId: z.string(),
    roleId: z.string(),
  }),
  z.object({
    action: z.literal("invite"),
    email: z.string().email(),
    roleId: z.string(),
  }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  let capId: string;
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

  const result = await executor.execute(capId, humanCtx, input);
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
