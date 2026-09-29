import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SalesPage } from "./SalesPage";

const orders = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    number: 41,
    customerId: "20000000-0000-4000-8000-000000000001",
    status: "confirmed",
    backordered: true,
    totalMinor: 129900,
    createdAt: "2026-09-27T10:15:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    number: 42,
    customerId: "20000000-0000-4000-8000-000000000002",
    status: "delivered",
    backordered: false,
    totalMinor: 75500,
    createdAt: "2026-09-28T11:30:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    number: 43,
    customerId: "20000000-0000-4000-8000-000000000001",
    status: "draft",
    backordered: false,
    totalMinor: 25000,
    createdAt: "2026-09-28T12:00:00.000Z",
  },
];
const switchboard = { catalog: [{ id: "sales" }], enabledModules: ["sales"] };
const customers = {
  customers: [
    { id: "20000000-0000-4000-8000-000000000001", name: "Acme Foods" },
    { id: "20000000-0000-4000-8000-000000000002", name: "Benaiah Market" },
  ],
};

function salesFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (input === "/api/modules") return Response.json(switchboard);
    if (input === "/api/customers") return Response.json(customers);
    return Response.json({ orders });
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Vite sales page", () => {
  it("shows sales order status, totals, backorder context, searchable rows, and status filters", async () => {
    const fetchMock = salesFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<SalesPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Sales orders" })).not.toBeNull();
    expect(screen.getByText("#41")).not.toBeNull();
    expect(screen.getByText("Backordered")).not.toBeNull();
    expect(screen.getAllByText("Acme Foods")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "Confirmed" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "Delivered" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "Draft" })).not.toBeNull();
    expect(screen.getByText("$1,299.00")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("/api/sales", expect.any(Object));

    fireEvent.click(screen.getByRole("button", { name: "Confirmed" }));
    expect(screen.getByRole("button", { name: "Confirmed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("#42")).toBeNull();
    expect(screen.queryByText("#43")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Find an order" }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Find an order" }), { target: { value: "Benaiah Market" } });
    expect(screen.getByText("#42")).not.toBeNull();
    expect(screen.queryByText("#41")).toBeNull();
  });

  it("renders an accessible empty state and retries failed reads", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      attempt += 1;
      return attempt === 1
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ orders: [] });
    }));
    render(<SalesPage />);

    expect(await screen.findByRole("heading", { name: "Could not load sales orders" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No sales orders yet" })).not.toBeNull();
    expect(attempt).toBe(2);
  });

  it("shows route-level Go permission failures as access denied", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => input === "/api/modules"
      ? Response.json(switchboard)
      : input === "/api/customers" ? Response.json(customers)
      : Response.json({ error: "forbidden: missing sales.read" }, { status: 422 })));
    render(<SalesPage />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
  });

  it("formats totals using three- and zero-decimal currency minor units", async () => {
    vi.stubGlobal("fetch", salesFetch());
    localStorage.setItem("chaste-prefs", JSON.stringify({ currency: "UGX" }));
    const { rerender } = render(<SalesPage baseCurrency="USD" />);
    expect(await screen.findByText((value) => value.includes("129,900"))).not.toBeNull();

    localStorage.clear();
    rerender(<SalesPage baseCurrency="BHD" />);
    expect(await screen.findByText((value) => value.includes("129.900"))).not.toBeNull();
  });

  it("does not fetch orders while the Sales module is disabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalog: [{ id: "sales" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SalesPage />);

    expect(await screen.findByRole("heading", { name: "Sales is turned off" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
  });
});
