import { z } from "zod";

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.string().min(1),
  dueAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const ProjectListSchema = z.object({ projects: z.array(ProjectSchema) });

const BoardTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  parentTaskId: z.string().nullable(),
  priority: z.string().min(1),
  assigneeUserId: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  position: z.number().int().nonnegative(),
});

const BoardColumnSchema = z.object({ status: z.string().min(1), tasks: z.array(BoardTaskSchema) });
const ProjectBoardSchema = z.object({ columns: z.array(BoardColumnSchema) });

const ProjectMembersSchema = z.object({
  members: z.array(z.object({
    userId: z.string().min(1),
    name: z.string().nullable(),
    email: z.string().email(),
  })),
});

const ProjectModuleResponseSchema = z.object({
  catalog: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string(),
    href: z.string().nullable(),
    protected: z.boolean().optional(),
  })),
  enabledModules: z.array(z.string().min(1)),
  usingDefaults: z.boolean(),
});

const CreateProjectInputSchema = z.object({
  action: z.literal("createProject"),
  name: z.string().min(1).max(120),
  dueAt: z.string().datetime().optional(),
});
const CreateTaskInputSchema = z.object({
  action: z.literal("createTask"),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  parentTaskId: z.string().uuid().optional(),
  assigneeUserId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});
const AssignTaskInputSchema = z.object({
  action: z.literal("assignTask"),
  taskId: z.string().uuid(),
  assigneeUserId: z.string().uuid().optional(),
});
const MoveTaskInputSchema = z.object({
  action: z.literal("moveTask"),
  taskId: z.string().uuid(),
  status: z.enum(["todo", "doing", "done"]),
  position: z.number().int().nonnegative().optional(),
});
const ArchiveProjectInputSchema = z.object({
  action: z.literal("archiveProject"),
  projectId: z.string().uuid(),
});

export const ProjectActionSchema = z.discriminatedUnion("action", [
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  AssignTaskInputSchema,
  MoveTaskInputSchema,
  ArchiveProjectInputSchema,
]);

const ProjectActionResponseSchema = z.object({ ok: z.literal(true), data: z.unknown() });
const PendingProjectActionSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
});
const ApiErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

const ProjectActionOutputSchemas = {
  createProject: z.object({ projectId: z.string().min(1) }),
  createTask: z.object({ taskId: z.string().min(1) }),
  assignTask: z.object({ assigned: z.literal(true) }),
  moveTask: z.object({ moved: z.literal(true), status: z.string().min(1) }),
  archiveProject: z.object({ archived: z.literal(true) }),
} as const;

export type Project = z.infer<typeof ProjectSchema>;
export type BoardTask = z.infer<typeof BoardTaskSchema>;
export type BoardColumn = z.infer<typeof BoardColumnSchema>;
export type ProjectMember = z.infer<typeof ProjectMembersSchema>["members"][number];
export type ProjectAction = z.infer<typeof ProjectActionSchema>;

export type ProjectActionOutput<Action extends ProjectAction> = z.infer<typeof ProjectActionOutputSchemas[Action["action"]]>;

export type ProjectActionOutcome<Output> =
  | { kind: "completed"; data: Output }
  | { kind: "pending"; reason?: string };

export class ProjectsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProjectsApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(status: number, raw: unknown): string {
  const body = ApiErrorSchema.safeParse(raw);
  const serverMessage = body.success ? body.data.error ?? body.data.message : undefined;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to view or change projects.";
  if (status === 404) return "This project or task no longer exists. Refresh the board and try again.";
  if (status === 409) return "This project or task changed elsewhere. Refresh the board and try again.";
  if (status >= 500) return "The projects service is unavailable. Try again.";
  if (serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)) return serverMessage;
  return "The project request could not be completed. Check the details and try again.";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProjectsApiError(response.status, "The projects service returned an unreadable response.");
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ProjectsApiError(0, "The projects service took too long to respond. Try again.");
    }
    throw new ProjectsApiError(0, "Could not reach the projects service. Check your connection and try again.");
  }
  if (!response.ok) throw new ProjectsApiError(response.status, errorMessage(response.status, await readJson(response)));
  return readJson(response);
}

export async function fetchProjects(signal?: AbortSignal): Promise<Project[]> {
  const raw = await getJson("/api/projects", signal);
  const parsed = ProjectListSchema.safeParse(raw);
  if (!parsed.success) throw new ProjectsApiError(200, "The projects service returned data in an unexpected format.");
  return parsed.data.projects;
}

export async function fetchProjectBoard(projectId: string, signal?: AbortSignal): Promise<BoardColumn[]> {
  const parsedId = z.string().uuid().safeParse(projectId);
  if (!parsedId.success) throw new ProjectsApiError(0, "A valid project is required to load its board.");

  const query = new URLSearchParams({ projectId: parsedId.data });
  const parsed = ProjectBoardSchema.safeParse(await getJson(`/api/projects?${query.toString()}`, signal));
  if (!parsed.success) throw new ProjectsApiError(200, "The project board returned data in an unexpected format.");
  return parsed.data.columns;
}

export async function fetchProjectMembers(signal?: AbortSignal): Promise<ProjectMember[]> {
  try {
    const parsed = ProjectMembersSchema.safeParse(await getJson("/api/team", signal));
    return parsed.success ? parsed.data.members : [];
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

export async function fetchProjectsEnabled(signal?: AbortSignal): Promise<boolean> {
  const parsed = ProjectModuleResponseSchema.safeParse(await getJson("/api/modules", signal));
  if (!parsed.success) throw new ProjectsApiError(200, "The module switchboard returned data in an unexpected format.");

  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("projects")) throw new ProjectsApiError(200, "The module switchboard omitted the projects module.");
  if (parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new ProjectsApiError(200, "The module switchboard returned an unknown module.");
  }
  return parsed.data.enabledModules.includes("projects");
}

export async function submitProjectAction<Action extends ProjectAction>(
  action: Action,
  intentId: string = crypto.randomUUID(),
): Promise<ProjectActionOutcome<ProjectActionOutput<Action>>> {
  const parsedAction = ProjectActionSchema.safeParse(action);
  if (!parsedAction.success) throw new ProjectsApiError(0, "The project action contains invalid details.");
  if (!intentId.trim()) throw new ProjectsApiError(0, "The project action needs an intent identity. Try again.");

  const url = "/api/projects";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ...parsedAction.data, intentId }),
      signal: requestSignal(undefined, 20_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ProjectsApiError(0, "The project action took too long. Check the board before trying again.");
    }
    throw new ProjectsApiError(0, "Could not reach the projects service. Check your connection and try again.");
  }

  const raw = await readJson(response);
  if (response.status === 202) {
    const pending = PendingProjectActionSchema.safeParse(raw);
    if (pending.success) return { kind: "pending", reason: pending.data.reason };
    throw new ProjectsApiError(response.status, "The projects service returned an unexpected approval response.");
  }
  if (!response.ok) throw new ProjectsApiError(response.status, errorMessage(response.status, raw));

  const envelope = ProjectActionResponseSchema.safeParse(raw);
  if (!envelope.success) throw new ProjectsApiError(response.status, "The projects service returned an unexpected action response.");
  const output = ProjectActionOutputSchemas[parsedAction.data.action].safeParse(envelope.data.data);
  if (!output.success) throw new ProjectsApiError(response.status, "The projects service returned an unexpected action result.");
  return { kind: "completed", data: output.data as ProjectActionOutput<Action> };
}
