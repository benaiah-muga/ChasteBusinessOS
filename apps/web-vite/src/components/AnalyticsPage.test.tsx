import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsPage } from "./AnalyticsPage";

const datasets = [{
  id: "analytics.revenueByMonth",
  label: "Revenue by month",
  description: "Invoiced totals per month",
}];

const preview = {
  columns: ["month", "valueMinor", "invoiceCount"],
  rows: [{ month: "Sep", valueMinor: 1250, invoiceCount: 4 }],
};

const report = {
  region: "africa-east",
  html: "<!doctype html><html><body><h1>Q3 Sales!</h1></body></html>",
  sections: [{
    heading: "Revenue by month",
    svg: '<svg role="img" aria-label="Revenue chart"><text>1250</text></svg>',
    columns: ["month", "valueMinor"],
    rows: [{ month: "Sep", valueMinor: 1250 }],
  }],
};

function responseFor(input: RequestInfo | URL, init?: RequestInit): Response {
  const path = String(input);
  if (path === "/api/modules") {
    return Response.json({
      catalog: [{ id: "analytics", label: "Analytics", description: "Reports", href: "/analytics" }],
      enabledModules: ["analytics"],
      usingDefaults: false,
    });
  }
  if (path === "/api/analytics" && init?.method === "POST") return Response.json(report);
  if (path === "/api/analytics?dataset=analytics.revenueByMonth") return Response.json(preview);
  if (path === "/api/analytics") return Response.json({ datasets });
  return Response.json({ error: "unexpected request" }, { status: 404 });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Vite analytics page", () => {
  it("shows a loading state, then the module-disabled state without loading datasets", async () => {
    let resolveSwitchboard: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => String(input) === "/api/modules"
      ? new Promise<Response>((resolve) => { resolveSwitchboard = resolve; })
      : Promise.resolve(Response.json({ datasets })));
    vi.stubGlobal("fetch", fetchMock);
    render(<AnalyticsPage />);

    expect(screen.getByRole("status").textContent).toContain("Checking analytics availability");
    resolveSwitchboard?.(Response.json({
      catalog: [{ id: "analytics", label: "Analytics", description: "Reports", href: "/analytics" }],
      enabledModules: [],
      usingDefaults: false,
    }));

    expect(await screen.findByRole("heading", { name: "Analytics is disabled" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains when the permission-filtered endpoint has no available datasets", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/analytics" && init?.method !== "POST"
      ? Promise.resolve(Response.json({ datasets: [] }))
      : Promise.resolve(responseFor(input, init))));
    render(<AnalyticsPage />);

    expect(await screen.findByRole("heading", { name: "No datasets available" })).not.toBeNull();
    expect(screen.getByText(/roles don’t include read access/)).not.toBeNull();
  });

  it("shows a module API error and allows retry", async () => {
    let attempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") {
        attempts += 1;
        return Promise.resolve(attempts === 1
          ? Response.json({ error: "forbidden" }, { status: 403 })
          : responseFor(input, init));
      }
      return Promise.resolve(responseFor(input, init));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AnalyticsPage />);

    expect(await screen.findByRole("heading", { name: "Could not load analytics" })).not.toBeNull();
    expect(screen.getByText("You do not have permission to access this analytics data.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Analytics" })).not.toBeNull();
    expect(attempts).toBe(2);
  });

  it("cancels a retried dataset discovery request on unmount", async () => {
    let attempts = 0;
    let retrySignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") {
        attempts += 1;
        if (attempts === 1) return Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
        retrySignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(responseFor(input, init));
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<AnalyticsPage />);
    await screen.findByRole("heading", { name: "Could not load analytics" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(retrySignal).toBeDefined());

    expect(retrySignal?.aborted).toBe(false);
    view.unmount();
    expect(retrySignal?.aborted).toBe(true);
  });

  it("previews with default chart fields, supports all chart modes and removes sections", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => responseFor(input, init));
    vi.stubGlobal("fetch", fetchMock);
    render(<AnalyticsPage />);

    fireEvent.change(await screen.findByRole("combobox", { name: "Add a dataset" }), { target: { value: "analytics.revenueByMonth" } });
    expect(await screen.findByText("Preview loaded: 1 row · month, valueMinor, invoiceCount")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics?dataset=analytics.revenueByMonth", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));

    const chartType = screen.getByLabelText("Chart type") as HTMLSelectElement;
    expect(chartType.value).toBe("bar");
    expect((screen.getByLabelText("Category column") as HTMLSelectElement).value).toBe("month");
    expect((screen.getByLabelText("Value column") as HTMLSelectElement).value).toBe("valueMinor");
    expect(Array.from(chartType.options).map((option) => option.value)).toEqual(["none", "bar", "line", "area", "pie"]);
    fireEvent.change(chartType, { target: { value: "pie" } });
    expect(chartType.value).toBe("pie");

    fireEvent.click(screen.getByRole("button", { name: "Remove Revenue by month section" }));
    expect(screen.queryByRole("button", { name: "Generate report" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Build your report" })).not.toBeNull();
  });

  it("coalesces repeated dataset selection and cancels a pending preview on unmount", async () => {
    let previewSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/analytics?dataset=analytics.revenueByMonth") {
        previewSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(responseFor(input, init));
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<AnalyticsPage />);
    const selector = await screen.findByRole("combobox", { name: "Add a dataset" });
    fireEvent.change(selector, { target: { value: "analytics.revenueByMonth" } });
    fireEvent.change(selector, { target: { value: "analytics.revenueByMonth" } });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("?dataset=")).length).toBe(1);
    expect(previewSignal?.aborted).toBe(false);
    view.unmount();
    expect(previewSignal?.aborted).toBe(true);
  });

  it("posts the report to the existing API, shows busy state and exact returned output, and downloads sanitized HTML", async () => {
    let resolveReport: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/analytics" && init?.method === "POST") {
        return new Promise<Response>((resolve) => { resolveReport = resolve; });
      }
      return Promise.resolve(responseFor(input, init));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AnalyticsPage />);

    fireEvent.change(await screen.findByRole("combobox", { name: "Add a dataset" }), { target: { value: "analytics.revenueByMonth" } });
    await screen.findByText("Preview loaded: 1 row · month, valueMinor, invoiceCount");
    fireEvent.change(screen.getByLabelText("Report title"), { target: { value: "  Q3 Sales!  " } });
    fireEvent.change(screen.getByLabelText(/Report narrative/), { target: { value: "Strong close" } });
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "area" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate report" }));

    const busyButton = await screen.findByRole("button", { name: "Generating report…" });
    expect(busyButton.hasAttribute("disabled")).toBe(true);
    const post = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/analytics" && init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      title: "Q3 Sales!",
      narrative: "Strong close",
      sections: [{
        heading: "Revenue by month",
        datasetId: "analytics.revenueByMonth",
        params: {},
        ops: [],
        chart: { type: "area", x: "month", y: ["valueMinor"] },
      }],
    });

    resolveReport?.(Response.json(report));
    expect(await screen.findByText("africa-east")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Revenue chart" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "1250" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Report title"), { target: { value: "A different draft" } });
    expect(screen.getByRole("heading", { name: "Q3 Sales!" })).not.toBeNull();

    let downloadedBlob: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlob = blob;
      return "blob:analytics-report";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let downloadedFilename = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilename = this.download;
    });
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(downloadedFilename).toBe("q3-sales-.html");
    expect(await downloadedBlob?.text()).toContain("<h1>Q3 Sales!</h1>");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:analytics-report");
  });

  it("displays a report-generation API error and clears the busy state", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/analytics" && init?.method === "POST"
      ? Promise.resolve(Response.json({ error: "forbidden" }, { status: 403 }))
      : Promise.resolve(responseFor(input, init)));
    vi.stubGlobal("fetch", fetchMock);
    render(<AnalyticsPage />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Add a dataset" }), { target: { value: "analytics.revenueByMonth" } });
    await screen.findByText("Preview loaded: 1 row · month, valueMinor, invoiceCount");
    fireEvent.click(screen.getByRole("button", { name: "Generate report" }));

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(screen.getByText("You do not have permission to access this analytics data.")).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate report" }).hasAttribute("disabled")).toBe(false));
  });

  it("cancels a pending report request when leaving the page", async () => {
    let reportSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/analytics" && init?.method === "POST") {
        reportSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(responseFor(input, init));
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<AnalyticsPage />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Add a dataset" }), { target: { value: "analytics.revenueByMonth" } });
    await screen.findByText("Preview loaded: 1 row · month, valueMinor, invoiceCount");
    fireEvent.click(screen.getByRole("button", { name: "Generate report" }));

    await waitFor(() => expect(reportSignal).toBeDefined());
    expect(reportSignal?.aborted).toBe(false);
    view.unmount();
    expect(reportSignal?.aborted).toBe(true);
  });
});
