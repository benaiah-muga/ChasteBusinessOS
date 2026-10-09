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
  createProject: z.object({ projectId: z.string().uuid() }).strict(),
  createTask: z.object({
    taskId: z.string().uuid(), projectId: z.string().uuid().optional(), title: z.string().optional(),
    parentTaskId: z.string().uuid().nullable().optional(), status: z.enum(["todo", "doing", "done"]).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(), assigneeUserId: z.string().uuid().nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(), position: z.number().int().nonnegative().optional(),
    note: z.string().nullable().optional(), createdAt: z.string().datetime().optional(),
  }).strict(),
  assignTask: z.object({
    assigned: z.literal(true), taskId: z.string().uuid().optional(),
    restoreAssigneeUserId: z.string().uuid().nullable().optional(), expectedAssigneeUserId: z.string().uuid().nullable().optional(),
  }).strict(),
  moveTask: z.object({
    moved: z.literal(true), status: z.enum(["todo", "doing", "done"]), position: z.number().int().nonnegative().optional(),
    taskId: z.string().uuid().optional(), restoreStatus: z.enum(["todo", "doing", "done"]).optional(),
    restorePosition: z.number().int().nonnegative().optional(), expectedStatus: z.enum(["todo", "doing", "done"]).optional(),
    expectedPosition: z.number().int().nonnegative().optional(),
  }).strict(),
  archiveProject: z.object({ archived: z.literal(true), projectId: z.string().uuid().optional() }).strict(),
} as const;

const PROJECT_ATTEMPT_PREFIX = "chaste:projects:go:attempt:v1:";
const ProjectAttemptSchema = z.object({
  fingerprint: z.string().length(64),
  intentId: z.string().uuid(),
  action: ProjectActionSchema,
}).strict();

type ProjectAttempt = PendingProjectAction & { storageKey: string; fingerprint: string };

function goProjectsWritesSelected(): boolean {
  return typeof __GO_PROJECTS_WRITES__ !== "undefined" && __GO_PROJECTS_WRITES__;
}

function projectCapabilityInput(action: ProjectAction): Record<string, unknown> {
  const { action: _action, ...input } = action;
  return input;
}

async function projectDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function projectScope(scope: ProjectsRetryScope): Promise<{ actorId: string; organizationId: string; hash: string }> {
  const actorId = scope.actorId?.trim() ?? "";
  const organizationId = scope.organizationId?.trim() ?? "";
  if (!z.string().uuid().safeParse(actorId).success || !z.string().uuid().safeParse(organizationId).success) {
    throw new ProjectsApiError(0, "Wait for your account and organization to finish loading before changing projects.");
  }
  try {
    return { actorId, organizationId, hash: await projectDigest(JSON.stringify({ actorId, organizationId })) };
  } catch {
    throw new ProjectsApiError(0, "Project retry protection is unavailable. Check browser security settings and try again.");
  }
}

function parseProjectAttempt(raw: string, storageKey: string): ProjectAttempt {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new ProjectsApiError(0, "A saved project retry marker is damaged. Check the project board before submitting another change.", true); }
  const parsed = ProjectAttemptSchema.safeParse(value);
  if (!parsed.success) throw new ProjectsApiError(0, "A saved project retry marker is invalid. Check the project board before submitting another change.", true);
  return { ...parsed.data, storageKey };
}

