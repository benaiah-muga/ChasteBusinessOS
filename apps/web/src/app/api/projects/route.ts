import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, projects } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * GET lists the org's projects, or — with ?projectId= — returns one project's
 * board through the projects.listBoard capability (column/status shapes come
 * from the capability's output, not this route).
 */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb().db;
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (projectId) {
    const result = await buildExecutor(db, buildRegistry(db)).execute("projects.listBoard", humanCtx, { projectId });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
    return NextResponse.json(result.data);
  }

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      dueAt: projects.dueAt,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.orgId, resolved.orgId))
    .orderBy(desc(projects.createdAt))
    .limit(50);
  return NextResponse.json({
    projects: rows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      dueAt: p.dueAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createProject"),
    name: z.string().min(1).max(120),
    dueAt: z.string().datetime().optional(),
  }),
  z.object({
    action: z.literal("createTask"),
    projectId: z.string().uuid(),
    title: z.string().min(1).max(200),
    parentTaskId: z.string().uuid().optional(),
    assigneeUserId: z.string().uuid().optional(),
    dueAt: z.string().datetime().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
  }),
  z.object({
    action: z.literal("assignTask"),
    taskId: z.string().uuid(),
    // Omitted (or empty on the wire) clears the assignment inside the capability.
    assigneeUserId: z.string().uuid().optional(),
  }),
  z.object({
    action: z.literal("moveTask"),
    taskId: z.string().uuid(),
    status: z.enum(["todo", "doing", "done"]),
    position: z.number().int().nonnegative().optional(),
  }),
  z.object({
    action: z.literal("archiveProject"),
    projectId: z.string().uuid(),
  }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.issues }, { status: 400 });

  const executor = buildExecutor(getDb().db, buildRegistry(getDb().db));
  let result;
  if (body.data.action === "createProject") {
    result = await executor.execute("projects.createProject", humanCtx, {
      name: body.data.name,
      dueAt: body.data.dueAt,
    });
  } else if (body.data.action === "createTask") {
    result = await executor.execute("projects.createTask", humanCtx, {
      projectId: body.data.projectId,
      title: body.data.title,
      parentTaskId: body.data.parentTaskId,
      assigneeUserId: body.data.assigneeUserId,
      dueAt: body.data.dueAt,
      priority: body.data.priority,
    });
  } else if (body.data.action === "assignTask") {
    result = await executor.execute("projects.assignTask", humanCtx, {
      taskId: body.data.taskId,
      assigneeUserId: body.data.assigneeUserId,
    });
  } else if (body.data.action === "moveTask") {
    result = await executor.execute("projects.moveTask", humanCtx, {
      taskId: body.data.taskId,
      status: body.data.status,
      position: body.data.position,
    });
  } else {
    result = await executor.execute("projects.archiveProject", humanCtx, {
      projectId: body.data.projectId,
    });
  }

  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}