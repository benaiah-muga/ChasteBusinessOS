import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsPage } from "./SessionsPage";

const createdAt = "2026-09-27T10:15:00.000Z";

const sessions = [
  { id: "session-1", title: "Quarter close", mode: "assist", status: "completed", modelRef: "provider/model", createdAt },
  { id: "session-2", title: null, mode: "creator", status: "active", modelRef: null, createdAt },
  { id: "session-3", title: "Set up the new workspace", mode: "assist", status: "completed", modelRef: "provider/model", createdAt },
];

const run = {
  id: "run-1",
  sessionId: "session-1",
  goal: "Review the trial balance",
  status: "running",
  currentStep: 2,
  modelRef: "provider/model",
  harnessProfileId: "finance-review",
  harnessProfileVersion: "3",
  harnessCompositionDigest: "digest-123",
  lastError: null,
  createdAt,
  updatedAt: createdAt,
  startedAt: createdAt,
  finishedAt: null,
};

function eventResponses(sessionId: string) {
  if (sessionId === "session-3") {
    const events = [
      { seq: 41, role: "user", content: { text: "Set up Acme and a launch project", turnId: "turn-multi" }, at: createdAt },
      { seq: 42, role: "tool_call", content: { name: "crm_createCustomer", args: { name: "Acme" }, callId: "call-turn-1", turnId: "turn-multi" }, at: createdAt },
      { seq: 43, role: "tool_result", content: { name: "crm.createCustomer", capabilityId: "crm.createCustomer", callId: "call-turn-1", ok: true, result: "{\"customerId\":\"88888888-8888-4888-8888-888888888888\"}", turnId: "turn-multi" }, at: createdAt },
      { seq: 44, role: "tool_call", content: { name: "projects_createProject", args: { name: "Launch" }, callId: "call-turn-2", turnId: "turn-multi" }, at: createdAt },
      { seq: 45, role: "tool_result", content: { name: "projects.createProject", capabilityId: "projects.createProject", callId: "call-turn-2", ok: true, result: "{\"projectId\":\"99999999-9999-4999-8999-999999999999\"}", turnId: "turn-multi" }, at: createdAt },
      { seq: 46, role: "assistant", content: { text: "Created Acme and the Launch project.", turnId: "turn-multi" }, at: createdAt },
    ];
    return { events, trace: { eventCount: events.length, finalMessage: "Created Acme and the Launch project.", observations: [] } };
  }
  if (sessionId === "session-2") {
    const events = [
      { seq: 31, role: "user", content: { text: "Create Acme" }, at: createdAt },
      { seq: 32, role: "tool_call", content: { name: "crm_createCustomer", args: { name: "Acme" }, callId: "call-revert-1" }, at: createdAt },
      { seq: 33, role: "tool_result", content: { name: "crm.createCustomer", capabilityId: "crm.createCustomer", callId: "call-revert-1", ok: true, result: "{\"customerId\":\"77777777-7777-4777-8777-777777777777\"}" }, at: createdAt },
      { seq: 34, role: "assistant", content: { text: "Created Acme." }, at: createdAt },
    ];
    return { events, trace: { eventCount: events.length, finalMessage: "Created Acme.", observations: [] } };
  }
  const seq = sessionId === "session-1" ? 11 : 21;
  const events = [
    { seq, role: "user", content: { text: "Check the books" }, at: createdAt },
    { seq: seq + 1, role: "tool_call", content: { name: "accounting.trialBalance", args: { period: "2026-Q3" } }, at: createdAt },
    { seq: seq + 2, role: "tool_result", content: { name: "accounting.trialBalance", ok: true, result: "balanced" }, at: createdAt },
    { seq: seq + 3, role: "assistant", content: { text: "The books are balanced." }, at: createdAt },
  ];
  const trace = {
    eventCount: events.length,
    finalMessage: "The books are balanced.",
    observations: [{ seq: seq + 2, name: "accounting.trialBalance", result: "balanced" }],
  };
  return { events, trace };
}

