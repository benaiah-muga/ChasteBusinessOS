import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDurableRunDetail,
  fetchDurableRuns,
  fetchSessionEvents,
  fetchSessionMetrics,
  fetchSessionReplay,
  fetchSessions,
  SessionsApiError,
} from "./sessions";

const at = "2026-09-27T10:15:00.000Z";

function runRow(id = "run-1") {
  return {
    id,
    sessionId: "session-1",
    goal: "Review the ledger",
    status: "running",
    currentStep: 2,
    modelRef: "provider/model",
    harnessProfileId: "finance-review",
    harnessProfileVersion: "3",
    harnessCompositionDigest: "digest-1",
    lastError: null,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    finishedAt: null,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sessions API", () => {
  it("validates session data and requests through the same-origin authenticated API", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(Response.json({ sessions: [{
      id: "session-1",
      title: null,
      mode: "assist",
      status: "completed",
      modelRef: null,
      createdAt: at,
    }] }));

    await expect(fetchSessions()).resolves.toEqual([{
      id: "session-1",
      title: null,
      mode: "assist",
      status: "completed",
      modelRef: null,
      createdAt: at,
    }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("rejects malformed sessions and does not manufacture an empty result", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ sessions: [{ id: "missing-fields" }] }));
    await expect(fetchSessions()).rejects.toMatchObject({
      status: 200,
      message: "The sessions service returned data in an unexpected format.",
    });
  });

  it("preserves ordered trajectory events and rejects sequence gaps that arrive out of order", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(Response.json({ events: [
      { seq: 1, role: "user", content: { text: "Review this" }, at },
      { seq: 2, role: "assistant", content: { text: "I will review it" }, at },
    ] }));
    await expect(fetchSessionEvents("session-1")).resolves.toMatchObject([{ seq: 1 }, { seq: 2 }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1", expect.any(Object));

    fetchMock.mockResolvedValue(Response.json({ events: [
      { seq: 2, role: "assistant", content: { text: "Second" }, at },
      { seq: 1, role: "user", content: { text: "First" }, at },
    ] }));
    await expect(fetchSessionEvents("session-1")).rejects.toBeInstanceOf(SessionsApiError);
  });

  it("loads the canonical replay without invoking a different session path", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(Response.json({ trace: {
      eventCount: 2,
      finalMessage: "The books are balanced.",
      observations: [{ seq: 2, name: "accounting.trialBalance", result: "balanced" }],
    } }));

    await expect(fetchSessionReplay("session-1")).resolves.toEqual({
      eventCount: 2,
      finalMessage: "The books are balanced.",
      observations: [{ seq: 2, name: "accounting.trialBalance", result: "balanced" }],
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/replay", expect.any(Object));
  });

  it("loads durable run rows and their checkpoint details", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(Response.json({ runs: [runRow()] }));
    fetchMock.mockResolvedValueOnce(Response.json({
      run: { ...runRow(), registryVersion: "registry-4", contractRevision: 7 },
      steps: [{
        id: "step-1",
        stepIndex: 2,
        capabilityId: "accounting.trialBalance",
        status: "committed",
        inputHash: "input-hash",
        error: null,
        receiptId: "receipt-1",
        approvalId: null,
        createdAt: at,
        startedAt: at,
        finishedAt: at,
      }],
    }));

    await expect(fetchDurableRuns()).resolves.toHaveLength(1);
    await expect(fetchDurableRunDetail("run/one")).resolves.toMatchObject({
      run: { registryVersion: "registry-4", contractRevision: 7 },
      steps: [{ capabilityId: "accounting.trialBalance", receiptId: "receipt-1" }],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/durable-runs", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/durable-runs/run%2Fone", expect.any(Object));
  });

  it("validates org session metrics including the no-usage null rate", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({
      totals: {
        sessionsTracked: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheHitRatePct: null,
      },
      note: "No provider usage recorded yet.",
    }));
    await expect(fetchSessionMetrics()).resolves.toMatchObject({ totals: { cacheHitRatePct: null } });
  });

  it("maps expired authentication and unreadable success bodies to actionable errors", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(fetchSessions()).rejects.toMatchObject({
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });

    fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(fetchSessions()).rejects.toMatchObject({
      status: 200,
      message: "The sessions service returned an unreadable response.",
    });
  });
});
