import { z } from "zod";

const MemberSchema = z.object({
  userId: z.string().min(1),
  name: z.string().nullable(),
  email: z.string().email(),
  roleKeys: z.array(z.string()),
});

const RoleSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});

const TeamDataSchema = z.object({
  members: z.array(MemberSchema),
  roles: z.array(RoleSchema),
  catalog: z.array(z.string()),
});

const CreateRoleSchema = z.object({
  action: z.literal("createRole"),
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1).max(60),
});
const SetPermissionsSchema = z.object({
  action: z.literal("setPermissions"),
  roleId: z.string().min(1),
  permissions: z.array(z.string().min(1)).max(200),
});
const AssignRoleSchema = z.object({
  action: z.literal("assignRole"),
  userId: z.string().min(1),
  roleId: z.string().min(1),
});
const InviteSchema = z.object({
  action: z.literal("invite"),
  email: z.string().email(),
  roleId: z.string().min(1),
});

export const TeamActionSchema = z.discriminatedUnion("action", [
  CreateRoleSchema,
  SetPermissionsSchema,
  AssignRoleSchema,
  InviteSchema,
]);

const ErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});
const PendingActionSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
});
const SuccessActionSchema = z.object({
  ok: z.literal(true),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type TeamData = z.infer<typeof TeamDataSchema>;
export type TeamAction = z.infer<typeof TeamActionSchema>;
export type TeamActionOutcome =
  | { kind: "completed"; data: Record<string, unknown> }
  | { kind: "pending"; reason?: string };

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
  if (!intentId.trim()) throw new TeamApiError(0, "The team action needs an intent identity. Try again.");

  let response: Response;
  try {
    response = await fetch("/api/team", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ...parsedAction.data, intentId }),
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
  return { kind: "completed", data: success.data.data ?? {} };
}
