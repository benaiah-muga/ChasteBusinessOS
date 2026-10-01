import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryPage } from "./InventoryPage";

const items = [
  {
    sku: "MUG-1",
    name: "Ceramic mug",
    kind: "product",
    unitLabel: "unit",
    onHandThousandths: 4_000,
    reservedThousandths: 1_000,
    availableThousandths: 3_000,
    totalValueMinor: 2_000,
    reorderPointThousandths: 5_000,
    reorderNeeded: true,
  },
  {
    sku: "DESK-2",
    name: "Oak desk",
    kind: "product",
    unitLabel: "unit",
    onHandThousandths: 2_000,
    reservedThousandths: 0,
    availableThousandths: 2_000,
    totalValueMinor: 10_000,
    reorderPointThousandths: 1_000,
    reorderNeeded: false,
  },
];
const switchboard = { catalog: [{ id: "inventory" }], enabledModules: ["inventory"] };
const report = { items, totalValueMinor: 12_000, lots: [], locations: [], cycleCounts: [], transfers: [] };

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

  it("shows read-only lot details and balances only when the API provides them", async () => {
    const lots = [
      { id: "lot-1", sku: "MUG-1", lotCode: "MUG-MAR-26", expiresAt: "2026-03-12T00:00:00.000Z", balanceThousandths: 1_500 },
      { id: "lot-2", sku: "DESK-2", lotCode: "DESK-APR-26", expiresAt: null },
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
    expect(screen.getByText("No expiry date")).not.toBeNull();
    expect(screen.getByText("Not provided")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open full inventory workspace" }).getAttribute("href")).toContain("/inventory");
  });

  it("shows read-only stock locations with their codes and names", async () => {
    const locations = [
      { id: "location-1", code: "MAIN", name: "Main warehouse" },
      { id: "location-2", code: "SHOP", name: "Retail shop" },
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
    expect(screen.getByRole("link", { name: "Open full inventory workspace" }).getAttribute("href")).toContain("/inventory");
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
        id: "transfer-newest",
        number: 42,
        status: "partial",
        note: "Urgent restock",
        from: "MAIN",
        to: "SHOP",
        lines: [
          { lineId: "line-42-1", sku: "MUG-1", quantityThousandths: 2_500, confirmedThousandths: 1_000 },
          { lineId: "line-42-2", sku: "DESK-2", quantityThousandths: -500, confirmedThousandths: 0 },
        ],
      },
      {
        id: "transfer-older",
        number: 41,
        status: "cancelled",
        note: null,
        from: "SHOP",
        to: "MAIN",
        lines: [{ lineId: "line-41-1", sku: "MUG-1", quantityThousandths: 1_000, confirmedThousandths: 1_000 }],
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

  it("connects locations, reservations, and stock history to the inventory report", async () => {
    const reservations = [{
      id: "reservation-1",
      sku: "MUG-1",
      quantityThousandths: 500,
      reason: "Hold for customer pickup",
      status: "open",
      createdAt: "2026-05-12T10:30:00.000Z",
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      return Response.json({ ...report, locations: [{ id: "location-1", code: "MAIN", name: "Main warehouse" }], reservations });
    }));
    render(<InventoryPage />);

    expect(await screen.findByRole("heading", { name: "Locations and reservations" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Movement history" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Create location" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reserve stock" })).not.toBeNull();
    expect(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent?.includes("Hold for customer pickup") === true)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Release" })).not.toBeNull();
  });

  it("shows movement costs in organization currency when the display preference differs", async () => {
    localStorage.setItem("chaste-prefs", JSON.stringify({ currency: "UGX" }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (String(input).startsWith("/api/inventory?sku=")) {
        return Response.json({ movements: [{
          id: "movement-1",
          quantityDelta: 1_000,
          reason: "adjustment",
          note: null,
          refType: null,
          unitCostMinor: 1_000,
          lotCode: null,
          locationCode: null,
          actorType: "human",
          createdAt: "2026-09-30T10:15:00.000Z",
        }] });
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
    const fetchMock = vi.fn(async () => Response.json({ catalog: [{ id: "inventory" }], enabledModules: [] }));
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
      return Response.json({ items, totalValueMinor: 1_234_560, lots: [], locations: [], cycleCounts: [], transfers: [] });
    }));
    render(<InventoryPage baseCurrency="BHD" />);

    expect(await screen.findByText((value) => value.includes("1,234.560"))).not.toBeNull();
  });
});
