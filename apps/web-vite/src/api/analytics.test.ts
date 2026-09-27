import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsReportFilename,
  AnalyticsApiError,
  fetchAnalyticsDatasets,
  fetchAnalyticsEnabled,
  fetchAnalyticsPreview,
  generateAnalyticsReport,
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
  });

  it("requests governed previews with the dataset query value encoded", async () => {
    const preview = { columns: ["stage", "valueMinor"], rows: [{ stage: "won", valueMinor: 1250 }] };
    const fetchMock = vi.fn(async () => Response.json(preview));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAnalyticsPreview("analytics.pipelineByStage")).resolves.toEqual(preview);
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics?dataset=analytics.pipelineByStage", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));

    await expect(fetchAnalyticsPreview("bad/id")).rejects.toEqual(new AnalyticsApiError(0, "Choose a valid analytics dataset to preview."));
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

  it("uses the existing sanitized report filename rules", () => {
    expect(analyticsReportFilename("  Q3 Sales / FY26! ")).toBe("q3-sales-fy26-.html");
    expect(analyticsReportFilename("   ")).toBe("report.html");
  });
});
