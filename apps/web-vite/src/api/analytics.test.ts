import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsReportFilename,
  askAnalytics,
  AnalyticsApiError,
  fetchAnalyticsDatasets,
  fetchAnalyticsEnabled,
  fetchAnalyticsPreview,
  generateAnalyticsReport,
  explainAnalyticsChange,
} from "./analytics";

afterEach(() => vi.unstubAllGlobals());

const switchboard = (enabledModules: string[]) => ({
  catalog: [{ id: "analytics", label: "Analytics", description: "Reports", href: "/analytics" }],
  enabledModules,
  usingDefaults: false,
});

describe("analytics API client", () => {
  it("checks the existing module switchboard and honors the organization setting", async () => {
    const fetchMock = vi.fn(async () => Response.json(switchboard(["analytics"])));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAnalyticsEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json(switchboard([]))));
    await expect(fetchAnalyticsEnabled()).resolves.toBe(false);
  });

  it("rejects a malformed or incomplete module switchboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: [], enabledModules: [], usingDefaults: false })));
    await expect(fetchAnalyticsEnabled()).rejects.toEqual(new AnalyticsApiError(200, "The module switchboard omitted the analytics module."));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json(switchboard(["unknown"]))));
    await expect(fetchAnalyticsEnabled()).rejects.toEqual(new AnalyticsApiError(200, "The module switchboard returned an unknown module."));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...switchboard(["analytics"]), catalog: [{ ...switchboard(["analytics"]).catalog[0], futureField: true }] })));
    await expect(fetchAnalyticsEnabled()).rejects.toEqual(new AnalyticsApiError(200, "The module switchboard returned data in an unexpected format."));
  });

  it("loads only the server-permitted dataset list through the authenticated same-origin route", async () => {
    const datasets = [{ id: "analytics.pipelineByStage", label: "Pipeline by stage", description: "Deal values per stage" }];
    const fetchMock = vi.fn(async () => Response.json({ datasets }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAnalyticsDatasets()).resolves.toEqual(datasets);
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ datasets: [{ ...datasets[0], extra: true }] })));
    await expect(fetchAnalyticsDatasets()).rejects.toEqual(new AnalyticsApiError(200, "The analytics service returned data in an unexpected format."));
  });

  it("requests governed previews with the dataset query value encoded", async () => {
    const preview = { region: null, columns: ["stage", "valueMinor"], rows: [{ stage: "won", valueMinor: 1250 }] };
    const fetchMock = vi.fn(async () => Response.json(preview));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAnalyticsPreview("analytics.pipelineByStage")).resolves.toEqual(preview);
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics?dataset=analytics.pipelineByStage", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...preview, extra: true })));
    await expect(fetchAnalyticsPreview("analytics.pipelineByStage")).rejects.toEqual(new AnalyticsApiError(200, "The analytics preview returned data in an unexpected format."));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...preview,
      rows: [{ stage: "won", details: { exactAmount: Number.MAX_SAFE_INTEGER + 1 } }],
    })));
    await expect(fetchAnalyticsPreview("analytics.pipelineByStage")).rejects.toEqual(new AnalyticsApiError(200, "The analytics preview returned data in an unexpected format."));

    await expect(fetchAnalyticsPreview("bad/id")).rejects.toEqual(new AnalyticsApiError(0, "Choose a valid analytics dataset to preview."));
  });

  it("asks a focused business question through the authenticated Go read path and validates its response", async () => {
    const result = {
      sections: [{ heading: "Top customers this period", citations: ["Acme"], lines: ["Acme: 2 invoice(s), 1250 minor"] }],
      proposedAction: { capabilityId: "accounting.createInvoice", inputDraft: {}, why: "Revenue needs attention" },
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(askAnalytics("revenue")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics?questionFocus=revenue", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sections: [{ heading: "Broken", citations: [], lines: [3] }], proposedAction: null })));
    await expect(askAnalytics("pipeline")).rejects.toEqual(new AnalyticsApiError(200, "The analytics insight returned data in an unexpected format."));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sections: [{ heading: "Unexpected", citations: [], lines: [], extra: true }], proposedAction: null })));
    await expect(askAnalytics("pipeline")).rejects.toEqual(new AnalyticsApiError(200, "The analytics insight returned data in an unexpected format."));
  });

  it("surfaces analytics question permission failures without a fallback", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(askAnalytics("collections")).rejects.toEqual(new AnalyticsApiError(403, "You do not have permission to access this analytics data."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests and validates an exact governed metric comparison", async () => {
    const result = {
      priorTotalMinor: 1000,
      currentTotalMinor: 1500,
      deltaMinor: 500,
      contributions: [{ key: "Acme", priorMinor: 1000, currentMinor: 1500, deltaMinor: 500, shareOfDelta: 1 }],
      drill: [{ key: "Acme", invoiceIds: ["invoice-1"] }],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(explainAnalyticsChange({
      dimension: "customer",
      periodAFrom: "2026-01-01T00:00:00.000Z",
      periodATo: "2026-02-01T00:00:00.000Z",
      periodBFrom: "2026-02-01T00:00:00.000Z",
      periodBTo: "2026-03-01T00:00:00.000Z",
    })).resolves.toEqual(result);
    const requestInput = fetchMock.mock.calls.at(0)?.[0];
    expect(requestInput).toBeDefined();
    const query = new URL(String(requestInput), "http://localhost").searchParams;
    expect(query.get("explainChange")).toBe("1");
    expect(query.get("dimension")).toBe("customer");
    expect(query.get("periodAFrom")).toBe("2026-01-01T00:00:00.000Z");

    await expect(explainAnalyticsChange({
      dimension: "customer",
      periodAFrom: "2026-01-01T00:00:00.1Z",
      periodATo: "2026-01-01T00:00:00.15Z",
      periodBFrom: "2026-01-01T00:00:00.2Z",
      periodBTo: "2026-01-01T00:00:00.3Z",
    })).resolves.toEqual(result);

    await expect(explainAnalyticsChange({
      dimension: "customer",
      periodAFrom: "2026-02-01T00:00:00.000Z",
      periodATo: "2026-01-01T00:00:00.000Z",
      periodBFrom: "2026-02-01T00:00:00.000Z",
      periodBTo: "2026-03-01T00:00:00.000Z",
    })).rejects.toEqual(new AnalyticsApiError(0, "Choose valid, non-empty comparison periods."));
  });

  it("rejects minor-unit totals that JavaScript cannot represent exactly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      priorTotalMinor: Number.MAX_SAFE_INTEGER + 1,
      currentTotalMinor: 1500,
      deltaMinor: 500,
      contributions: [],
      drill: [],
    })));

    await expect(explainAnalyticsChange({
      dimension: "customer",
      periodAFrom: "2026-01-01T00:00:00.000Z",
      periodATo: "2026-02-01T00:00:00.000Z",
      periodBFrom: "2026-02-01T00:00:00.000Z",
      periodBTo: "2026-03-01T00:00:00.000Z",
    })).rejects.toEqual(new AnalyticsApiError(200, "The metric change analysis returned data in an unexpected format."));
  });

  it("posts the exact governed report contract to the existing endpoint and preserves returned values", async () => {
    const result = {
      region: "africa-east",
      html: "<!doctype html><h1>Monthly report</h1>",
      sections: [{
        heading: "Revenue by month",
        svg: '<svg role="img" aria-label="Revenue chart"><text>1250</text></svg>',
        columns: ["month", "valueMinor"],
        rows: [{ month: "Sep", valueMinor: 1250 }],
      }],
    };
    const fetchMock = vi.fn(async () => Response.json(result));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      title: "Monthly report",
      narrative: "A short note",
      sections: [{
        heading: "Revenue by month",
        datasetId: "analytics.revenueByMonth",
        params: {},
        ops: [],
        chart: { type: "area" as const, x: "month", y: ["valueMinor"] },
      }],
    };

    await expect(generateAnalyticsReport(input)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(input),
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...result, sections: [{ ...result.sections[0], extra: true }] })));
    await expect(generateAnalyticsReport(input)).rejects.toEqual(new AnalyticsApiError(200, "The analytics report returned data in an unexpected format."));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...result,
      sections: [{ ...result.sections[0], rows: [{ month: "Sep", nested: [Number.MAX_SAFE_INTEGER + 1] }] }],
    })));
    await expect(generateAnalyticsReport(input)).rejects.toEqual(new AnalyticsApiError(200, "The analytics report returned data in an unexpected format."));
  });

  it("omits an optional blank narrative and reports permission failures clearly", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ region: null, html: "<html></html>", sections: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await generateAnalyticsReport({
      title: "Table report",
      sections: [{ heading: "Pipeline", datasetId: "analytics.pipelineByStage", params: {}, ops: [] }],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("narrative");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })));
    await expect(fetchAnalyticsDatasets()).rejects.toEqual(new AnalyticsApiError(403, "You do not have permission to access this analytics data."));
  });

  it("rejects reports with more than the server-supported eight sections before sending them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sections = Array.from({ length: 9 }, (_, index) => ({
      heading: `Section ${index + 1}`,
      datasetId: "analytics.pipelineByStage",
      params: {},
      ops: [],
    }));

    await expect(generateAnalyticsReport({ title: "Too many sections", sections })).rejects.toEqual(
      new AnalyticsApiError(0, "The report needs a title and at least one valid section."),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the existing sanitized report filename rules", () => {
    expect(analyticsReportFilename("  Q3 Sales / FY26! ")).toBe("q3-sales-fy26-.html");
    expect(analyticsReportFilename("   ")).toBe("report.html");
  });
});
