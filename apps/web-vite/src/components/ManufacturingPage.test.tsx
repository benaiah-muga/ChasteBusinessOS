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
      runId: "33333333-3333-4333-8333-333333333333", occurredAt: "2026-05-12T11:00:00.000Z", assemblySku: "DESK-1",
      producedThousandths: 2000, unitCostMinor: 12_000, costTotalMinor: 24_000, reversed: false,
      components: [{ sku: "LEG-1", quantityThousandths: 8000, lotCode: "LEG-MAY" }],
    },
    {
      runId: "44444444-4444-4444-8444-444444444444", occurredAt: "2026-05-10T11:00:00.000Z", assemblySku: "DESK-1",
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

function manufacturingWriteResult(action: PostedBody): PostedBody {
  switch (action.action) {
    case "defineBom": return { assemblyItemId: "item-1", assemblySku: action.assemblySku, componentCount: Array.isArray(action.components) ? action.components.length : 0, previousComponents: action.expectedComponents, components: action.components };
    case "deleteBom": return { assemblySku: action.assemblySku, removedCount: 1, previousComponents: action.expectedComponents, components: [] };
    case "restoreBom": return { assemblySku: action.assemblySku, restoredCount: Array.isArray(action.components) ? action.components.length : 0, previousComponents: action.expectedComponents, components: action.components };
    case "createWorkOrder": return { workOrderId: "55555555-5555-4555-8555-555555555555", number: 10, expectedGoodThousandths: action.plannedQtyThousandths };
    case "releaseWorkOrder": return { released: true };
    case "completeWorkOrder": return { runRef: "66666666-6666-4666-8666-666666666666", completed: true, producedTotalThousandths: action.quantityThousandths, status: "released", producedThousandths: action.quantityThousandths, consumedComponents: [], costRolledUpMinor: 0 };
    case "cancelWorkOrder": return { cancelled: true };
    case "produceFromBom": return { runRef: "77777777-7777-4777-8777-777777777777", producedThousandths: action.quantityThousandths, consumedComponents: [], costRolledUpMinor: 0 };
    case "reverseProductionRun": return { reversedMovements: 0, removedFinishedThousandths: 0, restoredComponents: [], removedProduced: [] };
    default: return {};
  }
}

function manufacturingFetch({ onPost, payload = report, enabled = true }: StubOptions = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/modules") {
      return Response.json({ catalog: switchboard.catalog, enabledModules: enabled ? ["manufacturing"] : [] });
    }
    if ((input === "/api/manufacturing" || input === "/api/capabilities/execute") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as PostedBody;
      const action = typeof body.capabilityId === "string" && typeof body.input === "object" && body.input !== null
        ? { ...(body.input as PostedBody), action: body.capabilityId.split(".").at(-1), intentId: body.intentId,
            ...(body.capabilityId === "manufacturing.reverseProductionRun" ? { runId: (body.input as PostedBody).runRef } : {}) }
        : body;
      if (action.action === "overviewReport") return Response.json({ ok: true, data: payload });
      if (action.action === "bomTree") return Response.json({ ok: true, data: {
        hasBom: true,
        root: {
          sku: "DESK-1", name: "Oak desk", quantityThousandths: 1000, scrapPctThousandths: 0,
          children: [{
            sku: "LEG-1", name: "Oak leg", quantityThousandths: 4000, scrapPctThousandths: 20_000,
            children: [{ sku: "FOOT-1", name: "Rubber foot", quantityThousandths: 8_000, scrapPctThousandths: 10_000, children: [] }],
          }],
        },
      } });
      const result = onPost ? await onPost(action) : Response.json({ ok: true, data: manufacturingWriteResult(action) });
      if (result.status === 200) {
        const envelope = await result.clone().json() as { data?: unknown };
        if (typeof envelope.data === "object" && envelope.data !== null && Object.keys(envelope.data).length === 0) {
          return Response.json({ ok: true, data: manufacturingWriteResult(action) });
        }
      }
      return result;
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
        ? { ...(body.input as PostedBody), action: body.capabilityId.split(".").at(-1), intentId: body.intentId,
            ...(body.capabilityId === "manufacturing.reverseProductionRun" ? { runId: (body.input as PostedBody).runRef } : {}) }
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
  it("recovers an uncertain saved action after reload and retries its exact Go intent", async () => {
    let attempts = 0;
    const fetchMock = manufacturingFetch({ onPost: (body) => {
      if (body.action !== "defineBom") return Response.json({ ok: true, data: manufacturingWriteResult(body) });
      attempts += 1;
      if (attempts === 1) return Response.json({ error: "temporary server failure" }, { status: 500 });
      return Response.json({ ok: true, data: manufacturingWriteResult(body) });
    } });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.change(screen.getByLabelText("Assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Component SKU 1"), { target: { value: "LEG-1" } });
    fireEvent.change(screen.getByLabelText("Component 1 quantity per unit"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save BOM" }));
    await screen.findByRole("button", { name: "Retry saved action" });
    const writes = () => fetchMock.mock.calls
      .filter(([url]) => url === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PostedBody)
      .filter((body) => body.capabilityId === "manufacturing.defineBom");
    expect(writes()).toHaveLength(1);

    cleanup();
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved action" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual(writes()[0]);
  }, 60_000);

  it("keeps the retry affordance visible after a 404 so the saved Go intent can be replayed", async () => {
    let attempts = 0;
    const fetchMock = manufacturingFetch({ onPost: (body) => {
      if (body.action !== "defineBom") return Response.json({ ok: true, data: manufacturingWriteResult(body) });
      attempts += 1;
      if (attempts === 1) return Response.json({ error: "route temporarily unavailable" }, { status: 404 });
      return Response.json({ ok: true, data: manufacturingWriteResult(body) });
    } });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.change(screen.getByLabelText("Assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Component SKU 1"), { target: { value: "LEG-1" } });
    fireEvent.change(screen.getByLabelText("Component 1 quantity per unit"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save BOM" }));
    const retry = await screen.findByRole("button", { name: "Retry saved action" });
    const writes = () => fetchMock.mock.calls
      .filter(([url]) => url === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PostedBody)
      .filter((body) => body.capabilityId === "manufacturing.defineBom");
    expect(writes()).toHaveLength(1);
    fireEvent.click(retry);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual(writes()[0]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saved action" })).toBeNull());
  }, 60_000);

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
    expect(screen.queryByRole("link", { name: "Open full manufacturing workspace" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({ method: "POST" }));
  });

  it("navigates from an overview stat card to the matching tab", async () => {
    vi.stubGlobal("fetch", manufacturingFetch());
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByText("Open work orders"));
    expect(await screen.findByRole("heading", { name: "Plan a work order" })).not.toBeNull();
    expect(window.location.search).toBe("?tab=orders");
  });

  it("loads and renders the nested BOM tree from the Go capability", async () => {
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    expect(await screen.findByRole("heading", { name: "Define / replace a bill of materials" })).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === "LI" && element.textContent?.includes("Oak leg (LEG-1) × 4.000 · scrap 2.0%") === true)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "tree" }));
    expect(await screen.findByRole("columnheader", { name: "Qty for 1 assembly" })).not.toBeNull();
    expect(screen.getByText("4.000")).not.toBeNull();
    expect(screen.getByText("8.000")).not.toBeNull();
    const treeCall = fetchMock.mock.calls.find(([, init]) =>
      typeof init?.body === "string" && (JSON.parse(init.body) as { capabilityId?: string }).capabilityId === "manufacturing.bomTree",
    );
    expect(JSON.parse(String(treeCall?.[1]?.body))).toMatchObject({
      input: { assemblySku: "DESK-1", quantityThousandths: 1000 },
      intentId: expect.any(String),
    });
  });

  it("toggles undo and redo through Go while preserving the exact BOM snapshots", async () => {
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete BOM" }));
    await screen.findByRole("button", { name: "Undo BOM change" });
    fireEvent.click(screen.getByRole("button", { name: "Undo BOM change" }));

    await screen.findByRole("button", { name: "Redo BOM change" });
    fireEvent.click(screen.getByRole("button", { name: "Redo BOM change" }));
    await screen.findByRole("button", { name: "Undo BOM change" });
    fireEvent.click(screen.getByRole("button", { name: "Undo BOM change" }));
    await screen.findByRole("button", { name: "Redo BOM change" });

    const writes = postedActions(fetchMock).filter((action) => action.action === "deleteBom" || action.action === "restoreBom");
    expect(writes).toHaveLength(4);
    expect(writes[1]).toMatchObject({
      action: "restoreBom",
      assemblySku: "DESK-1",
      expectedComponents: [],
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    });
    expect(writes[2]).toMatchObject({
      action: "restoreBom",
      assemblySku: "DESK-1",
      expectedComponents: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
      components: [],
    });
    expect(writes[3]).toMatchObject({
      action: "restoreBom",
      assemblySku: "DESK-1",
      expectedComponents: [],
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    });
    expect(screen.getByText(/only if the BOM still matches the captured state/)).not.toBeNull();
  });

  it("sends a governed defineBom write with a stamped intent id and keeps approval pending visible", async () => {
    const fetchMock = manufacturingFetch({
      onPost: (body) => body.action === "defineBom"
        ? Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 })
        : Response.json({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

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
      expectedComponents: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
      components: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }],
    });
    expect(String(define?.intentId)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("deletes a BOM through Go without calling the legacy manufacturing endpoint", async () => {
    const fetchMock = manufacturingFetch({
      onPost: (body) => body.action === "overviewReport"
        ? Response.json({ ok: true, data: report })
        : body.action === "deleteBom"
          ? Response.json({ ok: true, data: { assemblySku: "DESK-1", removedCount: 1, previousComponents: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }], components: [] } })
          : Response.json({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete BOM" }));

    expect(await screen.findByText("Delete BOM DESK-1 done.")).not.toBeNull();
    const calls = fetchMock.mock.calls;
    expect(calls.some(([input]) => input === "/api/manufacturing")).toBe(false);
    const deletion = calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
      .find((body) => body.capabilityId === "manufacturing.deleteBom");
    expect(deletion).toMatchObject({
      capabilityId: "manufacturing.deleteBom",
      input: { assemblySku: "DESK-1", expectedComponents: [{ sku: "LEG-1", quantityThousandths: 4000, scrapPctThousandths: 20_000 }] },
      intentId: expect.any(String),
    });
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
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

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
            plannedThousandths: 2000,
            expectedGoodThousandths: 2000,
            producible: true,
            lines: [{ sku: "LEG-1", name: "Oak leg", requiredThousandths: 8000, unitCostMinor: 3000, costMinor: 24_000 }],
            totalCostMinor: 24_000,
            resultingAvgFinishedUnitCostMinor: 12_000,
          },
        })
        : Response.json({ ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

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
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/capabilities/execute" && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/manufacturing" && (init as RequestInit | undefined)?.method === "POST" && JSON.parse(String((init as RequestInit).body)).action === "costPreview")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Produce now" }));
    expect(await screen.findByText("Produce DESK-1 done.")).not.toBeNull();
    expect(postedActions(fetchMock).find((body) => body.action === "produceFromBom")).toMatchObject({ assemblySku: "DESK-1", quantityThousandths: 2000, lotCode: "DESK-MAY" });
  });

  it("routes production planning reads and overview through Go", async () => {
    const fetchMock = manufacturingFetch({
      onPost: (body) => {
        if (body.action === "overviewReport") return Response.json({ ok: true, data: report });
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
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

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
      "manufacturing.overviewReport",
      "manufacturing.checkProductionFeasibility",
      "manufacturing.bomReport",
      "manufacturing.costPreview",
    ]);
    expect(capabilityRequests.every((body) => typeof body.intentId === "string")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/manufacturing")).toBe(false);
  });

  it("drives work orders from draft through release, completion, and cancellation", async () => {
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

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
    const goRequests = fetchMock.mock.calls.filter(([url, init]) => url === "/api/capabilities/execute"
      && JSON.parse(String((init as RequestInit).body)).capabilityId === "manufacturing.createWorkOrder");
    expect(goRequests).toHaveLength(1);
    const firstBody = JSON.parse(String((goRequests[0]?.[1] as RequestInit).body)) as PostedBody;
    expect(firstBody).toMatchObject({ capabilityId: "manufacturing.createWorkOrder", input: { assemblySku: "DESK-1", plannedQtyThousandths: 4000, yieldPctThousandths: 1_000_000 } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(submissions).toBe(2));
    const retriedBody = fetchMock.mock.calls
      .filter(([url]) => url === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PostedBody)
      .filter((body) => body.capabilityId === "manufacturing.createWorkOrder")[1];
    expect(retriedBody?.intentId).toBe(firstBody.intentId);
    expect((screen.getByLabelText("Work order assembly SKU") as HTMLInputElement).value).toBe("");
  });

  it("does not apply a Go write response or refresh after the active organization changes", async () => {
    let resolveWrite: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/capabilities/execute" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as PostedBody;
        if (body.capabilityId === "manufacturing.overviewReport") return Response.json({ ok: true, data: report });
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
    const reportReads = fetchMock.mock.calls.filter(([input, init]) => input === "/api/capabilities/execute" && init?.method === "POST"
      && JSON.parse(String(init.body)).capabilityId === "manufacturing.overviewReport");
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
    const firstProductionBody = fetchMock.mock.calls
      .filter(([url]) => url === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PostedBody)
      .find((body) => body.capabilityId === "manufacturing.produceFromBom")!;
    fireEvent.click(screen.getByRole("button", { name: "Produce now" }));
    await waitFor(() => expect(responses.get("produceFromBom")).toBe(2));

    const productionRequests = fetchMock.mock.calls
      .filter(([url]) => url === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PostedBody)
      .filter((body) => body.capabilityId === "manufacturing.produceFromBom");
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
    const fetchMock = manufacturingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);
    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    fireEvent.change(screen.getByLabelText("Work order assembly SKU"), { target: { value: "DESK-1" } });
    fireEvent.change(screen.getByLabelText("Planned units"), { target: { value: "2147484" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText(/supported planned quantity/)).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/capabilities/execute"
      && JSON.parse(String((init as RequestInit).body)).capabilityId === "manufacturing.createWorkOrder")).toBe(false);
  });

  it("lists production runs, reverses them, and loads upstream traceability from Go", async () => {
    const fetchMock = manufacturingFetch({ onPost: (body) => {
      if (body.action === "lotTrace") return Response.json({ ok: true, data: {
        found: true, tree: [{ sku: "LEG-1", lotCode: "LEG-MAY", fedBy: [{ sku: "OAK-BOARD", lotCode: "OAK-APR", fedBy: [] }] }],
      } });
      return Response.json({ ok: true, data: {} });
    } });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: "Runs & lots" }));
    expect(await screen.findByRole("heading", { name: "Production history" })).not.toBeNull();
    expect(screen.getByText("LEG-1×8.000[LEG-MAY]")).not.toBeNull();
    expect(screen.getByText("reversed")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Trace upstream" }));
    expect(await screen.findByLabelText("Upstream trace for LEG-MAY")).not.toBeNull();
    expect(screen.getByText("OAK-APR")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/capabilities/execute" && (init as RequestInit | undefined)?.method === "POST" && JSON.parse(String((init as RequestInit).body)).capabilityId === "manufacturing.lotTrace")).toBe(true);

    const reverseButtons = screen.getAllByRole("button", { name: "Reverse" });
    fireEvent.click(reverseButtons[0] as HTMLButtonElement);
    await waitFor(() => expect(postedActions(fetchMock).some((body) => body.action === "reverseProductionRun" && body.runId === "33333333-3333-4333-8333-333333333333")).toBe(true));

    fireEvent.change(screen.getByLabelText("Run id to reverse"), { target: { value: "44444444-4444-4444-8444-444444444444" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reverse" })[1] as HTMLButtonElement);
    await waitFor(() => expect(postedActions(fetchMock).filter((body) => body.action === "reverseProductionRun").length).toBe(2));
  });

  it("keeps the latest lot trace when an earlier request resolves last", async () => {
    const deferred = new Map<string, (response: Response) => void>();
    const fetchMock = manufacturingFetch({
      payload: {
        ...report,
        lots: [
          ...report.lots,
          { id: "lot-2", sku: "LEG-1", lotCode: "LEG-JUN", expiresAt: null, balanceThousandths: 4000 },
        ],
      },
      onPost: (body) => new Promise<Response>((resolve) => {
        deferred.set(String(body.lotCode), resolve);
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    await screen.findByRole("heading", { name: "Manufacturing" });
    fireEvent.click(screen.getByRole("button", { name: "Runs & lots" }));
    const traceButtons = await screen.findAllByRole("button", { name: "Trace upstream" });
    fireEvent.click(traceButtons[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Trace upstream" })[0]!);
    await waitFor(() => expect(deferred.size).toBe(2));

    await act(async () => {
      deferred.get("LEG-JUN")?.(Response.json({ ok: true, data: {
        found: true, tree: [{ sku: "NEW-SOURCE", lotCode: "NEWEST", fedBy: [] }],
      } }));
    });
    expect(await screen.findByLabelText("Upstream trace for LEG-JUN")).not.toBeNull();

    await act(async () => {
      deferred.get("LEG-MAY")?.(Response.json({ ok: true, data: {
        found: true, tree: [{ sku: "OLD-SOURCE", lotCode: "STALE", fedBy: [] }],
      } }));
    });
    expect(screen.getByLabelText("Upstream trace for LEG-JUN")).not.toBeNull();
    expect(screen.queryByLabelText("Upstream trace for LEG-MAY")).toBeNull();
    expect(screen.getByText("NEWEST")).not.toBeNull();
    expect(screen.queryByText("STALE")).toBeNull();
  });

  it("keeps manufacturing hidden and unfetched when the module is switched off", async () => {
    const fetchMock = manufacturingFetch({ enabled: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    expect(await screen.findByRole("heading", { name: "Manufacturing is turned off" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a load failure and recovers on retry", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      attempt += 1;
      return attempt === 1
        ? Response.json({ ok: true, data: { ...report, workOrders: [{ ...report.workOrders[0], plannedQtyThousandths: 1.5 }] } })
        : Response.json({ ok: true, data: report });
    }));
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

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
    render(<ManufacturingPage actorId="actor-1" organizationId="org-1" />);

    expect(screen.getByRole("status").textContent).toContain("Loading bills of materials");
    await waitFor(() => expect(resolveReport).toBeDefined());
    await act(async () => { resolveReport?.(Response.json({ ok: true, data: {} })); });

    expect(await screen.findByRole("heading", { name: "Manufacturing" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^BOMs/ }));
    expect(await screen.findByRole("heading", { name: "No bills of materials yet" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Work orders/ }));
    expect(await screen.findByRole("heading", { name: "No work orders yet" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Runs & lots" }));
    expect(await screen.findByText(/No runs yet/)).not.toBeNull();
  });
});
