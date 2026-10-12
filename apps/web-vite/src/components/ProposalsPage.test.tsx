import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalsPage } from "./ProposalsPage";

const proposalId = "1c9a7c31-6a2f-4a1f-9d6a-0f4a2b3c4d5e";
const gapTicketId = "3e9c9e53-8c41-4c3f-9f8c-2b6c4d5e6f70";
const digest = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const verifiedEvidence = JSON.stringify({
  kind: "isolated_creator_candidate",
  baselineCommit: "0123456789abcdef",
  candidateDigest: digest,
  files: ["modules/creator/src/evolution.ts", "modules/creator/src/index.ts"],
  verification: { passed: true, network: "isolated", productionCredentials: false },
});

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: proposalId,
    title: "Harden the release lane",
    summary: "Reject candidates whose evidence does not verify.",
    diffText: "--- a/file\n+++ b/file\n+added line",
    testEvidence: verifiedEvidence,
    riskAssessment: "Bounded to the release lane.",
    status: "approved",
    gapTicketId,
    reviewComment: null,
    createdAt: "2026-09-20T09:30:00.000Z",
    releases: [],
    ...overrides,
  };
}

function modules(enabled = true) {
  return Response.json({
    catalog: [{ id: "creator", label: "Creator & marketplace", description: "Capability proposals", href: "/proposals" }],
    enabledModules: enabled ? ["creator"] : [],
    usingDefaults: false,
  });
}

