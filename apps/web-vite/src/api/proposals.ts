import { z } from "zod";

const uuid = z.string().uuid();
const instant = z.string().datetime();
/** The same digest shape the governed release capabilities demand. */
const candidateDigest = z.string().regex(/^[a-f0-9]{64}$/, "candidate digest must be 64 lowercase hex characters");
const artifactRef = z.string().regex(/^(artifact|git):\/\/[^\s]+$/, "an immutable artifact reference is required");
const evidenceRef = z.string().regex(/^(artifact|evidence|git):\/\/[^\s]+$/, "an immutable evidence reference is required");
const metrics = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const EvolutionOutcomeSchema = z.object({
  id: uuid,
  verdict: z.enum(["pass", "fail"]),
  evidenceRef: z.string(),
  metrics,
  observedAt: instant,
}).strict();

const EvolutionReleaseSchema = z.object({
  id: uuid,
  gapTicketId: uuid.nullable(),
  candidateDigest,
  artifactRef: z.string(),
  status: z.enum(["staged", "promoted", "rolled_back"]),
  stagedAt: instant,
  promotedAt: instant.nullable(),
  rolledBackAt: instant.nullable(),
  outcomes: z.array(EvolutionOutcomeSchema),
}).strict();

const ProposalSchema = z.object({
  id: uuid,
  title: z.string(),
  summary: z.string(),
  diffText: z.string(),
  testEvidence: z.string().nullable(),
  riskAssessment: z.string().nullable(),
  status: z.string(),
  gapTicketId: uuid.nullable(),
  reviewComment: z.string().nullable(),
  createdAt: instant,
  releases: z.array(EvolutionReleaseSchema),
}).strict();

const ProposalListSchema = z.object({ proposals: z.array(ProposalSchema) });

const CapabilityGapSchema = z.object({
  id: uuid,
  title: z.string(),
  description: z.string(),
  status: z.string(),
  createdAt: instant,
}).strict();
const CapabilityGapListSchema = z.object({ gaps: z.array(CapabilityGapSchema) });

const AgentCandidateSchema = z.object({
  cli: z.string(),
  label: z.string(),
  install: z.string(),
  authNote: z.string(),
}).strict();
const DetectedAgentInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  version: z.string().nullable(),
  viaBinary: z.boolean(),
  configDirs: z.array(z.string()),
}).strict();
const AgentStatusSchema = z.object({
  installed: z.boolean(),
  cli: z.string().nullable(),
  label: z.string().nullable(),
  version: z.string().nullable(),
  agents: z.array(DetectedAgentInfoSchema),
  candidates: z.array(AgentCandidateSchema),
}).strict();

const ModuleResponseSchema = z.object({
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

const ReviewInputSchema = z.object({
  proposalId: uuid,
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(4000).optional(),
}).strict();

const StageInputSchema = z.object({
  action: z.literal("stage"),
  proposalId: uuid,
  gapTicketId: uuid,
  candidateDigest,
  artifactRef,
}).strict();
const PromoteInputSchema = z.object({
  action: z.literal("promote"),
  releaseId: uuid,
  candidateDigest,
}).strict();
const RollbackInputSchema = z.object({
  action: z.literal("rollback"),
  releaseId: uuid,
  candidateDigest,
}).strict();
const CanaryInputSchema = z.object({
  action: z.literal("canary"),
  releaseId: uuid,
  gapTicketId: uuid,
  candidateDigest,
  verdict: z.enum(["pass", "fail"]),
  evidenceRef,
  metrics: metrics.optional(),
}).strict();

export const EvolutionActionSchema = z.discriminatedUnion("action", [
  StageInputSchema,
  PromoteInputSchema,
  RollbackInputSchema,
  CanaryInputSchema,
]);

const EvolutionOutputSchemas = {
  stage: z.object({
    releaseId: z.string(),
    status: z.literal("staged"),
    gapTicketId: z.string(),
    candidateDigest,
    artifactRef,
  }).strict(),
  promote: z.object({
    releaseId: z.string(),
    status: z.literal("promoted"),
    gapTicketId: z.string(),
    candidateDigest,
    artifactRef,
  }).strict(),
  rollback: z.object({
    releaseId: z.string(),
    status: z.literal("rolled_back"),
    candidateDigest,
    artifactRef,
  }).strict(),
  canary: z.object({
    outcomeId: z.string(),
    releaseId: z.string(),
    gapTicketId: z.string(),
    candidateDigest,
    phase: z.literal("canary"),
    verdict: z.enum(["pass", "fail"]),
  }).strict(),
} as const;

const SuccessSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const PendingSchema = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string().optional(),
}).strict();
const RefusalSchema = z.object({ ok: z.literal(false), error: z.string() }).strict();
const ApiErrorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

