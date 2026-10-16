import { z } from "zod";
import type { components } from "../generated/business-v1";

const TEAM_EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+.-]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

const MemberSchema: z.ZodType<components["schemas"]["TeamMember"]> = z.object({
  userId: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().regex(TEAM_EMAIL_PATTERN),
  roleKeys: z.array(z.string()),
}).strict();

const RoleSchema: z.ZodType<components["schemas"]["TeamRole"]> = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  name: z.string().min(1),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
}).strict();

const TeamDataSchema: z.ZodType<components["schemas"]["TeamResponse"]> = z.object({
  members: z.array(MemberSchema),
  roles: z.array(RoleSchema),
  catalog: z.array(z.string()),
}).strict();

const CreateRoleSchema = z.object({
  action: z.literal("createRole"),
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1).refine((value) => value.length <= 60),
}).strict();
const SetPermissionsSchema = z.object({
  action: z.literal("setPermissions"),
  roleId: z.string().min(1),
  permissions: z.array(z.string().min(1)).max(200),
}).strict();
const AssignRoleSchema = z.object({
  action: z.literal("assignRole"),
  userId: z.string().min(1),
  roleId: z.string().min(1),
}).strict();
const InviteSchema = z.object({
  action: z.literal("invite"),
  email: z.string().regex(TEAM_EMAIL_PATTERN),
  roleId: z.string().min(1),
}).strict();

export const TeamActionSchema = z.discriminatedUnion("action", [
  CreateRoleSchema,
  SetPermissionsSchema,
  AssignRoleSchema,
  InviteSchema,
]);

const ErrorBodySchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string().optional(),
  message: z.string().optional(),
}).strict();
const PendingActionSchema: z.ZodType<components["schemas"]["TeamWritePending"]> = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string(),
}).strict();
const CreateRoleResultSchema = z.object({
  roleId: z.string().uuid(),
}).strict() satisfies z.ZodType<components["schemas"]["TeamCreateRoleResult"]>;
const SetPermissionsResultSchema = z.object({
  permissionCount: z.number().int().nonnegative(),
}).strict() satisfies z.ZodType<components["schemas"]["TeamSetPermissionsResult"]>;
const AssignRoleResultSchema = z.object({
  assigned: z.boolean(),
}).strict() satisfies z.ZodType<components["schemas"]["TeamAssignRoleResult"]>;
const InviteResultSchema = z.object({
  invitationId: z.string().uuid(),
  token: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
}).strict() satisfies z.ZodType<components["schemas"]["TeamInviteResult"]>;
const SuccessActionSchema: z.ZodType<components["schemas"]["TeamWriteSuccess"]> = z.object({
  ok: z.literal(true),
  data: z.union([CreateRoleResultSchema, SetPermissionsResultSchema, AssignRoleResultSchema, InviteResultSchema]),
}).strict();
const ActionOutputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("createRole"), roleId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("setPermissions"), permissionCount: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("assignRole"), assigned: z.boolean() }).strict(),
  z.object({ action: z.literal("invite"), invitationId: z.string().uuid(), token: z.string().min(1), expiresAt: z.string().datetime({ offset: true }) }).strict(),
]);
export type TeamData = components["schemas"]["TeamResponse"];
export type TeamAction =
  | Omit<components["schemas"]["TeamCreateRoleRequest"], "intentId">
  | Omit<components["schemas"]["TeamSetPermissionsRequest"], "intentId">
  | Omit<components["schemas"]["TeamAssignRoleRequest"], "intentId">
  | Omit<components["schemas"]["TeamInviteRequest"], "intentId">;
export type TeamActionOutcome =
  | {
      kind: "completed";
      data: components["schemas"]["TeamWriteSuccess"]["data"];
    }
  | { kind: "pending"; reason: string };

export class TeamApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TeamApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TeamApiError(response.status, "The team service returned an unreadable response.");
  }
}

function errorMessage(status: number, raw: unknown): string {
  const body = ErrorBodySchema.safeParse(raw);
  const serverMessage = body.success ? body.data.error ?? body.data.message : undefined;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to view or change team roles.";
  if (status === 404) return "That member or role no longer exists. Refresh the team and try again.";
  if (status === 409) return "The team changed elsewhere. Refresh the page and try again.";
  if (status === 503 && serverMessage?.includes("check team status before retrying")) {
    return "The team service could not confirm whether this action completed. Refresh team status before retrying.";
  }
  if (status >= 500) return "The team service is unavailable. Try again.";
  if (serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)) return serverMessage;
  return "The team request could not be completed. Check the details and try again.";
}

async function getTeamJson(signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("/api/team", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new TeamApiError(0, "The team service took too long to respond. Try again.");
    }
    throw new TeamApiError(0, "Could not reach the team service. Check your connection and try again.");
  }
  const raw = await readJson(response);
  if (!response.ok) throw new TeamApiError(response.status, errorMessage(response.status, raw));
  return raw;
}

export async function fetchTeam(signal?: AbortSignal): Promise<TeamData> {
  const parsed = TeamDataSchema.safeParse(await getTeamJson(signal));
  if (!parsed.success) throw new TeamApiError(200, "The team service returned data in an unexpected format.");
  return parsed.data;
}

export async function submitTeamAction(
  action: TeamAction,
  intentId: string = crypto.randomUUID(),
): Promise<TeamActionOutcome> {
  const parsedAction = TeamActionSchema.safeParse(action);
  if (!parsedAction.success) throw new TeamApiError(0, "The team action contains invalid details.");
  if (intentId.trim().length === 0 || intentId.length > 200 || /[\r\n\0]/.test(intentId)) {
    throw new TeamApiError(0, "The team action needs a valid intent identity. Try again.");
  }

  let response: Response;
  try {
    const requestBody: components["schemas"]["TeamWriteRequest"] = { ...parsedAction.data, intentId };
    response = await fetch("/api/team", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: requestSignal(undefined, 20_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new TeamApiError(0, "The team action took too long. Check the team before trying again.");
    }
    throw new TeamApiError(0, "Could not reach the team service. Check your connection and try again.");
  }

  const raw = await readJson(response);
  if (response.status === 202) {
    const pending = PendingActionSchema.safeParse(raw);
    if (pending.success) return { kind: "pending", reason: pending.data.reason };
    throw new TeamApiError(202, "The team service returned an unexpected approval response.");
  }
  if (!response.ok) throw new TeamApiError(response.status, errorMessage(response.status, raw));

  const success = SuccessActionSchema.safeParse(raw);
  if (!success.success) throw new TeamApiError(response.status, "The team service returned an unexpected action response.");
  const output = ActionOutputSchema.safeParse({ action: parsedAction.data.action, ...success.data.data });
  if (!output.success) throw new TeamApiError(response.status, "The team service returned an unexpected action response.");
  return { kind: "completed", data: success.data.data };
}
