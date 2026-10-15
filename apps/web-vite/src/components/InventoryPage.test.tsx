import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryPage } from "./InventoryPage";

const items = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    sku: "MUG-1",
    name: "Ceramic mug",
    kind: "goods",
    unitLabel: "unit",
    salePriceMinor: 1_500,
    imageUrl: null,
    tags: [],
    barcode: null,
    onHandThousandths: 4_000,
    valueMinor: 2_000,
    avgUnitCostMinor: 500,
    reservedThousandths: 1_000,
    availableThousandths: 3_000,
    totalValueMinor: 2_000,
    reorderPointThousandths: 5_000,
    reorderNeeded: true,
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    sku: "DESK-2",
    name: "Oak desk",
    kind: "goods",
    unitLabel: "unit",
    salePriceMinor: 12_000,
    imageUrl: null,
    tags: [],
    barcode: null,
    onHandThousandths: 2_000,
    valueMinor: 10_000,
    avgUnitCostMinor: 5_000,
    reservedThousandths: 0,
    availableThousandths: 2_000,
    totalValueMinor: 10_000,
    reorderPointThousandths: 1_000,
    reorderNeeded: false,
  },
];
const switchboard = {
  catalog: [{ id: "inventory", label: "Inventory", description: "Stock ledger", href: "/inventory" }],
  enabledModules: ["inventory"],
  usingDefaults: false,
};
const report = {
  items,
  totalValueMinor: 12_000,
  reorderAlerts: [{ sku: "MUG-1", name: "Ceramic mug", onHandThousandths: 4_000, reorderPointThousandths: 5_000, shortfallThousandths: 1_000, avgUnitCostMinor: 500 }],
  lots: [],
  locations: [],
  cycleCounts: [],
  transfers: [],
  reservations: [],
};

function inventoryFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (input === "/api/modules") return Response.json(switchboard);
    return Response.json(report);
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Vite inventory page", () => {
  it("waits for actor and organization scope before showing Go location and reservation writes", async () => {
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    vi.stubGlobal("fetch", inventoryFetch());
    render(<InventoryPage />);

    expect(await screen.findByText("Loading the active workspace before location and reservation actions are available.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Create location" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reserve stock" })).toBeNull();
  });

  it("shows stock availability and reorder filters with item search", async () => {
    const fetchMock = inventoryFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Inventory" })).not.toBeNull();
    expect(screen.getByText("$120.00")).not.toBeNull();
    expect(screen.getByText("4 units")).not.toBeNull();
    expect(screen.getByText("3 units")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.any(Object));

    fireEvent.click(screen.getByRole("button", { name: "Reorder needed" }));
    expect(screen.getByRole("button", { name: "Reorder needed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("MUG-1")).not.toBeNull();
    expect(screen.queryByText("DESK-2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All items" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find an item" }), { target: { value: "oak" } });
    expect(screen.getByText("DESK-2")).not.toBeNull();
    expect(screen.queryByText("MUG-1")).toBeNull();
  });

  it("shows read-only lot details and balances from the Go report", async () => {
    const lots = [
      { id: "66666666-6666-4666-8666-666666666666", sku: "MUG-1", lotCode: "MUG-MAR-26", expiresAt: "2026-03-12T00:00:00.000Z", balanceThousandths: 1_500 },
      { id: "77777777-7777-4777-8777-777777777777", sku: "DESK-2", lotCode: "DESK-APR-26", expiresAt: null, balanceThousandths: 0 },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      return Response.json({ ...report, lots });
    }));
    render(<InventoryPage />);

    expect(await screen.findByRole("heading", { name: "Inventory lots" })).not.toBeNull();
    expect(screen.getAllByRole("columnheader", { name: "SKU" })).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "Lot code" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Expiry date" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Current balance" })).not.toBeNull();
    expect(screen.getByText("MUG-MAR-26")).not.toBeNull();
    expect(screen.getByText("Mar 12, 2026")).not.toBeNull();
    expect(screen.getByText("1.5 units")).not.toBeNull();
    const noExpiryLotRow = screen.getByText("DESK-APR-26").closest("tr");
    expect(noExpiryLotRow).not.toBeNull();
    expect(within(noExpiryLotRow!).getByText("No expiry date")).not.toBeNull();
    expect(within(noExpiryLotRow!).getByText("0 units")).not.toBeNull();
    expect(screen.queryByRole("link", { name: /inventory workspace/i })).toBeNull();
  });

  it("shows read-only stock locations with their codes and names", async () => {
    const locations = [
      { id: "88888888-8888-4888-8888-888888888888", orgId: "11111111-1111-4111-8111-111111111111", code: "MAIN", name: "Main warehouse", createdAt: "2026-05-12T10:30:00.000Z" },
      { id: "99999999-9999-4999-8999-999999999999", orgId: "11111111-1111-4111-8111-111111111111", code: "SHOP", name: "Retail shop", createdAt: "2026-05-12T10:30:00.000Z" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      return Response.json({ ...report, locations });
    }));
    render(<InventoryPage />);

    expect(await screen.findByRole("heading", { name: "Stock locations" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Location code" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Location name" })).not.toBeNull();
    expect(screen.getByRole("rowheader", { name: "MAIN" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "Main warehouse" })).not.toBeNull();
    expect(screen.getByRole("rowheader", { name: "SHOP" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "Retail shop" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: /inventory workspace/i })).toBeNull();
  });

  it("shows cycle count history and governed count actions", async () => {
    const cycleCounts = [{
      id: "d2b53ec3-1b61-4f05-a56f-4a0f9d4d3571",
      status: "open",
      note: "Aisle check",
      locationCode: "MAIN",
      createdAt: "2026-05-12T10:30:00.000Z",
      lines: [
        { sku: "MUG-1", expectedThousandths: 4_000, countedThousandths: 3_750, varianceThousandths: -250 },
        { sku: "DESK-2", expectedThousandths: 2_000, countedThousandths: null, varianceThousandths: null },
        { sku: "NEG-3", expectedThousandths: -250, countedThousandths: 0, varianceThousandths: 250 },
      ],
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      return Response.json({ ...report, cycleCounts });
    }));
    render(<InventoryPage />);

    expect(await screen.findByRole("heading", { name: "Set up a stock count" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: /Count of/ })).not.toBeNull();
    expect(screen.getByText("open")).not.toBeNull();
    expect(screen.getByText("Aisle check")).not.toBeNull();
    expect(screen.getByRole("heading", { name: /MAIN$/ })).not.toBeNull();
    expect(screen.getByText("2 of 3 items counted")).not.toBeNull();
    expect(screen.getByText("Expected: 4 units")).not.toBeNull();
    expect(screen.getByText("Counted: 3.75 units")).not.toBeNull();
    expect(screen.getByText("Difference: -0.25 units")).not.toBeNull();
    expect(screen.getByText("Counted: -")).not.toBeNull();
    expect(screen.getByText("Difference: -")).not.toBeNull();
    expect(screen.getByText("Difference: +0.25 units")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Start count sheet" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(3);
  });

  it("shows transfer history in API order and exposes governed transfer actions", async () => {
    const transfers = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        number: 42,
        status: "partial",
        note: "Urgent restock",
        from: "MAIN",
        to: "SHOP",
        lines: [
          { lineId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sku: "MUG-1", quantityThousandths: 2_500, confirmedThousandths: 1_000 },
          { lineId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sku: "DESK-2", quantityThousandths: 500, confirmedThousandths: 0 },
        ],
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        number: 41,
        status: "cancelled",
        note: null,
        from: "SHOP",
        to: "MAIN",
        lines: [{ lineId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sku: "MUG-1", quantityThousandths: 1_000, confirmedThousandths: 1_000 }],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      return Response.json({ ...report, transfers });
    }));
    render(<InventoryPage />);

    expect(await screen.findByRole("heading", { name: "Stock transfers" })).not.toBeNull();
    expect(screen.getByText("#42")).not.toBeNull();
    expect(screen.getByText("#41")).not.toBeNull();
    expect(screen.getByText("(partial)")).not.toBeNull();
    expect(screen.getByText("(cancelled)")).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("Urgent restock") === true)).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("MUG-1 1/2.5") === true)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Confirm remaining" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Draft transfer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("connects Go reservations, locations, and stock history to the inventory page", async () => {
    const organizationId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const reservations = Array.from({ length: 100 }, (_, index) => ({
      id: `07363742-7f2b-4b18-8f65-${index.toString(16).padStart(12, "0")}`,
      orgId: organizationId,
      itemId: "39b78356-54ed-4cc0-8d87-30a628740df7",
      sku: "MUG-1",
      quantityThousandths: 500,
      reason: index === 0 ? "Hold for customer pickup" : `Hold for customer pickup ${index}`,
      refType: null,
      refId: null,
      status: "open",
      createdByActorType: "human",
      createdByActorId: null,
      releasedAt: null,
      createdAt: "2026-05-12T10:30:00.000Z",
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { reservations } });
      return Response.json({ ...report, locations: [{ id: "88888888-8888-4888-8888-888888888888", orgId: organizationId, code: "MAIN", name: "Main warehouse", createdAt: "2026-05-12T10:30:00.000Z" }], reservations });
    }));
    render(<InventoryPage actorId="actor-inventory-test" organizationId={organizationId} />);

    expect(await screen.findByRole("heading", { name: "Locations and reservations" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Movement history" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Create location" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reserve stock" })).not.toBeNull();
    expect(await screen.findByText((_, element) => element?.tagName === "SPAN" && element.textContent === "0.5 · Hold for customer pickup")).not.toBeNull();
    expect((await screen.findAllByRole("button", { name: "Release" })).length).toBe(100);
    expect(screen.getByText("Showing the 100 most recent open reservations. Older reservations are not shown here.")).not.toBeNull();
  });

  it("hides prior-organization reservations synchronously and ignores a late response", async () => {
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const actorId = "actor-inventory-test";
    const oldOrganizationId = "0569aacb-58c3-4a30-8afe-3554e38eb2ce";
    const newOrganizationId = "6670af8c-3e8a-46a4-b28d-8cb9e8dd4b60";
    const resolvers = new Map<string, Array<(response: Response) => void>>();
    const makeReservations = (orgId: string, reason: string) => [{
      id: orgId === oldOrganizationId ? "07363742-7f2b-4b18-8f65-6874f17e88e4" : "869b98f1-a55d-44d9-ae42-4f8c2428fd04",
      orgId,
      itemId: "39b78356-54ed-4cc0-8d87-30a628740df7",
      sku: "MUG-1",
      quantityThousandths: 500,
      reason,
      refType: null,
      refId: null,
      status: "open",
      createdByActorType: "human",
      createdByActorId: null,
      releasedAt: null,
      createdAt: "2026-05-12T10:30:00.000Z",
    }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json(switchboard);
      if (path === "/api/inventory") return Response.json(report);
      if (path === "/api/capabilities/execute") {
        const organizationId = new Headers(init?.headers).get("X-Organization-ID") ?? "";
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "inventory.releaseReservation") {
          return Response.json({ ok: true, data: { released: true } });
        }
        if (body.capabilityId !== "inventory.listReservations") {
          return Response.json({ ok: true, data: {} });
        }
        return new Promise<Response>((resolve) => {
          const pending = resolvers.get(organizationId) ?? [];
          pending.push(resolve);
          resolvers.set(organizationId, pending);
        });
      }
      throw new Error(`Unexpected inventory request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<InventoryPage actorId={actorId} organizationId={oldOrganizationId} />);
    expect(await screen.findByRole("heading", { name: "Inventory" })).not.toBeNull();
    await waitFor(() => expect(resolvers.get(oldOrganizationId)?.length).toBeGreaterThanOrEqual(1));

    await act(async () => {
      const pending = resolvers.get(oldOrganizationId) ?? [];
      pending[pending.length - 1]?.(Response.json({ ok: true, data: { reservations: makeReservations(oldOrganizationId, "Old workspace hold") } }));
    });
    expect(await screen.findByText(/Old workspace hold/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    const oldRequestsBeforeRefresh = resolvers.get(oldOrganizationId)?.length ?? 0;
    await waitFor(() => expect(resolvers.get(oldOrganizationId)?.length).toBeGreaterThan(oldRequestsBeforeRefresh));
    const lateOldRequestIndex = (resolvers.get(oldOrganizationId)?.length ?? 1) - 1;
    rerender(<InventoryPage actorId={actorId} organizationId={newOrganizationId} />);
    expect(screen.queryByText(/Old workspace hold/)).toBeNull();
    await waitFor(() => expect(resolvers.get(newOrganizationId)?.length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText("Loading reservations…")).not.toBeNull();

    await act(async () => {
      resolvers.get(oldOrganizationId)?.[lateOldRequestIndex]?.(Response.json({ ok: true, data: { reservations: makeReservations(oldOrganizationId, "Late old workspace hold") } }));
    });
    expect(screen.queryByText(/Old workspace hold|Late old workspace hold/)).toBeNull();

    await act(async () => {
      const pending = resolvers.get(newOrganizationId) ?? [];
      pending[pending.length - 1]?.(Response.json({ ok: true, data: { reservations: makeReservations(newOrganizationId, "Current workspace hold") } }));
    });
    expect(await screen.findByText(/Current workspace hold/)).not.toBeNull();
    expect(screen.queryByText(/Old workspace hold|Late old workspace hold/)).toBeNull();
  });

  it("keeps the newest inventory refresh when separate actions finish out of order", async () => {
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    vi.stubGlobal("__GO_INVENTORY_CYCLE_COUNT_WRITES__", true);
    let reportReads = 0;
    const postActions: string[] = [];
    let resolveOlderReport: ((response: Response) => void) | undefined;
    let resolveNewerReport: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return Response.json(switchboard);
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body)) as { action?: string; capabilityId?: string };
        const action = body.action ?? ({
          "inventory.createLocation": "createLocation",
          "inventory.createCycleCount": "createCycleCount",
        } as const)[body.capabilityId as "inventory.createLocation" | "inventory.createCycleCount"];
        postActions.push(action ?? "unknown");
        return action === "createLocation"
          ? Response.json({ ok: true, data: { locationId: "99999999-9999-4999-8999-999999999999" } })
          : Response.json({ ok: true, data: { countId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", lineCount: 2 } });
      }
      reportReads += 1;
      if (reportReads === 1) return Response.json({ ...report, reservations: [] });
      if (reportReads === 2) return new Promise<Response>((resolve) => { resolveOlderReport = resolve; });
      return new Promise<Response>((resolve) => { resolveNewerReport = resolve; });
    }));
    render(<InventoryPage actorId="actor-1" organizationId="org-1" />);
    expect(await screen.findByRole("heading", { name: "Inventory" })).not.toBeNull();

    const locationForm = screen.getByRole("heading", { name: "Create a stock location" }).closest("form");
    if (!locationForm) throw new Error("Expected stock location form");
    fireEvent.change(within(locationForm).getByLabelText("Location code"), { target: { value: "SHOP" } });
    fireEvent.change(within(locationForm).getByLabelText("Location name"), { target: { value: "Retail shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create location" }));
    await waitFor(() => expect(reportReads).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "Start count sheet" }));
    await waitFor(() => expect(postActions).toContain("createCycleCount"));
    await waitFor(() => expect(reportReads).toBe(3));

    const newerCycleCount = {
      id: "d2b53ec3-1b61-4f05-a56f-4a0f9d4d3571",
      status: "open",
      note: "Scheduled cycle count",
      locationCode: null,
      createdAt: "2026-05-12T10:30:00.000Z",
      lines: [],
    };
    await act(async () => { resolveNewerReport?.(Response.json({ ...report, cycleCounts: [newerCycleCount] })); });
    expect(await screen.findByText("Scheduled cycle count")).not.toBeNull();

    await act(async () => { resolveOlderReport?.(Response.json({ ...report, cycleCounts: [] })); });
    expect(screen.getByText("Scheduled cycle count")).not.toBeNull();
  });

  it("does not start a refresh when an action finishes after the page unmounts", async () => {
    vi.stubGlobal("__GO_INVENTORY_LOCATION_RESERVATION_WRITES__", true);
    const actorId = "actor-1";
    const organizationId = "org-1";
    let resolveLocationAction: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/modules") return Response.json(switchboard);
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => { resolveLocationAction = resolve; });
      }
      return Response.json(report);
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = render(<InventoryPage actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("heading", { name: "Create a stock location" })).not.toBeNull();

    const locationForm = screen.getByRole("heading", { name: "Create a stock location" }).closest("form");
    if (!locationForm) throw new Error("Expected stock location form");
    fireEvent.change(within(locationForm).getByLabelText("Location code"), { target: { value: "SHOP" } });
    fireEvent.change(within(locationForm).getByLabelText("Location name"), { target: { value: "Retail shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create location" }));
    await waitFor(() => expect(resolveLocationAction).toBeTypeOf("function"));

    const reportReadsBeforeUnmount = fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/inventory" && (init?.method ?? "GET") !== "POST",
    ).length;
    page.unmount();
    await act(async () => { resolveLocationAction?.(Response.json({ ok: true, data: { locationId: "99999999-9999-4999-8999-999999999999" } })); });

    const reportReadsAfterUnmount = fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/inventory" && (init?.method ?? "GET") !== "POST",
    ).length;
    expect(reportReadsAfterUnmount).toBe(reportReadsBeforeUnmount);
  });

  it("does not let an old organization's child refresh supersede the active organization's load", async () => {
    const actorId = "actor-1";
    const oldOrganizationId = "org-1";
    const newOrganizationId = "org-2";
    let resolveAction: ((response: Response) => void) | undefined;
    let resolveNewReport: ((response: Response) => void) | undefined;
    const requests: Array<{ path: string; org: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const org = new Headers(init?.headers).get("X-Organization-ID");
      requests.push({ path, org });
      if (path === "/api/modules") return Response.json(switchboard);
      if (init?.method === "POST") return new Promise<Response>((resolve) => { resolveAction = resolve; });
      if (org === newOrganizationId) return new Promise<Response>((resolve) => { resolveNewReport = resolve; });
      return Response.json(report);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<InventoryPage actorId={actorId} organizationId={oldOrganizationId} />);
    expect(await screen.findByRole("heading", { name: "Create a stock location" })).not.toBeNull();

    const locationForm = screen.getByRole("heading", { name: "Create a stock location" }).closest("form");
    if (!locationForm) throw new Error("Expected stock location form");
    fireEvent.change(within(locationForm).getByLabelText("Location code"), { target: { value: "SHOP" } });
    fireEvent.change(within(locationForm).getByLabelText("Location name"), { target: { value: "Retail shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create location" }));
    await waitFor(() => expect(resolveAction).toBeTypeOf("function"));

    rerender(<InventoryPage actorId={actorId} organizationId={newOrganizationId} />);
    await waitFor(() => expect(requests.filter((request) => request.path === "/api/inventory" && request.org === newOrganizationId)).toHaveLength(1));
    await act(async () => { resolveAction?.(Response.json({ ok: true, data: { locationId: "99999999-9999-4999-8999-999999999999" } })); });

    expect(requests.filter((request) => request.path === "/api/modules")).toEqual([
      { path: "/api/modules", org: oldOrganizationId },
      { path: "/api/modules", org: newOrganizationId },
    ]);
    await act(async () => { resolveNewReport?.(Response.json(report)); });
    expect(await screen.findByRole("heading", { name: "Inventory" })).not.toBeNull();
  });

  it("shows movement costs in organization currency when the display preference differs", async () => {
    document.cookie = "chaste_display_currency=; Max-Age=0; path=/";
    localStorage.setItem("chaste-prefs", JSON.stringify({ currency: "UGX" }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (String(input).startsWith("/api/inventory?sku=")) {
        return Response.json({ movements: [{
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          quantityDelta: 1_000,
          reason: "adjustment",
          note: null,
          refType: null,
          unitCostMinor: 1_000,
          lotCode: null,
          locationCode: null,
          actorType: "human",
          createdAt: "2026-09-30T10:15:00.000Z",
        }], hasMore: false });
      }
      return Response.json(report);
    }));
    render(<InventoryPage baseCurrency="USD" />);

    fireEvent.click(await screen.findByRole("button", { name: "Load history" }));
    expect(await screen.findByText("$10.00")).toBeTruthy();
  });

  it("announces an empty lot list and keeps loading and failures accessible", async () => {
    let resolveReport: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (input === "/api/modules") return Promise.resolve(Response.json(switchboard));
      return new Promise<Response>((resolve) => { resolveReport = resolve; });
    }));
    render(<InventoryPage />);

    expect(screen.getByRole("status").textContent).toContain("Loading stock levels");
    await waitFor(() => expect(resolveReport).toBeDefined());
    await act(async () => { resolveReport?.(Response.json(report)); });
    expect(await screen.findByText("No inventory lots recorded yet.")).not.toBeNull();
    expect(screen.getByText("No transfers yet.")).not.toBeNull();
    expect(screen.getByText("No stock locations recorded yet.")).not.toBeNull();
  });

  it("does not request stock data when Inventory is disabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ...switchboard, enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryPage />);

    expect(await screen.findByRole("heading", { name: "Inventory is turned off" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports malformed responses and allows a retry", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      attempt += 1;
      return attempt === 1
        ? Response.json({ ...report, cycleCounts: [{ id: "d2b53ec3-1b61-4f05-a56f-4a0f9d4d3571", status: "open", note: null, locationCode: null, createdAt: "not-a-date", lines: [] }] })
        : Response.json(report);
    }));
    render(<InventoryPage />);

    expect(await screen.findByRole("heading", { name: "Could not load stock levels" })).not.toBeNull();
    expect(screen.getByRole("alert")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("MUG-1")).not.toBeNull();
    expect(attempt).toBe(2);
  });

  it("formats value using the active currency's minor-unit scale", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      return Response.json({ ...report, totalValueMinor: 1_234_560 });
    }));
    render(<InventoryPage baseCurrency="BHD" />);

    expect(await screen.findByText((value) => value.includes("1,234.560"))).not.toBeNull();
  });
});
