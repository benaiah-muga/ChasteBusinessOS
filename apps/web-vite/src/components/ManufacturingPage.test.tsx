import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManufacturingPage } from "./ManufacturingPage";

const switchboard = { catalog: [{ id: "manufacturing" }], enabledModules: ["manufacturing"] };

const bomEdge = {
  assemblySku: "DESK-1",
  componentSku: "LEG-1",
  componentName: "Oak leg",
  quantityThousandths: 4000,
  scrapPctThousandths: 20_000,
};

const report = {
  boms: [bomEdge],
  assemblies: [{ sku: "DESK-1", name: "Oak desk" }],
  workOrders: [
    {
      id: "11111111-1111-4111-8111-111111111111", number: 9, assemblySku: "DESK-1", assemblyName: "Oak desk", status: "draft",
      plannedQtyThousandths: 10_000, producedQtyThousandths: 0, yieldPctThousandths: 1_000_000,
      expectedGoodThousandths: 10_000, note: "Rush order", createdAt: "2026-05-12T10:30:00.000Z", completedAt: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222", number: 8, assemblySku: "DESK-1", assemblyName: "Oak desk", status: "released",
      plannedQtyThousandths: 10_000, producedQtyThousandths: 4000, yieldPctThousandths: 1_000_000,
      expectedGoodThousandths: 10_000, note: null, createdAt: "2026-05-11T10:30:00.000Z", completedAt: null,
    },
  ],
  productionRuns: [
    {
      runId: "run-1", occurredAt: "2026-05-12T11:00:00.000Z", assemblySku: "DESK-1",
      producedThousandths: 2000, unitCostMinor: 12_000, costTotalMinor: 24_000, reversed: false,
      components: [{ sku: "LEG-1", quantityThousandths: 8000, lotCode: "LEG-MAY" }],
    },
    {
      runId: "run-0", occurredAt: "2026-05-10T11:00:00.000Z", assemblySku: "DESK-1",
      producedThousandths: 1000, unitCostMinor: 12_000, costTotalMinor: 12_000, reversed: true,
      components: [{ sku: "LEG-1", quantityThousandths: 4000, lotCode: null }],
    },
  ],
  lots: [{ id: "lot-1", sku: "LEG-1", lotCode: "LEG-MAY", expiresAt: "2026-06-01T00:00:00.000Z", balanceThousandths: 8000 }],
};

type PostedBody = Record<string, unknown>;

interface StubOptions {
  onPost?: (body: PostedBody) => Response | Promise<Response>;
  payload?: unknown;
  enabled?: boolean;
}

function manufacturingFetch({ onPost, payload = report, enabled = true }: StubOptions = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/modules") {
      return Response.json({ catalog: switchboard.catalog, enabledModules: enabled ? ["manufacturing"] : [] });
    }
    if ((input === "/api/manufacturing" || input === "/api/capabilities/execute") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as PostedBody;
      const action = typeof body.capabilityId === "string" && typeof body.input === "object" && body.input !== null
        ? { ...(body.input as PostedBody), action: body.capabilityId.split(".").at(-1), intentId: body.intentId }
        : body;
      return onPost?.(action) ?? Response.json({ ok: true, data: {} });
    }
    return Response.json(payload);
  });
}

function postedActions(fetchMock: ReturnType<typeof manufacturingFetch>): PostedBody[] {
  return fetchMock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
    .map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as PostedBody;
      return typeof body.capabilityId === "string" && typeof body.input === "object" && body.input !== null
        ? { ...(body.input as PostedBody), action: body.capabilityId.split(".").at(-1), intentId: body.intentId }
        : body;
    });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/manufacturing");
});