function runDetail() {
  return {
    run: { ...run, registryVersion: "registry-4", contractRevision: 7 },
    steps: [{
      id: "step-1",
      stepIndex: 2,
      capabilityId: "accounting.trialBalance",
      status: "committed",
      inputHash: "input-digest",
      error: null,
      receiptId: "receipt-1",
      approvalId: null,
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
    }],
  };
}

let requests: string[];
let failingSessions = false;

beforeEach(() => {
  requests = [];
  failingSessions = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    if (path === "/api/sessions") {
      return failingSessions
        ? Response.json({ error: "service unavailable" }, { status: 503 })
        : Response.json({ sessions });
    }
    if (path === "/api/durable-runs") return Response.json({ runs: [run] });
    if (path === "/api/metrics") return Response.json({
      totals: { sessionsTracked: 1, inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, cacheHitRatePct: 40 },
      note: "Provider cache usage.",
    });
    if (path === "/api/durable-runs/run-1") return Response.json(runDetail());
    if (path === "/api/sessions/session-2/revert") {
      return Response.json({ ok: true, inverseCapabilityId: "crm.deactivateCustomer", data: { deactivated: true } });
    }
    if (path === "/api/sessions/session-3/revert") {
      return Response.json({
        turnId: "turn-multi",
        ok: true,
        planCount: 2,
        reverted: [
          { callId: "call-turn-2", inverseCapabilityId: "projects.archiveProject", ok: true },
          { callId: "call-turn-1", inverseCapabilityId: "crm.deactivateCustomer", ok: true },
        ],
      });
    }
    if (path.startsWith("/api/sessions/") && path.endsWith("/replay")) {
      const sessionId = path.split("/").at(-2) ?? "session-1";
      return Response.json({ trace: eventResponses(sessionId).trace });
    }
    if (path.startsWith("/api/sessions/")) {
      const sessionId = path.split("/").at(-1) ?? "session-1";
      return Response.json({ events: eventResponses(sessionId).events });
    }
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SessionsPage", () => {
  it("links a selected session back into the Workmate", async () => {
    render(<SessionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Quarter close/ }));
    const link = await screen.findByRole("link", { name: "Continue in Workmate" });
    expect(link.getAttribute("href")).toBe("/chat?session=session-1");
  });

  it("keeps session selection, event sequence, canonical replay, durable checkpoints, and context metrics", async () => {
    const { container } = render(<SessionsPage />);

    expect(await screen.findByRole("heading", { name: "Agent sessions" })).not.toBeNull();
    await waitFor(() => expect(container.querySelector(".sessions-context-metrics")?.textContent).toContain("40% of prompt tokens served from provider cache"));
    expect(await screen.findByText("Quarter close")).not.toBeNull();
    expect(screen.getByText("Untitled session")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Quarter close/ }));
    expect(await screen.findByText("Canonical replay")).not.toBeNull();
    await waitFor(() => expect(container.querySelector(".sessions-replay-summary")?.textContent).toContain("The books are balanced."));
    expect(container.querySelector(".session-tool-name")?.textContent).toContain("accounting.trialBalance");
    expect(screen.getByText("arguments")).not.toBeNull();
    const argumentsDisclosure = container.querySelector(".session-event-details") as HTMLDetailsElement | null;
    expect(argumentsDisclosure).not.toBeNull();
    fireEvent.click(argumentsDisclosure!.querySelector("summary")!);
    expect(argumentsDisclosure!.open).toBe(true);
    expect(argumentsDisclosure!.textContent).toContain("2026-Q3");
    expect(screen.getByText("1 replay observation")).not.toBeNull();
    const observationDisclosure = container.querySelector(".sessions-replay-observations") as HTMLDetailsElement | null;
    expect(observationDisclosure).not.toBeNull();
    fireEvent.click(observationDisclosure!.querySelector("summary")!);
    expect(observationDisclosure!.open).toBe(true);
    expect(observationDisclosure!.textContent).toContain("balanced");
    expect(container.querySelector(".session-tool-result")?.textContent).toContain("ok · accounting.trialBalance");
    const resultDisclosures = Array.from(container.querySelectorAll(".session-event-details"));
    expect(resultDisclosures.some((element) => element.textContent?.includes("balanced"))).toBe(true);
    const eventMetas = Array.from(container.querySelectorAll(".session-event-meta"), (element) => element.textContent?.split(" · ")[0]);
    expect(eventMetas).toEqual(["#11", "#12", "#13", "#14"]);

    fireEvent.click(screen.getByRole("button", { name: /running.*step 2/i }));
    expect(await screen.findByText("Run dossier")).not.toBeNull();
    await waitFor(() => expect(container.querySelector(".session-run-dossier")?.textContent).toContain("registry-4"));
    expect(container.querySelector(".session-run-dossier")?.textContent).toContain("Receipt receipt-1");
    expect(container.querySelector(".session-run-dossier")?.textContent).toContain("finance-review");
    expect(requests).toContain("/api/sessions/session-1");
    expect(requests).toContain("/api/sessions/session-1/replay");
    expect(requests).toContain("/api/durable-runs/run-1");
  });

  it("shows empty session state and does not select a session automatically", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path === "/api/durable-runs") return Response.json({ runs: [] });
      if (path === "/api/metrics") return Response.json({
        totals: { sessionsTracked: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheHitRatePct: null },
        note: "No usage.",
      });
      return new Response(null, { status: 404 });
    });

    render(<SessionsPage />);
    expect(await screen.findByRole("heading", { name: "No sessions yet" })).not.toBeNull();
    expect(screen.getByText("No durable runs recorded for this workspace.")).not.toBeNull();
  });

  it("exposes a retry when the required session list fails", async () => {
    failingSessions = true;
    render(<SessionsPage />);
    expect(await screen.findByRole("heading", { name: "Could not load sessions" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();

    failingSessions = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Quarter close")).not.toBeNull();
  });

  it("shows a request-level error for a selected trajectory", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/sessions") return Response.json({ sessions: [sessions[0]] });
      if (path === "/api/durable-runs") return Response.json({ runs: [] });
      if (path === "/api/metrics") return Response.json({
        totals: { sessionsTracked: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheHitRatePct: null },
        note: "No usage.",
      });
      if (path === "/api/sessions/session-1") return Response.json({ error: "not found" }, { status: 404 });
      if (path.endsWith("/replay")) return Response.json({ trace: eventResponses("session-1").trace });
      return new Response(null, { status: 404 });
    });

    render(<SessionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Quarter close/ }));
    expect(await screen.findByRole("alert")).not.toBeNull();
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/sessions/session-1")).toBe(true));
  });
});