async function createProjectAttempt(action: ProjectAction, scope: ProjectsRetryScope, retry?: PendingProjectAction): Promise<ProjectAttempt> {
  const scoped = await projectScope(scope);
  const fingerprint = await projectDigest(JSON.stringify({ actorId: scoped.actorId, organizationId: scoped.organizationId, action }));
  if (retry) {
    const prefix = `${PROJECT_ATTEMPT_PREFIX}${scoped.hash}:`;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const candidate = parseProjectAttempt(window.localStorage.getItem(key) ?? "", key);
      if (candidate.intentId === retry.intentId && candidate.fingerprint === fingerprint && JSON.stringify(candidate.action) === JSON.stringify(action)) return candidate;
    }
    throw new ProjectsApiError(0, "The saved project action could not be verified. Check the board before trying again.", true);
  }
  const prefix = `${PROJECT_ATTEMPT_PREFIX}${scoped.hash}:`;
  const storageKey = `${prefix}${fingerprint}`;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const candidate = parseProjectAttempt(window.localStorage.getItem(key) ?? "", key);
      if (candidate.fingerprint === fingerprint && JSON.stringify(candidate.action) === JSON.stringify(action)) return candidate;
    }
    const attempt = { storageKey, fingerprint, intentId: crypto.randomUUID(), action };
    window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, intentId: attempt.intentId, action }));
    const persisted = parseProjectAttempt(window.localStorage.getItem(storageKey) ?? "", storageKey);
    if (persisted.fingerprint !== fingerprint || persisted.intentId !== attempt.intentId) throw new Error("attempt did not persist");
    return persisted;
  } catch (error) {
    if (error instanceof ProjectsApiError) throw error;
    throw new ProjectsApiError(0, "Enable browser storage before changing projects so an uncertain action can be retried safely.");
  }
}

function clearProjectAttempt(attempt: ProjectAttempt): void {
  try {
    const saved = parseProjectAttempt(window.localStorage.getItem(attempt.storageKey) ?? "", attempt.storageKey);
    if (saved.fingerprint === attempt.fingerprint && saved.intentId === attempt.intentId) window.localStorage.removeItem(attempt.storageKey);
  } catch { /* Retain the marker when storage cannot verify its identity. */ }
}

export async function readPendingProjectActions(scope: ProjectsRetryScope): Promise<PendingProjectAction[]> {
  if (!goProjectsWritesSelected()) return [];
  return listProjectAttempts(scope);
}

async function listProjectAttempts(scope: ProjectsRetryScope): Promise<PendingProjectAction[]> {
  const scoped = await projectScope(scope);
  const prefix = `${PROJECT_ATTEMPT_PREFIX}${scoped.hash}:`;
  const pending: PendingProjectAction[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const attempt = parseProjectAttempt(window.localStorage.getItem(key) ?? "", key);
      const fingerprint = await projectDigest(JSON.stringify({ actorId: scoped.actorId, organizationId: scoped.organizationId, action: attempt.action }));
      if (fingerprint !== attempt.fingerprint) throw new ProjectsApiError(0, "A saved project retry marker does not match its action. Check the board before retrying.", true);
      pending.push({ action: attempt.action, intentId: attempt.intentId });
    }
  } catch (error) {
    if (error instanceof ProjectsApiError) throw error;
    throw new ProjectsApiError(0, "Enable browser storage to check for unresolved project actions.");
  }
  return pending;
}

function hasSavedProjectAttempts(): boolean {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      if (window.localStorage.key(index)?.startsWith(PROJECT_ATTEMPT_PREFIX)) return true;
    }
    return false;
  } catch {
    throw new ProjectsApiError(0, "Project retry state is unavailable. Enable browser storage before submitting changes.", true);
  }
}

export type Project = z.infer<typeof ProjectSchema>;
export type BoardTask = z.infer<typeof BoardTaskSchema>;
export type BoardColumn = z.infer<typeof BoardColumnSchema>;
export type ProjectMember = z.infer<typeof ProjectMembersSchema>["members"][number];
export type ProjectAction = z.infer<typeof ProjectActionSchema>;

export type ProjectsRetryScope = { actorId: string | null; organizationId: string | null };
export type PendingProjectAction = { action: ProjectAction; intentId: string };

export type ProjectActionOutput<Action extends ProjectAction> = z.infer<typeof ProjectActionOutputSchemas[Action["action"]]>;

export type ProjectActionOutcome<Output> =
  | { kind: "completed"; data: Output }
  | { kind: "pending"; reason?: string };

