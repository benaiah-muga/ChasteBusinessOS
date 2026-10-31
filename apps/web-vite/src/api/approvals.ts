import { z } from "zod";
import type { components } from "../generated/business-v1";

const OrganizationIdSchema = z.string().uuid();

const ApprovalSchema: z.ZodType<components["schemas"]["ApprovalInboxRow"]> = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  requestedByUserId: z.string().uuid().nullable(),
  capabilityId: z.string().min(1),
  riskClass: z.string().min(1),
  payload: z.unknown(),
  rationale: z.string().nullable(),
  status: z.enum(["pending", "executed", "approved", "rejected", "expired"]),
  decidedByUserId: z.string().uuid().nullable(),
  decisionComment: z.string().nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  raisedBy: z.object({ name: z.string(), kind: z.enum(["agent", "human"]) }).strict(),
  decidedBy: z.string().nullable(),
  relatedDocuments: z.array(z.object({ id: z.string().uuid(), title: z.string() }).strict()),
}).strict();

const ApprovalListSchema: z.ZodType<components["schemas"]["ApprovalInboxResponse"]> = z.object({
  approvals: z.array(ApprovalSchema),
  history: z.array(ApprovalSchema),
}).strict();

const DecisionResponseSchema: z.ZodType<components["schemas"]["ApprovalDecisionSuccess"]> = z.object({
  ok: z.literal(true),
  status: z.enum(["rejected", "executed", "approved"]),
  result: z.object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    pendingApproval: z.boolean().optional(),
    approvalId: z.string().optional(),
    approvalRationale: z.string().optional(),
    replayed: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const ErrorResponseSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

export type Approval = components["schemas"]["ApprovalInboxRow"];
export type ApprovalList = components["schemas"]["ApprovalInboxResponse"];
export type ApprovalDecision = components["schemas"]["ApprovalDecisionSuccess"];

export class ApprovalApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApprovalApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApprovalApiError(response.status, "The approvals service returned an unreadable response.");
  }
}

async function errorMessage(response: Response): Promise<string> {
  const body = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
  const serverMessage = body.success ? body.data.error ?? body.data.message : undefined;

  if (response.status === 401) return "Your session has ended. Sign in again to continue.";
  if (response.status === 403) return "You do not have permission to view or decide these approvals.";
  if (response.status === 404) return "This approval no longer exists in the active workspace. Refresh the list.";
  if (response.status === 409 || (serverMessage && /already (?:handled|decided|executed|approved|rejected)/i.test(serverMessage))) {
    return "This approval was already handled. Refresh the list to see the latest decision.";
  }
  if (response.status === 422) {
    const message = serverMessage?.toLowerCase() ?? "";
    const detail = /period .* (?:is )?(?:closed|sealed)|sealed/.test(message)
      ? "The accounting period is closed. Resolve the period issue and try again."
      : /unbalanc/.test(message)
        ? "The books must stay balanced. Review the entry and try again."
        : /lack(s)? (?:authority|permission)|not permitted|forbidden/.test(message)
          ? "Your permission does not cover this action. Ask someone with the right role to review it."
          : "Review the action in the existing application, then try again.";
    return `Approval execution failed. The action did not run. ${detail}`;
  }
  return response.status >= 500
    ? "The approvals service is unavailable. Try again."
    : serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)
      ? serverMessage
      : "The approval request could not be completed. Try again.";
}

function normalizedOrganizationId(organizationId: string | null | undefined): string {
  const normalized = organizationId?.trim() ?? "";
  if (!OrganizationIdSchema.safeParse(normalized).success) {
    throw new ApprovalApiError(0, "Wait for the active organization to finish loading before viewing approvals.");
  }
  return normalized;
}

export async function fetchApprovals(organizationId: string | null | undefined, signal?: AbortSignal): Promise<ApprovalList> {
  const orgId = normalizedOrganizationId(organizationId);
  let response: Response;
  try {
    response = await fetch("/api/approvals", {
      credentials: "same-origin",
      headers: { accept: "application/json", "X-Organization-ID": orgId },
      cache: "no-store",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApprovalApiError(0, "Could not reach the approvals service. Check your connection and try again.");
  }

  if (!response.ok) throw new ApprovalApiError(response.status, await errorMessage(response));
  const parsed = ApprovalListSchema.safeParse(await parseJson(response));
  if (!parsed.success) throw new ApprovalApiError(response.status, "The approvals service returned data in an unexpected format.");
  if ([...parsed.data.approvals, ...parsed.data.history].some((approval) => approval.orgId !== orgId)) {
    throw new ApprovalApiError(response.status, "The approvals service returned data for a different organization.");
  }
  return parsed.data;
}

export async function submitApprovalDecision(id: string, decision: "approve" | "reject", organizationId: string | null | undefined): Promise<ApprovalDecision> {
  const orgId = normalizedOrganizationId(organizationId);
  if (!z.string().uuid().safeParse(id).success) {
    throw new ApprovalApiError(0, "This approval has an invalid identifier. Refresh the list before deciding.");
  }
  const query = new URLSearchParams({ id });
  const body: components["schemas"]["ApprovalDecisionRequest"] = { decision };
  let response: Response;
  try {
    response = await fetch(`/api/approvals?${query.toString()}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "X-Organization-ID": orgId },
      body: JSON.stringify(body),
      signal: requestSignal(undefined, 20_000),
    });
  } catch {
    throw new ApprovalApiError(0, "Could not reach the approvals service. Check your connection before trying again.");
  }

  if (!response.ok) throw new ApprovalApiError(response.status, await errorMessage(response));
  const parsed = DecisionResponseSchema.safeParse(await parseJson(response));
  if (!parsed.success) throw new ApprovalApiError(response.status, "The approvals service returned an unexpected decision response.");
  return parsed.data;
}