it("filters sessions by title and mode without losing the active replay", async () => {
  render(<SessionsPage />);
  expect(await screen.findByRole("button", { name: /Quarter close/ })).not.toBeNull();
  const search = screen.getByRole("searchbox", { name: "Search sessions" });
  fireEvent.change(search, { target: { value: "creator" } });
  expect(screen.queryByRole("button", { name: /Quarter close/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Untitled session/ })).not.toBeNull();
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Filter sessions" }), { target: { value: "assist" } });
  expect(screen.getByRole("button", { name: /Quarter close/ })).not.toBeNull();
  expect(screen.queryByRole("button", { name: /Untitled session/ })).toBeNull();
  fireEvent.change(search, { target: { value: "does-not-exist" } });
  expect(screen.getByRole("status", { name: "" }).textContent).toContain("No sessions match.");
});


it("reverts a declared action from the session replay", async () => {
  render(<SessionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Untitled session/ }));
  const revert = await screen.findByRole("button", { name: "Revert action" });
  fireEvent.click(revert);
  expect(screen.getByRole("button", { name: "Confirm revert" })).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm revert" }));
  expect(await screen.findByText(/Reverted through crm.deactivateCustomer/)).not.toBeNull();
  expect(requests).toContain("/api/sessions/session-2/revert");
});


it("reverts all declared actions in a turn in reverse order", async () => {
  render(<SessionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Set up the new workspace/ }));
  const revert = await screen.findByRole("button", { name: "Revert turn" });
  fireEvent.click(revert);
  expect(screen.getByRole("button", { name: "Confirm turn revert" })).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm turn revert" }));
  expect(await screen.findByText(/Reverted 2 actions in turn turn-multi/)).not.toBeNull();
  expect(requests).toContain("/api/sessions/session-3/revert");
});
