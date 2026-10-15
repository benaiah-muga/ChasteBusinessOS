import { z } from "zod";

const ApprovalSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  requestedByUserId: z.string().uuid().nullable(),
  capabilityId: z.string().min(1),
  riskClass: z.string().min(1),
  payload: z.unknown(),
  rationale: z.string().nullable(),
  status: z.enum(["pending", "executing", "executed", "approved", "failed", "rejected", "expired"]),
  decidedByUserId: z.string().uuid().nullable(),
  decisionComment: z.string().nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  raisedBy: z.object({ name: z.string(), kind: z.enum(["agent", "human"]) }).strict(),
  decidedBy: z.string().nullable(),
  relatedDocuments: z.array(z.object({ id: z.string().uuid(), title: z.string() }).strict()),
}).strict();

const ApprovalListSchema = z.object({
  approvals: z.array(ApprovalSchema),
  history: z.array(ApprovalSchema),
}).strict();

const DecisionResponseSchema = z.object({
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

export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalList = z.infer<typeof ApprovalListSchema>;

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

export async function fetchApprovals(signal?: AbortSignal): Promise<ApprovalList> {
  let response: Response;
  try {
    response = await fetch("/api/approvals", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApprovalApiError(0, "Could not reach the approvals service. Check your connection and try again.");
  }

  if (!response.ok) throw new ApprovalApiError(response.status, await errorMessage(response));
  const parsed = ApprovalListSchema.safeParse(await parseJson(response));
  if (!parsed.success) throw new ApprovalApiError(response.status, "The approvals service returned data in an unexpected format.");
  return parsed.data;
}

export async function submitApprovalDecision(id: string, decision: "approve" | "reject"): Promise<void> {
  const query = new URLSearchParams({ id });
  let response: Response;
  try {
    response = await fetch(`/api/approvals?${query.toString()}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ decision }),
      signal: requestSignal(undefined, 20_000),
    });
  } catch {
    throw new ApprovalApiError(0, "Could not reach the approvals service. Check your connection before trying again.");
  }

  if (!response.ok) throw new ApprovalApiError(response.status, await errorMessage(response));
  const parsed = DecisionResponseSchema.safeParse(await parseJson(response));
  if (!parsed.success) throw new ApprovalApiError(response.status, "The approvals service returned an unexpected decision response.");
}