describe("Vite manufacturing page", () => {
  it("summarises open work orders, BOMs, and monthly production on the overview", async () => {
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Manufacturing" })).not.toBeNull();
    expect(screen.getByText("Open work orders")).not.toBeNull();
    expect(screen.getByText("Assemblies with BOMs")).not.toBeNull();
    expect(screen.getByText("Produced this month")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Work orders in flight" })).not.toBeNull();
    expect(screen.getByText(/WO #8/)).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Watch list" })).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === "LI" && element.textContent?.includes("Lot LEG-MAY of LEG-1") === true)).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open full manufacturing workspace" }).getAttribute("href")).toContain("/manufacturing");
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("/api/manufacturing", expect.any(Object));
  });

  it("navigates from an overview stat card to the matching tab", async () => {
    vi.stubGlobal("fetch", manufacturingFetch());
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByText("Open work orders"));
    expect(await screen.findByRole("heading", { name: "Plan a work order" })).not.toBeNull();
    expect(window.location.search).toBe("?tab=orders");
  });

  it("lists bills of materials and expands the nested client-side tree", async () => {
    vi.stubGlobal("fetch", manufacturingFetch());
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    expect(await screen.findByRole("heading", { name: "Define / replace a bill of materials" })).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === "LI" && element.textContent?.includes("Oak leg (LEG-1) × 4.000 · scrap 2.0%") === true)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "tree" }));
    expect(screen.getByRole("columnheader", { name: "Qty / parent" })).not.toBeNull();
    expect(screen.getByText("4.000")).not.toBeNull();
  });

  it("sends a governed defineBom write with a stamped intent id and keeps approval pending visible", async () => {
    const fetchMock = manufacturingFetch({
      onPost: (body) => body.action === "defineBom"
        ? Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 })
        : Response.json({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.change(screen.getByLabelText("Assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Component SKU 1"), { target: { value: "LEG-1" } });
    fireEvent.change(screen.getByLabelText("Component 1 quantity per unit"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Component 1 scrap percent"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save BOM" }));

    expect(await screen.findByText(/Save BOM for DESK-1 requires approval/)).not.toBeNull();
    const define = postedActions(fetchMock).find((body) => body.action === "defineBom");
    expect(define).toMatchObject({
      assemblySku: "DESK-1",
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    });
    expect(String(define?.intentId)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("keeps feasibility shortfalls visible for the chosen assembly", async () => {
    vi.stubGlobal("fetch", manufacturingFetch({
      onPost: () => Response.json({
        ok: true,
        data: {
          producible: false,
          maxProducibleThousandths: 5000,
          estimatedLeadTimeDays: 4,
          lines: [{ itemId: "item-leg-1", requiredThousandths: 8000, onHandThousandths: 5000, shortfallThousandths: 3000 }],
        },
      }),
    }));
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.change(screen.getByLabelText("Units to build for DESK-1"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Check feasibility" }));

    expect(await screen.findByText("short of parts")).not.toBeNull();
    expect(screen.getByText(/max producible: 5.000 units/)).not.toBeNull();
    expect(screen.getByText(/est. lead time 4 d/)).not.toBeNull();
    expect(screen.getByText("3.000")).not.toBeNull();
    expect(screen.getByText("item-leg")).not.toBeNull();
  });

  it("previews production cost in minor units before producing", async () => {
    const fetchMock = manufacturingFetch({
      onPost: (body) => body.action === "costPreview"
        ? Response.json({
          ok: true,
          data: {
            producible: true,
            lines: [{ sku: "LEG-1", name: "Oak leg", requiredThousandths: 8000, unitCostMinor: 3000, costMinor: 24_000 }],
            totalCostMinor: 24_000,
            resultingAvgFinishedUnitCostMinor: 12_000,
          },
        })
        : Response.json({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: "Produce" }));
    fireEvent.change(screen.getByLabelText("Produce assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Units to build"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Lot code"), { target: { value: "DESK-MAY" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview cost" }));

    expect(await screen.findByText("producible")).not.toBeNull();
    expect(screen.getAllByText("$240.00")).toHaveLength(2);
    expect(screen.getByText("$120.00")).not.toBeNull();
    expect(postedActions(fetchMock).find((body) => body.action === "costPreview")).toMatchObject({ assemblySku: "DESK-1", quantityThousandths: 2000 });

    fireEvent.click(screen.getByRole("button", { name: "Produce now" }));
    expect(await screen.findByText("Produce DESK-1 done.")).not.toBeNull();
    expect(postedActions(fetchMock).find((body) => body.action === "produceFromBom")).toMatchObject({ assemblySku: "DESK-1", quantityThousandths: 2000, lotCode: "DESK-MAY" });
  });

  it("keeps production planning reads working when routed through Go", async () => {
    vi.stubGlobal("__GO_MANUFACTURING_PLANNING_READS__", true);
    const fetchMock = manufacturingFetch({
      onPost: (body) => {
        if (body.action === "costPreview") return Response.json({ ok: true, data: {
          producible: true,
          plannedThousandths: 1000,
          expectedGoodThousandths: 1000,
          lines: [{ sku: "LEG-1", name: "Oak leg", requiredThousandths: 4000, unitCostMinor: 3000, costMinor: 12_000 }],
          totalCostMinor: 12_000,
          resultingAvgFinishedUnitCostMinor: 12_000,
        } });
        if (body.action === "checkProductionFeasibility") return Response.json({ ok: true, data: {
          producible: false,
          maxProducibleThousandths: 0,
          estimatedLeadTimeDays: null,
          lines: [{ itemId: "leg-1", requiredThousandths: 4000, onHandThousandths: 1000, shortfallThousandths: 3000 }],
        } });
        if (body.action === "bomReport") return Response.json({ ok: true, data: {
          producible: false,
          totalShortfallThousandths: 3000,
          lines: [{ sku: "LEG-1", name: "Oak leg", requiredThousandths: 4000, onHandThousandths: 1000, shortfallThousandths: 3000 }],
        } });
        return Response.json({ ok: true, data: {} });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check feasibility" }));
    expect(await screen.findByText(/max producible: 0.000 units/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "BOM report" }));
    expect(await screen.findByText(/scrap-adjusted requirements/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Produce" }));
    fireEvent.change(screen.getByLabelText("Produce assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview cost" }));
    expect(await screen.findByText("producible")).not.toBeNull();

    const capabilityRequests = fetchMock.mock.calls
      .filter(([url]) => url === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(capabilityRequests.map((body) => body.capabilityId)).toEqual([
      "manufacturing.checkProductionFeasibility",
      "manufacturing.bomReport",
      "manufacturing.costPreview",
    ]);
    expect(capabilityRequests.every((body) => typeof body.intentId === "string")).toBe(true);
  });

  it("drives work orders from draft through release, completion, and cancellation", async () => {
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    expect(await screen.findByRole("heading", { name: "Plan a work order" })).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Work order assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Planned units"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Work order note"), { target: { value: "Rush order" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(postedActions(fetchMock).some((body) => body.action === "createWorkOrder")).toBe(true));
    expect(postedActions(fetchMock).find((body) => body.action === "createWorkOrder")).toMatchObject({ assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000, note: "Rush order" });

    fireEvent.click(screen.getByRole("button", { name: "Release for production" }));
    await waitFor(() => expect(postedActions(fetchMock).some((body) => body.action === "releaseWorkOrder" && body.workOrderId === "11111111-1111-4111-8111-111111111111")).toBe(true));

    fireEvent.change(screen.getByLabelText("Units to record on WO #8"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Record completion" }));
    await waitFor(() => expect(postedActions(fetchMock).some((body) => body.action === "completeWorkOrder")).toBe(true));
    expect(postedActions(fetchMock).find((body) => body.action === "completeWorkOrder")).toMatchObject({ workOrderId: "22222222-2222-4222-8222-222222222222", quantityThousandths: 1000 });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(postedActions(fetchMock).some((body) => body.action === "cancelWorkOrder" && body.workOrderId === "22222222-2222-4222-8222-222222222222")).toBe(true));
  });

  it("keeps a Go work order draft and intent through approval pending until success", async () => {
    vi.stubGlobal("__GO_MANUFACTURING_WORK_ORDER_WRITES__", true);
    let submissions = 0;
    const fetchMock = manufacturingFetch({
      onPost: () => {
        submissions += 1;
        return submissions === 1
          ? Response.json({ ok: false, pendingApproval: true, reason: "Supervisor review" }, { status: 202 })
          : Response.json({ ok: true, data: { workOrderId: "33333333-3333-4333-8333-333333333333", number: 10, expectedGoodThousandths: 4000 } });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    fireEvent.change(screen.getByLabelText("Work order assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Planned units"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/Create WO for DESK-1 requires approval/)).not.toBeNull();
    expect((screen.getByLabelText("Work order assembly SKU") as HTMLInputElement).value).toBe("DESK-1");
    expect((screen.getByLabelText("Planned units") as HTMLInputElement).value).toBe("4");
    const goRequests = fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities/execute");
    expect(goRequests).toHaveLength(1);
    const firstBody = JSON.parse(String((goRequests[0]?.[1] as RequestInit).body)) as PostedBody;
    expect(firstBody).toMatchObject({ capabilityId: "manufacturing.createWorkOrder", input: { assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000 } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(submissions).toBe(2));
    const retriedBody = JSON.parse(String((fetchMock.mock.calls.find(([url], index) => url === "/api/capabilities/execute" && index > 0)?.[1] as RequestInit).body)) as PostedBody;
    expect(retriedBody.intentId).toBe(firstBody.intentId);
    expect((screen.getByLabelText("Work order assembly SKU") as HTMLInputElement).value).toBe("");
  });

  it("does not apply a Go write response or refresh after the active organization changes", async () => {
    vi.stubGlobal("__GO_MANUFACTURING_WORK_ORDER_WRITES__", true);
    let resolveWrite: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/capabilities/execute" && init?.method === "POST") {
        return new Promise<Response>((resolve) => { resolveWrite = resolve; });
      }
      return Response.json(report);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    fireEvent.change(screen.getByLabelText("Work order assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(resolveWrite).toBeDefined());

    rerender(<ManufacturingPage actorId="actor-1" organizationId="org-2" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    await act(async () => {
      resolveWrite?.(Response.json({ ok: true, data: {
        workOrderId: "33333333-3333-4333-8333-333333333333", number: 10, expectedGoodThousandths: 4000,
      } }));
    });

    expect(await screen.findByRole("heading", { name: "Manufacturing" })).not.toBeNull();
    expect(screen.queryByText("Create WO for DESK-1 done.")).toBeNull();
    const reportReads = fetchMock.mock.calls.filter(([input, init]) => input === "/api/manufacturing" && init?.method !== "POST");
    expect(reportReads).toHaveLength(2);
  });

  it.each([
    ["Check feasibility", "checkProductionFeasibility", {
      producible: false,
      maxProducibleThousandths: 0,
      estimatedLeadTimeDays: 2,
      lines: [{ itemId: "old-org-item", requiredThousandths: 1000, onHandThousandths: 0, shortfallThousandths: 1000 }],
    }],
    ["BOM report", "bomReport", {
      producible: false,
      totalShortfallThousandths: 1000,
      lines: [{ sku: "OLD-ORG", name: "Old organization item", requiredThousandths: 1000, onHandThousandths: 0, shortfallThousandths: 1000 }],
    }],
  ] as const)("ignores a deferred %s result after the organization changes", async (buttonName, actionName, result) => {
    let resolveRead: ((response: Response) => void) | undefined;
    const fetchMock = manufacturingFetch({
      onPost: (body) => body.action === actionName
        ? new Promise<Response>((resolve) => { resolveRead = resolve; })
        : Response.json({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => expect(resolveRead).toBeDefined());

    rerender(<ManufacturingPage actorId="actor-1" organizationId="org-2" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    await act(async () => {
      resolveRead?.(Response.json({ ok: true, data: result }));
    });

    expect(screen.queryByText("short of parts")).toBeNull();
    expect(screen.queryByText(/scrap-adjusted requirements/)).toBeNull();
    expect(screen.queryByText("OLD-ORG")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("ignores deferred cost previews and resets production targets on an organization change", async () => {
    let resolvePreview: ((response: Response) => void) | undefined;
    const fetchMock = manufacturingFetch({
      onPost: (body) => body.action === "costPreview"
        ? new Promise<Response>((resolve) => { resolvePreview = resolve; })
        : Response.json({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: "Produce" }));
    fireEvent.change(screen.getByLabelText("Produce assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Units to build"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Lot code"), { target: { value: "OLD-LOT" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview cost" }));
    await waitFor(() => expect(resolvePreview).toBeDefined());

    rerender(<ManufacturingPage actorId="actor-1" organizationId="org-2" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    expect((screen.getByLabelText("Produce assembly SKU") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Units to build") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Lot code") as HTMLInputElement).value).toBe("");
    await act(async () => {
      resolvePreview?.(Response.json({ ok: true, data: {
        producible: true,
        lines: [{ sku: "OLD-ORG", name: "Old organization item", requiredThousandths: 1000, unitCostMinor: 10, costMinor: 10 }],
        totalCostMinor: 10,
        resultingAvgFinishedUnitCostMinor: 10,
      } }));
    });

    expect(screen.queryByText("producible")).toBeNull();
    expect(screen.queryByText("OLD-ORG")).toBeNull();
  });

  it("resets prior organization form values and manual run target after scope changes", async () => {
    vi.stubGlobal("fetch", manufacturingFetch());
    const { rerender } = render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    fireEvent.change(screen.getByLabelText("Work order assembly SKU"), { target: { value: "OLD-DESK" } });
    fireEvent.change(screen.getByLabelText("Work order note"), { target: { value: "Old organization note" } });
    fireEvent.click(screen.getByRole("button", { name: "Runs & lots" }));
    fireEvent.change(screen.getByLabelText("Run id to reverse"), { target: { value: "old-org-run" } });

    rerender(<ManufacturingPage actorId="actor-1" organizationId="org-2" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    expect((screen.getByLabelText("Run id to reverse") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    expect((screen.getByLabelText("Work order assembly SKU") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Work order note") as HTMLInputElement).value).toBe("");
  });

  it("keeps production input and reversal target through Go approval pending", async () => {
    vi.stubGlobal("__GO_MANUFACTURING_PRODUCTION_WRITES__", true);
    const responses = new Map<string, number>();
    const fetchMock = manufacturingFetch({
      onPost: (body) => {
        const action = String(body.action);
        const count = (responses.get(action) ?? 0) + 1;
        responses.set(action, count);
        if (count === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Supervisor review" }, { status: 202 });
        if (action === "produceFromBom") return Response.json({ ok: true, data: {
          runRef: "33333333-3333-4333-8333-333333333333", producedThousandths: 2000,
          consumedComponents: [{ sku: "LEG-1", quantityThousandths: 8000 }], costRolledUpMinor: 24000,
        } });
        return Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^Produce$/ }));
    fireEvent.change(screen.getByLabelText("Produce assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Units to build"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Lot code"), { target: { value: "LOT-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Produce now" }));
    expect(await screen.findByText(/Produce DESK-1 requires approval/)).not.toBeNull();
    expect((screen.getByLabelText("Produce assembly SKU") as HTMLInputElement).value).toBe("DESK-1");
    expect((screen.getByLabelText("Units to build") as HTMLInputElement).value).toBe("2");
    const lotCodeInput = screen.getByLabelText("Lot code") as HTMLInputElement;
    expect(lotCodeInput.value).toBe("LOT-1");
    expect(lotCodeInput.maxLength).toBe(40);
    const firstProductionRequest = fetchMock.mock.calls.find(([url]) => url === "/api/capabilities/execute");
    const firstProductionBody = JSON.parse(String((firstProductionRequest?.[1] as RequestInit).body)) as PostedBody;
    fireEvent.click(screen.getByRole("button", { name: "Produce now" }));
    await waitFor(() => expect(responses.get("produceFromBom")).toBe(2));

    const productionRequests = fetchMock.mock.calls
      .filter(([url]) => url === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PostedBody);
    expect(productionRequests[1]?.intentId).toBe(firstProductionBody.intentId);

    fireEvent.click(screen.getByRole("button", { name: /^Runs & lots/ }));
    const runId = "44444444-4444-4444-8444-444444444444";
    fireEvent.change(screen.getByLabelText("Run id to reverse"), { target: { value: runId } });
    const reverseSection = screen.getByRole("heading", { name: "Reverse a run manually" }).closest("section");
    if (!reverseSection) throw new Error("manual reversal section missing");
    fireEvent.click(within(reverseSection).getByRole("button", { name: "Reverse" }));
    expect(await screen.findByText(/Reverse run requires approval/)).not.toBeNull();
    expect((screen.getByLabelText("Run id to reverse") as HTMLInputElement).value).toBe(runId);
    const lastCapabilityRequest = fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities/execute").at(-1);
    expect(JSON.parse(String((lastCapabilityRequest?.[1] as RequestInit).body))).toMatchObject({
      capabilityId: "manufacturing.reverseProductionRun", input: { runRef: runId },
    });
  });

  it("rejects a work order quantity above the database integer limit before submission", async () => {
    vi.stubGlobal("__GO_MANUFACTURING_WORK_ORDER_WRITES__", true);
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    fireEvent.change(screen.getByLabelText("Work order assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Planned units"), { target: { value: "2147484" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/supported planned quantity/)).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/capabilities/execute")).toBe(false);
  });

  it("lists production runs, reverses them, and links lots to upstream traceability", async () => {
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: "Runs & lots" }));
    expect(await screen.findByRole("heading", { name: "Production history" })).not.toBeNull();
    expect(screen.getByText("LEG-1×8.000[LEG-MAY]")).not.toBeNull();
    expect(screen.getByText("reversed")).not.toBeNull();
    expect(screen.getByRole("link", { name: "trace upstream" }).getAttribute("href")).toBe("/api/manufacturing?sku=LEG-1&lotCode=LEG-MAY");

    const reverseButtons = screen.getAllByRole("button", { name: "Reverse" });
    fireEvent.click(reverseButtons[0] as HTMLButtonElement);
    await waitFor(() => expect(postedActions(fetchMock).some((body) => body.action === "reverseProductionRun" && body.runId === "run-1")).toBe(true));

    fireEvent.change(screen.getByLabelText("Run id to reverse"), { target: { value: "run-0" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reverse" })[1] as HTMLButtonElement);
    await waitFor(() => expect(postedActions(fetchMock).filter((body) => body.action === "reverseProductionRun").length).toBe(2));
  });

  it("keeps manufacturing hidden and unfetched when the module is switched off", async () => {
    const fetchMock = manufacturingFetch({ enabled: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage />);

    expect(await screen.findByRole("heading", { name: "Manufacturing is turned off" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a load failure and recovers on retry", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      attempt += 1;
      return attempt === 1
        ? Response.json({ ...report, workOrders: [{ ...report.workOrders[0], plannedQtyThousandths: 1.5 }] })
        : Response.json(report);
    }));
    render(<ManufacturingPage />);

    expect(await screen.findByRole("heading", { name: "Could not load manufacturing records" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Manufacturing" })).not.toBeNull();
    expect(attempt).toBe(2);
  });

  it("announces the loading state and renders an empty workspace once data arrives", async () => {
    let resolveReport: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (input === "/api/modules") return Promise.resolve(Response.json(switchboard));
      return new Promise<Response>((resolve) => { resolveReport = resolve; });
    }));
    render(<ManufacturingPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading bills of materials");
    await waitFor(() => expect(resolveReport).toBeDefined());
    await act(async () => { resolveReport?.(Response.json({})); });

    expect(await screen.findByRole("heading", { name: "Manufacturing" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    expect(await screen.findByRole("heading", { name: "No bills of materials yet" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    expect(await screen.findByRole("heading", { name: "No work orders yet" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Runs & lots" }));
    expect(await screen.findByText(/No runs yet/)).not.toBeNull();
  });
});