export class ProjectsApiError extends Error {
  constructor(readonly status: number, message: string, readonly mayHaveReachedServer = false) {
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
  retryScopeOrLegacyIntent: ProjectsRetryScope | string = { actorId: null, organizationId: null },
  retry?: PendingProjectAction,
): Promise<ProjectActionOutcome<ProjectActionOutput<Action>>> {
  const parsedAction = ProjectActionSchema.safeParse(action);
  if (!parsedAction.success) throw new ProjectsApiError(0, "The project action contains invalid details.");
  const retryScope = typeof retryScopeOrLegacyIntent === "string"
    ? { actorId: null, organizationId: null }
    : retryScopeOrLegacyIntent;
  const goSelected = typeof __GO_PROJECTS_WRITES__ !== "undefined" && __GO_PROJECTS_WRITES__;
  if (goSelected && typeof retryScopeOrLegacyIntent === "string") {
    throw new ProjectsApiError(0, "Wait for your account and organization to finish loading before changing projects.");
  }
  if (!goSelected) {
    const hasScopedAttempts = retryScope.actorId && retryScope.organizationId
      ? (await listProjectAttempts(retryScope)).length > 0
      : hasSavedProjectAttempts();
    if (hasScopedAttempts) {
      throw new ProjectsApiError(0, "A Go project action has an unresolved result. Restore the Go Projects route and retry that exact action before using a different route.", true);
    }
  }
  const attempt = goSelected ? await createProjectAttempt(parsedAction.data, retryScope, retry) : null;
  const intentId = attempt?.intentId ?? retry?.intentId ?? (typeof retryScopeOrLegacyIntent === "string" ? retryScopeOrLegacyIntent : crypto.randomUUID());
  if (!intentId.trim()) throw new ProjectsApiError(0, "The project action needs an intent identity. Try again.");
  const capabilityIDs: Record<ProjectAction["action"], string> = {
    createProject: "projects.createProject",
    archiveProject: "projects.archiveProject",
    createTask: "projects.createTask",
    moveTask: "projects.moveTask",
    assignTask: "projects.assignTask",
  };
  const url = goSelected ? "/api/capabilities/execute" : "/api/projects";
  const body = goSelected
    ? { capabilityId: capabilityIDs[parsedAction.data.action], input: projectCapabilityInput(parsedAction.data), intentId }
    : { ...parsedAction.data, intentId };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal(undefined, 20_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ProjectsApiError(0, "The project action took too long. Check the board before trying again.", goSelected);
    }
    throw new ProjectsApiError(0, "Could not reach the projects service. Check your connection and try again.", goSelected);
  }

  let raw: unknown;
  try { raw = await readJson(response); }
  catch (error) {
    if (attempt) throw new ProjectsApiError(response.status, errorMessage(response.status, null), true);
    throw error;
  }
  if (response.status === 202) {
    const pending = PendingProjectActionSchema.safeParse(raw);
    if (pending.success) return { kind: "pending", reason: pending.data.reason };
    throw new ProjectsApiError(response.status, "The projects service returned an unexpected approval response.", Boolean(attempt));
  }
  if (!response.ok) {
    const mayHaveReachedServer = Boolean(attempt) && (response.status === 404 || response.status >= 500 || response.status === 408 || response.status === 429);
    if (attempt && !mayHaveReachedServer) clearProjectAttempt(attempt);
    throw new ProjectsApiError(response.status, errorMessage(response.status, raw), mayHaveReachedServer);
  }

  const envelope = goSelected
    ? z.object({ ok: z.literal(true), data: z.unknown() }).safeParse(raw)
    : ProjectActionResponseSchema.safeParse(raw);
  if (!envelope.success) throw new ProjectsApiError(response.status, "The projects service returned an unexpected action response.", Boolean(attempt));
  const output = ProjectActionOutputSchemas[parsedAction.data.action].safeParse(envelope.data.data);
  if (!output.success) throw new ProjectsApiError(response.status, "The projects service returned an unexpected action result.", Boolean(attempt));
  if (attempt) clearProjectAttempt(attempt);
  return { kind: "completed", data: output.data as ProjectActionOutput<Action> };
}
