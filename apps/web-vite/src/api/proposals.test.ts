import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchProposals,
  ProposalsApiError,
  submitEvolutionAction,
  submitProposalReview,
  verifyCandidateEvidence,
} from "./proposals";

const proposalId = "1c9a7c31-6a2f-4a1f-9d6a-0f4a2b3c4d5e";
const releaseId = "2d8b8d42-7b30-4b2f-8e7b-1a5b3c4d5e6f";
const gapTicketId = "3e9c9e53-8c41-4c3f-9f8c-2b6c4d5e6f70";
const digest = "a".repeat(64);

const evidence = JSON.stringify({
  kind: "isolated_creator_candidate",
  baselineCommit: "0123456789abcdef",
  candidateDigest: digest,
  files: ["modules/creator/src/evolution.ts"],
  verification: { passed: true, network: "isolated", productionCredentials: false },
});

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: proposalId,
    title: "Harden the release lane",
    summary: "Reject candidates whose evidence does not verify.",
    diffText: "--- a/file\n+++ b/file\n+added",
    testEvidence: evidence,
    riskAssessment: "Bounded to the release lane.",
    status: "approved",
    gapTicketId,
    reviewComment: null,
    createdAt: "2026-09-20T09:30:00.000Z",
    releases: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("candidate evidence verification", () => {
  it("trusts only isolated evidence that verifies in full", () => {
    const result = verifyCandidateEvidence(evidence);
    expect(result.state).toBe("verified");
    if (result.state === "verified") expect(result.digest).toBe(digest);
  });

  it("refuses evidence whose verification block did not pass", () => {
    const tampered = JSON.stringify({
      kind: "isolated_creator_candidate",
      baselineCommit: "0123456789abcdef",
      candidateDigest: digest,
      files: ["modules/creator/src/evolution.ts"],
      verification: { passed: false, network: "open", productionCredentials: true },
    });
    const result = verifyCandidateEvidence(tampered);
    expect(result.state).toBe("unverified");
    if (result.state === "unverified") expect(result.reason).toContain("verification");
  });

  it("refuses a digest that is not a sha256 digest", () => {
    const result = verifyCandidateEvidence(evidence.replace(digest, "not-a-digest"));
    expect(result.state).toBe("unverified");
  });

  it("refuses evidence that is not valid JSON and says so", () => {
    const result = verifyCandidateEvidence("ran the tests, all green");
    expect(result).toEqual({
      state: "unverified",
      reason: "Candidate evidence is not valid JSON, so its digest cannot be trusted.",
    });
  });

  it("refuses an approved proposal that carries no evidence at all", () => {
    expect(verifyCandidateEvidence(null).state).toBe("unverified");
    expect(verifyCandidateEvidence("   ").state).toBe("unverified");
  });
});

describe("proposal reads", () => {
  it("refuses a proposal list that is missing releases", async () => {
    const malformed = proposal() as Record<string, unknown>;
    delete malformed.releases;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ proposals: [malformed] })));

    await expect(fetchProposals()).rejects.toBeInstanceOf(ProposalsApiError);
  });

  it("surfaces the permission refusal instead of an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "requires platform.creator permission" }, { status: 403 })));

    await expect(fetchProposals()).rejects.toMatchObject({ status: 403, message: expect.stringContaining("permission") });
  });

  it("turns a stalled read into a recoverable API error", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Request timed out", "TimeoutError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchProposals();
    expect(fetchMock).toHaveBeenCalledWith("/api/proposals", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    timeoutController.abort();
    await expect(request).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Creator service") });
  });
});

describe("proposal review", () => {
  it("records a decision with an idempotent intent", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ proposalId, decision: "approved" });
      expect(payload.intentId).toEqual(expect.any(String));
      return Response.json({ ok: true, note: "decision recorded; merge the change through your normal PR flow" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await submitProposalReview({ proposalId, decision: "approved" });
    expect(outcome).toEqual({ kind: "completed", note: "decision recorded; merge the change through your normal PR flow" });
  });

  it("surfaces a compare-and-set conflict rather than a silent success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "conflict: proposal already decided or no longer in review" }, { status: 409 })));

    await expect(submitProposalReview({ proposalId, decision: "rejected" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already decided"),
    });
  });
});

describe("governed release actions", () => {
  it("sends the verified digest and artifact through the governed path", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ action: "stage", proposalId, gapTicketId, candidateDigest: digest });
      expect(payload.intentId).toEqual(expect.any(String));
      return Response.json({ ok: true, data: { releaseId, status: "staged", gapTicketId, candidateDigest: digest, artifactRef: `artifact://creator/candidate/${digest}` } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await submitEvolutionAction({
      action: "stage",
      proposalId,
      gapTicketId,
      candidateDigest: digest,
      artifactRef: `artifact://creator/candidate/${digest}`,
    });

    expect(outcome.kind).toBe("completed");
    expect(fetchMock).toHaveBeenCalledWith("/api/creator/evolution", expect.objectContaining({ method: "POST" }));
  });

  it("reports an approval-pending release as pending, not as a promotion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, pendingApproval: true, reason: "identity risk needs approval" }, { status: 202 })));

    const outcome = await submitEvolutionAction({ action: "promote", releaseId, candidateDigest: digest });
    expect(outcome).toEqual({ kind: "pending", reason: "identity risk needs approval" });
  });

  it("surfaces the verification refusal from the capability verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "proposal lacks valid isolated candidate evidence" }, { status: 422 })));

    await expect(submitEvolutionAction({
      action: "stage",
      proposalId,
      gapTicketId,
      candidateDigest: digest,
      artifactRef: `artifact://creator/candidate/${digest}`,
    })).rejects.toMatchObject({ status: 422, message: "proposal lacks valid isolated candidate evidence" });
  });

  it("surfaces a digest mismatch instead of blaming the client", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "candidate digest does not match verified evidence" }, { status: 422 })));

    await expect(submitEvolutionAction({ action: "promote", releaseId, candidateDigest: digest })).rejects.toMatchObject({
      message: "candidate digest does not match verified evidence",
    });
  });

  it("refuses a release action whose digest is not a digest before it leaves the browser", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitEvolutionAction({ action: "promote", releaseId, candidateDigest: "abc" })).rejects.toMatchObject({
      name: "ProposalsApiError",
      message: "The release action contains invalid details.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not report a promotion when the release result violates its contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { releaseId, status: "promoted" } })));

    await expect(submitEvolutionAction({ action: "promote", releaseId, candidateDigest: digest })).rejects.toMatchObject({
      message: "The Creator service returned an unexpected release result.",
    });
  });

  it("surfaces a Go bridge outage without inventing a release state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Creator evolution service unavailable; check release status before retrying" }, { status: 503 })));

    await expect(submitEvolutionAction({ action: "rollback", releaseId, candidateDigest: digest })).rejects.toMatchObject({
      status: 503,
      message: "The Creator service is unavailable. Check release status before retrying.",
    });
  });

});