export type CreatorProposal = z.infer<typeof ProposalSchema>;
export type EvolutionRelease = z.infer<typeof EvolutionReleaseSchema>;
export type EvolutionOutcome = z.infer<typeof EvolutionOutcomeSchema>;
export type CapabilityGap = z.infer<typeof CapabilityGapSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type ReviewDecision = z.infer<typeof ReviewInputSchema>;
export type EvolutionAction = z.infer<typeof EvolutionActionSchema>;
export type EvolutionOutput<Action extends EvolutionAction> = z.infer<typeof EvolutionOutputSchemas[Action["action"]]>;

export type EvolutionActionOutcome<Action extends EvolutionAction> =
  | { kind: "completed"; data: EvolutionOutput<Action> }
  | { kind: "pending"; reason: string };

export type ProposalReviewOutcome =
  | { kind: "completed"; note: string }
  | { kind: "pending"; reason: string };

/**
 * The isolated candidate evidence a proposal must carry before it can enter
 * the controlled release lane. This mirrors the server-side contract exactly:
 * a release is only ever recorded for evidence that verified in isolation,
 * against a fixed baseline commit, with no production credentials.
 */
const CandidateEvidenceSchema = z.object({
  kind: z.literal("isolated_creator_candidate"),
  baselineCommit: z.string().min(7),
  candidateDigest,
  files: z.array(z.string().min(1)).min(1),
  verification: z.object({
    passed: z.literal(true),
    network: z.string().min(1),
    productionCredentials: z.literal(false),
  }).strict(),
}).strict();

export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;

export type CandidateVerification =
  | { state: "verified"; digest: string; evidence: CandidateEvidence }
  | { state: "unverified"; reason: string };

/**
 * Verifies candidate evidence before any release control is offered. A digest
 * is only trusted when the whole evidence document holds together: the
 * isolated-candidate shape, a real sha256 digest, at least one changed file,
 * and an explicit pass with no production credentials. Anything else is
 * reported as unverified with the reason, never quietly upgraded to verified.
 */
export function verifyCandidateEvidence(testEvidence: string | null | undefined): CandidateVerification {
  const text = testEvidence?.trim() ?? "";
  if (!text) {
    return { state: "unverified", reason: "No candidate evidence is attached, so there is nothing verified to release." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "unverified", reason: "Candidate evidence is not valid JSON, so its digest cannot be trusted." };
  }
  const result = CandidateEvidenceSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "evidence";
    return { state: "unverified", reason: `Candidate evidence failed verification at ${where}: ${issue?.message ?? "unknown problem"}.` };
  }
  return { state: "verified", digest: result.data.candidateDigest, evidence: result.data };
}

export class ProposalsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProposalsApiError";
  }
}

function requestSignal(signal?: AbortSignal, timeoutMs = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Server messages win whenever they are safe to show, because the governed
 * capabilities refuse with the reason that matters (an unverified candidate, a
 * digest mismatch, a release already rolled back).
 */
function errorMessage(status: number, raw: unknown, fallback: string): string {
  const body = ApiErrorSchema.safeParse(raw);
  const serverMessage = body.success ? body.data.error ?? body.data.message : undefined;
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have permission to review Creator proposals.";
  if (status === 404) return "This proposal no longer exists. Reload the list.";
  if (status === 409) return "This proposal was already decided or has left review. Reload the list.";
  if (status === 428) return "Finish setting up your workspace before using Creator mode.";
  if (status >= 500) return "The Creator service is unavailable. Check release status before retrying.";
  if (serverMessage && serverMessage.length <= 240 && !/[{}<>]/.test(serverMessage)) return serverMessage;
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProposalsApiError(response.status, "The Creator service returned an unreadable response.");
  }
}

async function request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      signal: requestSignal(signal, init.method === "POST" ? 20_000 : 15_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ProposalsApiError(0, "The Creator service took too long to respond. Check the record before trying again.");
    }
    throw new ProposalsApiError(0, "Could not reach the Creator service. Check your connection and try again.");
  }
  return { response, body: await readJson(response) };
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const { response, body } = await request(path, {}, signal);
  if (!response.ok) throw new ProposalsApiError(response.status, errorMessage(response.status, body, "The Creator service returned data in an unexpected format."));
  return body;
}

async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, fallback = "The Creator service returned data in an unexpected format."): Promise<T> {
  const parsed = schema.safeParse(await getJson(path, signal));
  if (!parsed.success) throw new ProposalsApiError(200, fallback);
  return parsed.data;
}

