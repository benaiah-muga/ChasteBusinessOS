import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, projects } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { missingPermission } from "@/server/route-guards";
import { getResolvedUser } from "@/server/session";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";
import { readGoProjects, type GoProjectsReadResult } from "@/server/projects-bridge";

const projectCollectionResponseSchema = z.object({
  projects: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    status: z.string().min(1),
    dueAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  }).strict()),
}).strict();

const projectBoardResponseSchema = z.object({
  columns: z.array(z.object({
    status: z.string().min(1),
    tasks: z.array(z.object({
      id: z.string().min(1),
      title: z.string(),
      parentTaskId: z.string().nullable(),
      priority: z.string().min(1),
      assigneeUserId: z.string().nullable(),
      dueAt: z.string().datetime().nullable(),
      position: z.number().int().nonnegative(),
    }).strict()),
  }).strict()),
}).strict();

function projectsReadUnavailable() {
  return NextResponse.json({ error: "projects service unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

async function projectsGoReadResponse(result: GoProjectsReadResult, projectId: string | null) {
  if (result.kind !== "response") return projectsReadUnavailable();

  try {
    const body: unknown = await result.response.json();
    const headers = { "Cache-Control": "no-store" };
    if (result.response.status === 200) {
      const schema = projectId ? projectBoardResponseSchema : projectCollectionResponseSchema;
      const parsed = schema.safeParse(body);
      if (!parsed.success) return projectsReadUnavailable();
      return NextResponse.json(parsed.data, { status: 200, headers });
    }
    if ([401, 403, 422].includes(result.response.status)) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return projectsReadUnavailable();
      return NextResponse.json(parsed.data, { status: result.response.status, headers });
    }
  } catch {
    return projectsReadUnavailable();
  }

  return projectsReadUnavailable();
}

async function runProjectsReadShadow(
  data: z.infer<typeof projectCollectionResponseSchema>,
  humanCtx: NonNullable<ReturnType<typeof actorFromResolved>>,
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
) {
  try {
    const result = await readGoProjects({ actionContext: humanCtx, session });
    const response = await projectsGoReadResponse(result, null);
    const candidate: unknown = await response.json();
    if (response.status !== 200 || JSON.stringify(candidate) !== JSON.stringify(data)) {
      console.warn("Go Projects collection shadow response did not match the legacy response");
    }
  } catch {
    console.warn("Go Projects collection shadow request failed");
  }
}

/**
 * GET lists the org's projects, or - with ?projectId= - returns one project's
 * board through the projects.listBoard capability (column/status shapes come
 * from the capability's output, not this route).
 */
export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const projectsDenied = missingPermission(resolved, "projects.read");
  if (projectsDenied) return projectsDenied;

  const projectId = new URL(req.url).searchParams.get("projectId");
  if (process.env.GO_PROJECTS_READ === "1") {
    const result = await readGoProjects({ actionContext: humanCtx, session: resolved, projectId: projectId || undefined });
    return projectsGoReadResponse(result, projectId);
  }

  const db = getDb().db;
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
  const data = {
    projects: rows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      dueAt: p.dueAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  };
  if (process.env.NODE_ENV === "development" && process.env.GO_PROJECTS_SHADOW === "1") {
    await runProjectsReadShadow(data, humanCtx, resolved);
  }
  return NextResponse.json(data);
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

type ProjectWrite =
  | { capabilityId: "projects.createProject"; input: { name: string; dueAt: string | undefined } }
  | {
      capabilityId: "projects.createTask";
      input: {
        projectId: string;
        title: string;
        parentTaskId: string | undefined;
        assigneeUserId: string | undefined;
        dueAt: string | undefined;
        priority: "low" | "medium" | "high" | undefined;
      };
    }
  | { capabilityId: "projects.assignTask"; input: { taskId: string; assigneeUserId: string | undefined } }
  | { capabilityId: "projects.moveTask"; input: { taskId: string; status: "todo" | "doing" | "done"; position: number | undefined } }
  | { capabilityId: "projects.archiveProject"; input: { projectId: string } };

function projectWrite(data: z.infer<typeof actionSchema>): ProjectWrite {
  if (data.action === "createProject") {
    return { capabilityId: "projects.createProject", input: { name: data.name, dueAt: data.dueAt } };
  }
  if (data.action === "createTask") {
    return {
      capabilityId: "projects.createTask",
      input: {
        projectId: data.projectId,
        title: data.title,
        parentTaskId: data.parentTaskId,
        assigneeUserId: data.assigneeUserId,
        dueAt: data.dueAt,
        priority: data.priority,
      },
    };
  }
  if (data.action === "assignTask") {
    return { capabilityId: "projects.assignTask", input: { taskId: data.taskId, assigneeUserId: data.assigneeUserId } };
  }
  if (data.action === "moveTask") {
    return { capabilityId: "projects.moveTask", input: { taskId: data.taskId, status: data.status, position: data.position } };
  }
  return { capabilityId: "projects.archiveProject", input: { projectId: data.projectId } };
}

const projectWriteOutputSchemas = {
  "projects.createProject": z.object({ projectId: z.string() }),
  "projects.createTask": z.object({ taskId: z.string() }),
  "projects.assignTask": z.object({ assigned: z.literal(true) }),
  "projects.moveTask": z.object({ moved: z.literal(true), status: z.string() }),
  "projects.archiveProject": z.object({ archived: z.literal(true) }),
} satisfies Record<ProjectWrite["capabilityId"], z.ZodType>;

function projectsUnavailable() {
  return NextResponse.json({ error: "projects service unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

async function projectsGoResponse(result: GoCapabilityBridgeResult, capabilityId: ProjectWrite["capabilityId"]) {
  if (result.kind !== "response") return projectsUnavailable();

  try {
    const body: unknown = await result.response.json();
    const headers = { "Cache-Control": "no-store" };
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: projectWriteOutputSchemas[capabilityId] }).safeParse(body);
      if (!parsed.success) return projectsUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { status: 200, headers });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return projectsUnavailable();
      return NextResponse.json(parsed.data, { status: 202, headers });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return projectsUnavailable();
      return NextResponse.json(parsed.data, { status: 422, headers });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return projectsUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 401, headers });
    }
    if (result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return projectsUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers });
    }
  } catch {
    return projectsUnavailable();
  }

  return projectsUnavailable();
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const humanCtx = resolved ? actorFromResolved(resolved, { intentId }) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.issues }, { status: 400 });

  if (process.env.GO_PROJECTS_WRITE === "1") {
    const write = projectWrite(body.data);
    let bridgeResult: GoCapabilityBridgeResult;
    try {
      bridgeResult = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: write.capabilityId,
        input: write.input,
      });
    } catch {
      return projectsUnavailable();
    }
    return projectsGoResponse(bridgeResult, write.capabilityId);
  }

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