function creatorReadResponse(input: RequestInfo | URL, init: RequestInit | undefined, proposals: Record<string, unknown>[] = [], gaps: Record<string, unknown>[] = []) {
  if (String(input) !== "/api/capabilities/execute" || init?.method !== "POST") return null;
  const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
  if (payload.capabilityId === "creator.listProposals") return Response.json({ ok: true, data: { proposals } });
  if (payload.capabilityId === "creator.listCapabilityGaps") return Response.json({ ok: true, data: { gaps } });
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// Each case renders a full page with its scoped stylesheet, so jsdom pays the
// CSS parse on the first render of a file. A loaded machine needs more than the
// default 5s budget for that warmup.
const PAGE_TEST_TIMEOUT = 20_000;

describe("Vite proposals page", () => {
  it("shows browser-local agent setup guidance without calling the legacy agent detector", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init);
      if (read) return read;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);
    await screen.findByRole("tab", { name: "Proposals" });
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));

    expect(await screen.findByRole("heading", { name: "Connect a coding agent to use Creator mode" })).not.toBeNull();
    expect(screen.getByText("npm install -g @openai/codex")).not.toBeNull();
    expect(screen.getByText(/This browser cannot inspect your terminal/)).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.every(([input]) => ["/api/modules", "/api/capabilities/execute"].includes(String(input)))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/creator/agent"))).toBe(false);
  }, PAGE_TEST_TIMEOUT);

  it("offers the release lane only for evidence that verifies in full", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init, [proposal()]);
      if (read) return read;
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(payload).toMatchObject({ capabilityId: "creator.stageCandidate", input: { proposalId, gapTicketId, candidateDigest: digest } });
        expect(payload.intentId).toEqual(expect.any(String));
        return Response.json({ ok: true, data: { releaseId: "9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a", status: "staged", gapTicketId, candidateDigest: digest, artifactRef: `artifact://creator/candidate/${digest}` } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);
    expect(await screen.findByText(/Evidence verified\./)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Request staging" }));

    expect(await screen.findByText("Candidate staged for controlled release. Nothing was installed or executed.")).not.toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("never offers the release lane for unverified evidence and shows why", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init, [proposal({ testEvidence: "ran the tests, all green" })]);
      if (read) return read;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);

    expect(await screen.findByText("Evidence not verified.")).not.toBeNull();
    expect(screen.getAllByText(/Candidate evidence is not valid JSON, so its digest cannot be trusted\./).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Request staging" })).toBeNull();
    expect(screen.getByText(/cannot enter the controlled release lane, and it is not offered as verified/)).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => {
      if (String(input) !== "/api/capabilities/execute" || !init?.body) return false;
      return (JSON.parse(String(init.body)) as { capabilityId?: string }).capabilityId === "creator.stageCandidate";
    })).toBe(false);
  }, PAGE_TEST_TIMEOUT);

  it("does not treat evidence with a failed verification block as verified", async () => {
    const tampered = JSON.stringify({
      kind: "isolated_creator_candidate",
      baselineCommit: "0123456789abcdef",
      candidateDigest: digest,
      files: ["modules/creator/src/evolution.ts"],
      verification: { passed: false, network: "open", productionCredentials: true },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init, [proposal({ testEvidence: tampered })]);
      if (read) return read;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);

    expect(await screen.findByText("Evidence not verified.")).not.toBeNull();
    expect(screen.queryByText(/Evidence verified\./)).toBeNull();
    expect(screen.queryByRole("button", { name: "Request staging" })).toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("surfaces an approval-pending staging request as pending, not as a staged release", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init, [proposal()]);
      if (read) return read;
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        return Response.json({ ok: false, pendingApproval: true, reason: "identity risk needs approval" }, { status: 202 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);
    await screen.findByText(/Evidence verified\./);
    fireEvent.click(screen.getByRole("button", { name: "Request staging" }));

    expect(await screen.findByText(/Approval requested\..*identity risk needs approval/)).not.toBeNull();
    expect(screen.queryByText(/Candidate staged for controlled release/)).toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("surfaces the capability refusal when the server rejects unverified evidence", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init, [proposal()]);
      if (read) return read;
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        return Response.json({ ok: false, error: "proposal lacks valid isolated candidate evidence" }, { status: 422 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);
    await screen.findByText(/Evidence verified\./);
    fireEvent.click(screen.getByRole("button", { name: "Request staging" }));

    expect((await screen.findByRole("alert")).textContent).toContain("proposal lacks valid isolated candidate evidence");
  }, PAGE_TEST_TIMEOUT);

  it("records a review decision through the compare-and-set endpoint", async () => {
    let decided = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init, [proposal({ status: decided ? "approved" : "in_review" })]);
      if (read) return read;
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(payload).toMatchObject({ capabilityId: "creator.reviewProposal", input: { proposalId, decision: "approved" } });
        decided = true;
        return Response.json({ ok: true, data: { note: "decision recorded; merge the change through your normal PR flow" } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));

    expect(await screen.findByText("decision recorded; merge the change through your normal PR flow")).not.toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("shows the diff, the evidence, and the release record on demand", async () => {
    const release = {
      id: "9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a",
      gapTicketId,
      candidateDigest: digest,
      artifactRef: `artifact://creator/candidate/${digest}`,
      status: "staged",
      stagedAt: "2026-09-21T09:00:00.000Z",
      promotedAt: null,
      rolledBackAt: null,
      outcomes: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      const read = creatorReadResponse(input, init, [proposal({ releases: [release] })]);
      if (read) return read;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);
    await screen.findByText(/Evidence verified\./);
    fireEvent.click(screen.getByRole("button", { name: "Show diff & evidence" }));

    expect(screen.getByText("+added line")).not.toBeNull();
    expect(screen.getByText(/Risk assessment\./)).not.toBeNull();
    expect(screen.getByText("Controlled release")).not.toBeNull();
    expect(screen.getByText(`artifact://creator/candidate/${digest}`)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Request promotion" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Request staging" })).toBeNull();
  }, PAGE_TEST_TIMEOUT);

  it("surfaces a failed proposal read instead of an empty list", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return modules();
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (payload.capabilityId === "creator.listProposals") return Response.json({ error: "requires platform.creator permission" }, { status: 403 });
        if (payload.capabilityId === "creator.listCapabilityGaps") return Response.json({ ok: true, data: { gaps: [] } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);

    expect(await screen.findByRole("heading", { name: "Could not load proposals" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("No proposals yet.")).toBeNull());
  }, PAGE_TEST_TIMEOUT);

  it("does not read proposals while Creator mode is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/modules" ? modules(false) : new Response(null, { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProposalsPage />);

    expect(await screen.findByText("Proposals are disabled")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, PAGE_TEST_TIMEOUT);
});
