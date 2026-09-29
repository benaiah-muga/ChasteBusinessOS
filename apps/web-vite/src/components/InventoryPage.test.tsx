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
const report = { items, totalValueMinor: 12_000, lots: [] };

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
      return attempt === 1 ? Response.json({ items: [{ sku: "MUG-1" }], totalValueMinor: 1 }) : Response.json(report);
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
      return Response.json({ items, totalValueMinor: 1_234_560, lots: [] });
    }));
    render(<InventoryPage baseCurrency="BHD" />);

    expect(await screen.findByText((value) => value.includes("1,234.560"))).not.toBeNull();
  });
});
