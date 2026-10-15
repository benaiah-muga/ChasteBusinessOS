import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardApiError, fetchDashboard, fetchMyWork, fetchSetup, summarizeWork } from "./dashboard";
import { dashboardFixture, myWorkFixture, setupFixture } from "../test/dashboard-fixture";

afterEach(() => vi.unstubAllGlobals());

describe("dashboard API client", () => {
  it("validates the dashboard response and sends the current session cookie", async () => {
    const fetchMock = vi.fn(async () => Response.json(dashboardFixture));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDashboard();

    expect(result.money.netIncomeMinor).toBe(350_000);
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("rejects malformed financial values before a view renders them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...dashboardFixture, money: { ...dashboardFixture.money, netIncomeMinor: "350000" } })));

    await expect(fetchDashboard()).rejects.toEqual(expect.objectContaining({
      status: 200,
      message: "The dashboard service returned data in an unexpected format.",
    }));
  });

  it("requires the signals array returned by both dashboard backends", async () => {
    const { signals: _signals, ...responseWithoutSignals } = dashboardFixture;
    void _signals;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(responseWithoutSignals)));

    await expect(fetchDashboard()).rejects.toMatchObject({
      status: 200,
      message: "The dashboard service returned data in an unexpected format.",
    });
  });

  it("accepts nullable signal evidence and suggested actions from signals.list", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ...dashboardFixture,
      signals: [{
        ...dashboardFixture.signals[0],
        evidence: null,
        suggestedAction: null,
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchDashboard()).resolves.toMatchObject({
      signals: [{ evidence: null, suggestedAction: null }],
    });
  });

  it("enforces dashboard collection sizes declared by the Go response contract", async () => {
    const malformedResponses = [
      { ...dashboardFixture, signals: Array(9).fill(dashboardFixture.signals[0]) },
      { ...dashboardFixture, pipeline: { ...dashboardFixture.pipeline, stages: dashboardFixture.pipeline.stages.slice(0, 5) } },
      { ...dashboardFixture, trend: dashboardFixture.trend.slice(0, 5) },
      { ...dashboardFixture, activity: Array(9).fill(dashboardFixture.activity[0]) },
    ];

    for (const response of malformedResponses) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(response)));
      await expect(fetchDashboard()).rejects.toMatchObject({
        status: 200,
        message: "The dashboard service returned data in an unexpected format.",
      });
    }
  });

  it("rejects unknown fields at every dashboard response level while accepting Go signal details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...dashboardFixture,
      signals: [{
        ...dashboardFixture.signals[0],
        evidence: { refType: "inventory.item", refId: "item-1" },
        suggestedAction: { capabilityId: "inventory.createCount", inputDraft: { itemId: "item-1" } },
      }],
    })));
    await expect(fetchDashboard()).resolves.toMatchObject({ signals: [{ evidence: { refType: "inventory.item" } }] });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...dashboardFixture, unknown: true })));
    await expect(fetchDashboard()).rejects.toMatchObject({ status: 200, message: "The dashboard service returned data in an unexpected format." });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...dashboardFixture,
      money: { ...dashboardFixture.money, unknown: true },
    })));
    await expect(fetchDashboard()).rejects.toMatchObject({ status: 200, message: "The dashboard service returned data in an unexpected format." });
  });

  it("validates setup records and refuses paths that could leave the legacy origin", async () => {
    const safeResponse = vi.fn(async () => Response.json({ items: setupFixture, remaining: 1 }));
    vi.stubGlobal("fetch", safeResponse);
    expect(await fetchSetup()).toHaveLength(4);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      items: [{ ...setupFixture[0], href: "//attacker.example/path" }],
      remaining: 1,
    })));
    await expect(fetchSetup()).rejects.toBeInstanceOf(DashboardApiError);
  });

  it("maps an unauthorized dashboard response to an explicit session error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));

    await expect(fetchDashboard()).rejects.toEqual(expect.objectContaining({
      status: 401,
      message: "Your session has expired. Sign in again to continue.",
    }));
  });

  it("validates the ranked work cards and rejects an external action URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ cards: myWorkFixture, generatedAt: "2026-09-27T10:15:00.000Z" })));
    await expect(fetchMyWork()).resolves.toHaveLength(2);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      cards: [{ ...myWorkFixture[0], actionHref: "//attacker.invalid/" }],
      generatedAt: "2026-09-27T10:15:00.000Z",
    })));
    await expect(fetchMyWork()).rejects.toMatchObject({
      message: "The work queue returned data in an unexpected format.",
    });
  });

  it("rejects undeclared work queue fields and requires the Go summary model receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      cards: [{ ...myWorkFixture[0], unexpected: true }],
      generatedAt: "2026-09-27T10:15:00.000Z",
    })));
    await expect(fetchMyWork()).rejects.toMatchObject({ message: "The work queue returned data in an unexpected format." });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ brief: "Review one approval." })));
    await expect(summarizeWork(myWorkFixture)).rejects.toMatchObject({ message: "The work brief service returned data in an unexpected format." });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ brief: "Review one approval.", model: "test-model", extra: true })));
    await expect(summarizeWork(myWorkFixture)).rejects.toMatchObject({ message: "The work brief service returned data in an unexpected format." });
  });

  it("posts a schema-checked work bundle to the existing summary API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ brief: "Review one approval.", model: "test-model" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(summarizeWork(myWorkFixture)).resolves.toBe("Review one approval.");
    expect(fetchMock).toHaveBeenCalledWith("/api/my-work/summarize", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ cards: myWorkFixture.map(({ kind, title, detail }) => ({ kind, title, detail })) }),
    }));
  });

  it("preserves the server hint when the model brief is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "summary unavailable", hint: "No workspace model credential is configured." }, { status: 503 })));

    await expect(summarizeWork(myWorkFixture)).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 503,
      hint: "No workspace model credential is configured.",
    });
  });
});