export async function fetchCreatorEnabled(signal?: AbortSignal): Promise<boolean> {
  const parsed = ModuleResponseSchema.safeParse(await getJson("/api/modules", signal));
  if (!parsed.success) throw new ProposalsApiError(200, "The module switchboard returned data in an unexpected format.");
  const catalogIds = new Set(parsed.data.catalog.map((module) => module.id));
  if (!catalogIds.has("creator")) throw new ProposalsApiError(200, "The module switchboard omitted the creator module.");
  if (parsed.data.enabledModules.some((id) => !catalogIds.has(id))) {
    throw new ProposalsApiError(200, "The module switchboard returned an unknown module.");
  }
  return parsed.data.enabledModules.includes("creator");
}

export async function fetchProposals(signal?: AbortSignal): Promise<CreatorProposal[]> {
  const result = await get("/api/proposals", ProposalListSchema, signal, "The proposal list came back in an unexpected format.");
  return result.proposals;
}

export async function fetchCapabilityGaps(signal?: AbortSignal): Promise<CapabilityGap[]> {
  try {
    const result = await get("/api/capability-gaps", CapabilityGapListSchema, signal, "The capability gap list came back in an unexpected format.");
    return result.gaps;
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

export async function fetchCreatorAgent(signal?: AbortSignal): Promise<AgentStatus | null> {
  try {
    return await get("/api/creator/agent", AgentStatusSchema, signal, "The coding agent check came back in an unexpected format.");
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Recording a decision is a compare-and-set, not a governed capability, so it
 * answers 200 with a note or 409 when another reviewer won the race.
 */
export async function submitProposalReview(
  review: ReviewDecision,
  intentId: string = crypto.randomUUID(),
): Promise<ProposalReviewOutcome> {
  const parsedReview = ReviewInputSchema.safeParse(review);
  if (!parsedReview.success) throw new ProposalsApiError(0, "The review decision contains invalid details.");

  const { response, body } = await request("/api/proposals", {
    method: "POST",
    body: JSON.stringify({ ...parsedReview.data, intentId }),
  });
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new ProposalsApiError(response.status, "The Creator service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? "This decision is waiting for approval. It is in the Approvals inbox." };
  }
  if (!response.ok) throw new ProposalsApiError(response.status, errorMessage(response.status, body, "The review decision could not be recorded."));
  const parsed = z.object({ ok: z.literal(true), note: z.string().optional() }).safeParse(body);
  if (!parsed.success) throw new ProposalsApiError(response.status, "The Creator service returned an unexpected review response.");
  return { kind: "completed", note: parsed.data.note ?? `Proposal ${parsedReview.data.decision}.` };
}

/**
 * Every release transition is a governed capability: an approval requirement
 * comes back as 202 and is reported as pending, a refusal comes back as 422
 * with the capability's own reason (an unverified candidate, a digest
 * mismatch), and neither is ever reported as a completed change.
 */
export async function submitEvolutionAction<Action extends EvolutionAction>(
  action: Action,
  intentId: string = crypto.randomUUID(),
): Promise<EvolutionActionOutcome<Action>> {
  const parsedAction = EvolutionActionSchema.safeParse(action);
  if (!parsedAction.success) throw new ProposalsApiError(0, "The release action contains invalid details.");
  if (!intentId.trim()) throw new ProposalsApiError(0, "The release action needs an intent identity. Try again.");

  const { response, body } = await request("/api/creator/evolution", {
    method: "POST",
    body: JSON.stringify({ ...parsedAction.data, intentId }),
  });
  if (response.status === 202) {
    const pending = PendingSchema.safeParse(body);
    if (!pending.success) throw new ProposalsApiError(response.status, "The Creator service returned an unexpected approval response.");
    return { kind: "pending", reason: pending.data.reason ?? "This release action is waiting for human approval. It is in the Approvals inbox." };
  }
  if (!response.ok) {
    const refusal = RefusalSchema.safeParse(body);
    throw new ProposalsApiError(response.status, errorMessage(response.status, refusal.success ? refusal.data : body, "The release action could not be completed."));
  }
  const envelope = SuccessSchema.safeParse(body);
  if (!envelope.success) throw new ProposalsApiError(response.status, "The Creator service returned an unexpected release response.");
  const output = EvolutionOutputSchemas[parsedAction.data.action].safeParse(envelope.data.data);
  if (!output.success) throw new ProposalsApiError(response.status, "The Creator service returned an unexpected release result.");
  return { kind: "completed", data: output.data as EvolutionOutput<Action> };
}
