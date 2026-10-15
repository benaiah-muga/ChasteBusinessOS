import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SalesPage } from "./SalesPage";
import { submitSalesOrderWrite } from "../api/sales";

const orders = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    number: 41,
    customerId: "20000000-0000-4000-8000-000000000001",
    status: "confirmed",
    backordered: true,
    totalMinor: 129900,
    createdAt: "2026-09-27T10:15:00.000Z",
    lines: [
      { lineId: "30000000-0000-4000-8000-000000000001", description: "Desk", quantityThousandths: 3000, deliveredThousandths: 0, deliverableThousandths: 2000 },
      { lineId: "30000000-0000-4000-8000-000000000002", description: "Assembly service", quantityThousandths: 1000, deliveredThousandths: 0, deliverableThousandths: 1000 },
    ],
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
    note: "Initial order note",
    lines: [{ lineId: "30000000-0000-4000-8000-000000000003", description: "Draft product", quantityThousandths: 2000, deliveredThousandths: 0, deliverableThousandths: 2000, unitPriceMinor: 12500, taxMinor: 500, sku: "DRAFT-1" }],
  },
];
const switchboard = { catalog: [{ id: "sales" }], enabledModules: ["sales"] };
const customers = {
  customers: [
    { id: "20000000-0000-4000-8000-000000000001", name: "Acme Foods" },
    { id: "20000000-0000-4000-8000-000000000002", name: "Benaiah Market" },
  ],
};
const goDeals = {
  deals: [{
    id: "60000000-0000-4000-8000-000000000001",
    title: "Website renewal",
    stage: "proposal",
    valueMinor: 250000,
    source: "Referral",
    ownerUserId: "70000000-0000-4000-8000-000000000001",
    ownerName: "Morgan Lee",
    note: null,
    customerId: customers.customers[0]!.id,
    customerName: customers.customers[0]!.name,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
  }],
};
const confirmAttemptKey = (actorId: string, organizationId: string, orderId: string) =>
  `chaste:sales-confirm-attempt:${encodeURIComponent(JSON.stringify([actorId, organizationId]))}:${orderId}`;

function salesFetch() {
  return goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    if (input === "/api/modules") return Response.json(switchboard);
    if (input === "/api/sales/customers") return Response.json(customers);
    return Response.json({ orders });
  });
}

function goAwareFetch(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/capabilities/execute" && init?.method === "POST") {
      let capabilityId: string | undefined;
      try { capabilityId = (JSON.parse(String(init.body)) as { capabilityId?: string }).capabilityId; }
      catch { /* The application validates the request before the mock handles it. */ }
      if (capabilityId === "accounting.listQuotes") return Response.json({ ok: true, data: { quotes: [] } });
      if (capabilityId === "crm.listCustomers") return Response.json({ ok: true, data: { customers: [] } });
      if (capabilityId === "crm.listDeals") return Response.json({ ok: true, data: goDeals });
      if (capabilityId === "crm.listTasks") return Response.json({ ok: true, data: { tasks: [] } });
      if (capabilityId === "crm.listCustomerViews") return Response.json({ ok: true, data: { views: [] } });
      if (capabilityId === "sales.listOrders") {
        const fixture = await fetcher("test-fixture:sales-orders", { method: "GET", credentials: "same-origin" });
        if (!fixture.ok) return fixture;
        return Response.json({ ok: true, data: await fixture.json() }, { status: fixture.status });
      }
    }
    return fetcher(input, init);
  });
}

type SalesFetchMock = ReturnType<typeof goAwareFetch>;
function salesWriteCalls(fetchMock: SalesFetchMock) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    if (input !== "/api/capabilities/execute") return false;
    const { capabilityId } = JSON.parse(String(init?.body)) as { capabilityId?: string };
    return ["sales.confirmOrder", "sales.createOrder", "sales.updateDraftOrder", "sales.deliverOrder", "sales.cancelOrder"].includes(capabilityId ?? "");
  });
}

function stubWebLocks() {
  const tails = new Map<string, Promise<void>>();
  const testNavigator = Object.create(navigator) as Navigator;
  Object.defineProperty(testNavigator, "locks", {
    configurable: true,
    value: {
      request: async (name: string, _options: { mode: "exclusive" }, callback: () => Promise<unknown>) => {
        const previous = tails.get(name) ?? Promise.resolve();
        let release = () => {};
        const hold = new Promise<void>((resolve) => { release = resolve; });
        const next = previous.then(() => hold);
        tails.set(name, next);
        await previous;
        try { return await callback(); }
        finally {
          release();
          if (tails.get(name) === next) tails.delete(name);
        }
      },
    },
  });
  vi.stubGlobal("navigator", testNavigator);
}

beforeEach(() => {
  stubWebLocks();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Vite sales page", () => {
  it("edits a draft order through sales.updateDraftOrder and refreshes from Go", async () => {
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "/api/capabilities/execute") {
        const request = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (request.capabilityId === "sales.updateDraftOrder") return Response.json({ ok: true, data: { orderId: orders[2]!.id, before: { customerId: customers.customers[0]!.id, lines: [{ description: "Draft product", quantity: 2000, unitPriceMinor: 12500 }] } } });
      }
      return Response.json({ orders });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    const editButton = await screen.findByRole("button", { name: "Edit #43" });
    await waitFor(() => expect((editButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(editButton);
    expect((screen.getByLabelText("Order note") as HTMLInputElement).value).toBe("Initial order note");
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Draft product");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated product" } });
    fireEvent.change(screen.getByLabelText("Order note"), { target: { value: "Updated note" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save draft changes" }));

    const updateNotice = await screen.findByText("Sales draft updated.");
    expect(updateNotice).toBeTruthy();
    const update = salesWriteCalls(fetchMock).find(([, init]) => (JSON.parse(String(init?.body)) as { capabilityId: string }).capabilityId === "sales.updateDraftOrder");
    expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({
      capabilityId: "sales.updateDraftOrder",
      input: { orderId: orders[2]!.id, customerId: customers.customers[0]!.id, note: "Updated note", lines: [{ sku: "DRAFT-1", description: "Updated product", quantity: 2000, unitPriceMinor: 12500, taxMinor: 500 }] },
    });
  });

  it("uses Go for the initial order list and the post-create refresh", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "sales.listOrders") return Response.json({ ok: true, data: { orders } });
        if (body.capabilityId === "sales.createOrder") return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    expect(await screen.findByRole("cell", { name: "Draft" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Coffee beans" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));

    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();
    const orderReads = fetchMock.mock.calls.filter(([input, init]) => {
      if (input !== "/api/capabilities/execute") return false;
      return JSON.parse(String(init?.body)).capabilityId === "sales.listOrders";
    });
    expect(orderReads).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => input === "/api/sales")).toBe(false);
  });

  it("creates a catalog item through Go, retries an uncertain result exactly, and links it to the sales draft", async () => {
    const itemId = "50000000-0000-4000-8000-000000000005";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "sales.listOrders") return Response.json({ ok: true, data: { orders } });
        if (body.capabilityId === "inventory.createItem") {
          const attempts = fetchMock.mock.calls.filter(([url, request]) => {
            if (url !== "/api/capabilities/execute") return false;
            return JSON.parse(String(request?.body)).capabilityId === "inventory.createItem";
          }).length;
          if (attempts === 1) throw new TypeError("connection lost after request");
          return Response.json({ ok: true, data: { itemId } });
        }
        if (body.capabilityId === "sales.createOrder") return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);
    render(<SalesPage baseCurrency="USD" actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.click(screen.getAllByRole("button", { name: "Create catalog item" })[0]!);
    fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "NEW-COFFEE" } });
    fireEvent.change(screen.getByLabelText("Item name"), { target: { value: "New coffee" } });
    fireEvent.change(screen.getByLabelText("Sale price (USD)"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Create item and add line" }));
    expect(await screen.findByText("Could not reach the inventory service. Check your connection and try again.")).not.toBeNull();
    expect(localStorage.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Retry saved item" }));
    expect(await screen.findByText("Catalog item created through Go and added to the order line.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();

    const itemRequests = fetchMock.mock.calls.filter(([url, init]) => {
      if (url !== "/api/capabilities/execute") return false;
      return JSON.parse(String(init?.body)).capabilityId === "inventory.createItem";
    });
    expect(itemRequests).toHaveLength(2);
    const itemBodies = itemRequests.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> });
    expect(itemBodies[0]).toMatchObject({ capabilityId: "inventory.createItem", input: { sku: "NEW-COFFEE", name: "New coffee", salePriceMinor: 1250 } });
    expect(itemBodies[1]?.intentId).toBe(itemBodies[0]?.intentId);
    expect(itemBodies[1]?.input).toEqual(itemBodies[0]?.input);
    const orderRequest = fetchMock.mock.calls.find(([url, init]) => url === "/api/capabilities/execute" && JSON.parse(String(init?.body)).capabilityId === "sales.createOrder");
    expect(JSON.parse(String(orderRequest?.[1]?.body))).toMatchObject({ input: { lines: [{ sku: "NEW-COFFEE", description: "New coffee", unitPriceMinor: 1250 }] } });
    expect(itemRequests[0]?.[1]?.headers).toMatchObject({ "X-Organization-ID": "40000000-0000-4000-8000-000000000004" });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/inventory/items" || url === "/api/products")).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("disables catalog quick-create when Go inventory item writes are off but keeps Sales usable", async () => {
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "sales.createOrder") return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", false);
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    const quickCreateButton = screen.getByRole("button", { name: "Create catalog item" }) as HTMLButtonElement;
    expect(quickCreateButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Manual line" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/capabilities/execute" && JSON.parse(String(init?.body)).capabilityId === "inventory.createItem")).toBe(false);
  });

  it("shows sales order status, totals, backorder context, searchable rows, and status filters", async () => {
    const fetchMock = salesFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<SalesPage baseCurrency="USD" organizationId="40000000-0000-4000-8000-000000000004" />);

    expect(await screen.findByRole("heading", { name: "Sales orders" })).not.toBeNull();
    expect(screen.getByText("#41")).not.toBeNull();
    expect(screen.getByText("Backordered")).not.toBeNull();
    expect(screen.getAllByText("Acme Foods")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "Confirmed" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "Delivered" })).not.toBeNull();
    expect(screen.getByRole("cell", { name: "Draft" })).not.toBeNull();
    expect(screen.getByText("$1,299.00")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Sales workspace unavailable" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deals" }));
    expect(await screen.findByText("Website renewal")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Quotes" }));
    fireEvent.click(screen.getByText("2 line items"));
    expect(screen.getByText("Desk")).not.toBeNull();
    expect(screen.getByText("Ordered 3, delivered 0, reserved to deliver 2")).not.toBeNull();
    expect(screen.getByText("Assembly service")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      headers: expect.objectContaining({ "X-Organization-ID": "40000000-0000-4000-8000-000000000004" }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.objectContaining({
      headers: expect.objectContaining({ "X-Organization-ID": "40000000-0000-4000-8000-000000000004" }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sales/customers", expect.objectContaining({
      headers: expect.objectContaining({ "X-Organization-ID": "40000000-0000-4000-8000-000000000004" }),
    }));

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
    vi.stubGlobal("fetch", goAwareFetch(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      attempt += 1;
      return attempt === 1
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ orders: [] });
    }));
    render(<SalesPage organizationId="40000000-0000-4000-8000-000000000004" />);

    expect(await screen.findByRole("heading", { name: "Could not load sales orders" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No sales orders yet" })).not.toBeNull();
    expect(attempt).toBe(2);
  });

  it("confirms a draft through the governed Go capability endpoint", async () => {
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { confirmed: true, backordered: true, reservedThousandths: 0 } });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Allow backorder" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));

    expect(await screen.findByRole("status")).not.toBeNull();
    expect(screen.getByText("Order #43 confirmed.")).not.toBeNull();
    expect(within(screen.getByRole("row", { name: /#43/ })).getByRole("cell", { name: "Confirmed" })).not.toBeNull();
    const request = salesWriteCalls(fetchMock)[0];
    expect(request?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(request?.[1]?.headers).get("X-Organization-ID")).toBe("40000000-0000-4000-8000-000000000004");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      capabilityId: "sales.confirmOrder",
      input: { orderId: orders[2]!.id, allowBackorder: true },
      intentId: expect.any(String),
    });
  });

  it("blocks confirmation until the scoped retry-marker scan finishes", async () => {
    const actorId = "actor-1";
    const organizationId = "40000000-0000-4000-8000-000000000004";
    let releaseMarkerScan: (() => void) | undefined;
    let markerScanStarted = false;
    let blockScopeDigest = true;
    const markerScanGate = new Promise<void>((resolve) => { releaseMarkerScan = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (blockScopeDigest && new TextDecoder().decode(data) === JSON.stringify({ actorId, organizationId })) {
        blockScopeDigest = false;
        markerScanStarted = true;
        await markerScanGate;
      }
      return originalDigest(algorithm, data);
    });
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { confirmed: true, backordered: false, reservedThousandths: 0 } });
      return Response.json({ error: `unexpected route ${String(input)} ${String(init?.method)}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SalesPage actorId={actorId} organizationId={organizationId} />);

    const confirmButton = await screen.findByRole("button", { name: "Confirm #43" }) as HTMLButtonElement;
    await waitFor(() => expect(markerScanStarted).toBe(true));
    expect(confirmButton.disabled).toBe(true);
    fireEvent.click(confirmButton);
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);

    releaseMarkerScan?.();
    await waitFor(() => expect(confirmButton.disabled).toBe(false));
    fireEvent.click(confirmButton);
    expect(await screen.findByText("Order #43 confirmed.")).not.toBeNull();
    expect(salesWriteCalls(fetchMock)).toHaveLength(1);
  });

  it("ignores a confirmation response from the prior organization", async () => {
    const orgBOrder = {
      ...orders[2]!,
      id: "10000000-0000-4000-8000-000000000099",
      number: 99,
    };
    let activeOrganization = "40000000-0000-4000-8000-000000000004";
    let releaseOrgA: ((response: Response) => void) | undefined;
    let releaseOrgB: ((response: Response) => void) | undefined;
    const orgAResponse = new Promise<Response>((resolve) => { releaseOrgA = resolve; });
    const orgBResponse = new Promise<Response>((resolve) => { releaseOrgB = resolve; });
    let writes = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders: activeOrganization === "40000000-0000-4000-8000-000000000004" ? orders : [orgBOrder] });
      if (input === "/api/capabilities/execute") {
        writes += 1;
        return writes === 1 ? orgAResponse : orgBResponse;
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const view = render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    await waitFor(() => expect(writes).toBe(1));

    activeOrganization = "40000000-0000-4000-8000-000000000005";
    view.rerender(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000005" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm #99" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #99" }));
    await waitFor(() => expect(writes).toBe(2));
    expect(screen.getByRole("button", { name: "Checking…" })).not.toBeNull();

    await act(async () => {
      releaseOrgA?.(Response.json({ ok: true, data: { confirmed: true, backordered: false, reservedThousandths: 0 } }));
      await orgAResponse;
    });

    expect(screen.getByRole("button", { name: "Checking…" })).not.toBeNull();
    expect(screen.queryByText("Order #43 confirmed.")).toBeNull();
    expect(within(screen.getByRole("row", { name: /#99/ })).getByRole("cell", { name: "Draft" })).not.toBeNull();

    await act(async () => {
      releaseOrgB?.(Response.json({ ok: true, data: { confirmed: true, backordered: false, reservedThousandths: 0 } }));
      await orgBResponse;
    });
    expect(await screen.findByText("Order #99 confirmed.")).not.toBeNull();
    expect(within(screen.getByRole("row", { name: /#99/ })).getByRole("cell", { name: "Confirmed" })).not.toBeNull();
  });

  it("retains the create draft while approval is pending, then clears it on success", async () => {
    let writes = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") {
        writes += 1;
        return writes === 1
          ? Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required", approvalId: "30000000-0000-4000-8000-000000000001" }, { status: 202 })
          : Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
      }
      return Response.json({ error: `unexpected route ${String(input)} ${String(init?.method)}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Coffee beans" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "12.50" } });
    fireEvent.change(screen.getByLabelText("Tax"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Order note"), { target: { value: "Deliver Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));

    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    expect((screen.getByLabelText("Customer") as HTMLSelectElement).value).toBe(customers.customers[0]!.id);
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Coffee beans");
    expect((screen.getByLabelText("Quantity") as HTMLInputElement).value).toBe("2.5");
    expect((screen.getByLabelText("Unit price") as HTMLInputElement).value).toBe("12.50");

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Create sales order" })).toBeNull();
    const requests = salesWriteCalls(fetchMock);
    expect(requests).toHaveLength(2);
    const firstBody = JSON.parse(String(requests[0]?.[1]?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> };
    const retryBody = JSON.parse(String(requests[1]?.[1]?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> };
    expect(firstBody).toMatchObject({ capabilityId: "sales.createOrder", input: { customerId: customers.customers[0]!.id, note: "Deliver Friday" } });
    expect(firstBody.intentId).toBe(retryBody.intentId);
    expect(retryBody.input).toEqual(firstBody.input);
  });

  it("restores and locks an unresolved create draft after remount", async () => {
    let writes = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      writes += 1;
      return writes === 1
        ? Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 })
        : Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    const props = { actorId: "actor-1", organizationId: "40000000-0000-4000-8000-000000000004" };
    const firstMount = render(<SalesPage {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Coffee beans" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    const firstRequest = salesWriteCalls(fetchMock)[0];
    const firstBody = JSON.parse(String(firstRequest?.[1]?.body)) as { intentId: string; input: Record<string, unknown> };

    firstMount.unmount();
    render(<SalesPage {...props} />);
    expect((await screen.findByLabelText("Description") as HTMLInputElement).value).toBe("Coffee beans");
    expect((screen.getByLabelText("Customer") as HTMLSelectElement).value).toBe(customers.customers[0]!.id);
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));

    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();
    const requests = salesWriteCalls(fetchMock);
    const retryBody = JSON.parse(String(requests[1]?.[1]?.body)) as { intentId: string; input: Record<string, unknown> };
    expect(retryBody.intentId).toBe(firstBody.intentId);
    expect(retryBody.input).toEqual(firstBody.input);
  });

  it("locks and clears a create draft while the organization scope changes", async () => {
    let releaseScopeDigest: (() => void) | undefined;
    let scopeDigestStarted = false;
    const scopeDigestGate = new Promise<void>((resolve) => { releaseScopeDigest = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (new TextDecoder().decode(data) === JSON.stringify({ actorId: "actor-1", organizationId: "40000000-0000-4000-8000-000000000005" })) {
        scopeDigestStarted = true;
        await scopeDigestGate;
      }
      return originalDigest(algorithm, data);
    });
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
      void init;
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    const view = render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Org A draft" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "12.50" } });

    view.rerender(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000005" />);
    await waitFor(() => expect(scopeDigestStarted).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Create sales order" }));
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);

    releaseScopeDigest?.();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[1]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Org B draft" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();

    const request = salesWriteCalls(fetchMock)[0];
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      capabilityId: "sales.createOrder",
      input: { customerId: customers.customers[1]!.id, lines: [{ description: "Org B draft" }] },
    });
  });

  it("hides prior organization orders and customer options immediately while the new scope loads", async () => {
    const organizationA = "40000000-0000-4000-8000-000000000004";
    const organizationB = "40000000-0000-4000-8000-000000000005";
    let organizationBCustomerRequestStarted = false;
    const pendingOrganizationBCustomers = new Promise<Response>(() => {});
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") {
        const requestedOrganization = new Headers(init?.headers).get("X-Organization-ID");
        if (requestedOrganization === organizationB) {
          organizationBCustomerRequestStarted = true;
          return pendingOrganizationBCustomers;
        }
        return Response.json(customers);
      }
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<SalesPage actorId="actor-1" organizationId={organizationA} />);

    expect(await screen.findByRole("row", { name: /#41/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create sales order" }));
    expect(await screen.findByRole("option", { name: "Acme Foods" })).not.toBeNull();

    view.rerender(<SalesPage actorId="actor-1" organizationId={organizationB} />);

    expect(screen.queryByRole("row", { name: /#41/ })).toBeNull();
    expect(screen.queryByRole("option", { name: "Acme Foods" })).toBeNull();
    expect(screen.getByText("Loading sales orders…")).not.toBeNull();
    await waitFor(() => expect(organizationBCustomerRequestStarted).toBe(true));
  });

  it("hides prior actor orders and customer options immediately when the actor changes within one organization", async () => {
    const organizationId = "40000000-0000-4000-8000-000000000004";
    let customerReads = 0;
    let nextActorCustomerRequestStarted = false;
    const pendingNextActorCustomers = new Promise<Response>(() => {});
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") {
        customerReads += 1;
        if (customerReads === 2) {
          nextActorCustomerRequestStarted = true;
          return pendingNextActorCustomers;
        }
        return Response.json(customers);
      }
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<SalesPage actorId="actor-1" organizationId={organizationId} />);

    expect(await screen.findByRole("row", { name: /#41/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create sales order" }));
    expect(await screen.findByRole("option", { name: "Acme Foods" })).not.toBeNull();

    view.rerender(<SalesPage actorId="actor-2" organizationId={organizationId} />);

    expect(screen.queryByRole("row", { name: /#41/ })).toBeNull();
    expect(screen.queryByRole("option", { name: "Acme Foods" })).toBeNull();
    expect(screen.getByText("Loading sales orders…")).not.toBeNull();
    await waitFor(() => expect(nextActorCustomerRequestStarted).toBe(true));
  });

  it("drops a stale order action target and reloads rows when organization scope changes", async () => {
    let activeOrganization = "40000000-0000-4000-8000-000000000004";
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders: activeOrganization === "40000000-0000-4000-8000-000000000004" ? orders : [] });
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { status: "cancelled", releasedThousandths: 1000 } });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    const view = render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    const row = await screen.findByRole("row", { name: /#41/ });
    const cancel = within(row).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    await waitFor(() => expect(cancel.disabled).toBe(false));
    fireEvent.click(cancel);
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");

    activeOrganization = "40000000-0000-4000-8000-000000000005";
    view.rerender(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000005" />);

    expect(await screen.findByText("No sales orders yet")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);
  });

  it("ignores a prior-scope create response after restoring the active scope's pending draft", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    let releaseOrgA: ((response: Response) => void) | undefined;
    const orgAResponse = new Promise<Response>((resolve) => { releaseOrgA = resolve; });
    let writes = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") {
        writes += 1;
        if (writes === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Org B approval required" }, { status: 202 });
        if (writes === 2) return orgAResponse;
        return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000005", orderNumber: 45 } });
      }
      void init;
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const orgBAction = {
      action: "create" as const,
      customerId: customers.customers[1]!.id,
      note: "Org B note",
      lines: [{ description: "Org B pending draft", quantity: 1000, unitPriceMinor: 2000, taxMinor: 0 }],
    };
    await expect(submitSalesOrderWrite(orgBAction, { actorId: "actor-1", organizationId: "40000000-0000-4000-8000-000000000005" })).resolves.toMatchObject({ kind: "pending" });

    const view = render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Org A in-flight draft" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(writes).toBe(2));

    view.rerender(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000005" />);
    expect(await screen.findByDisplayValue("Org B pending draft")).not.toBeNull();
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false);

    releaseOrgA?.(Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } }));
    await waitFor(() => expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Org B pending draft"));
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("An earlier sales order submission is unresolved. Retry the restored draft to check its result.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();

    const writeBodies = salesWriteCalls(fetchMock)
      .map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; input: Record<string, unknown> });
    expect(writeBodies).toHaveLength(3);
    expect(writeBodies[2]?.intentId).toBe(writeBodies[0]?.intentId);
    expect(writeBodies[2]?.input).toEqual(writeBodies[0]?.input);
  });

  it("keeps create recovery locked when the scoped retry marker is corrupt", async () => {
    const actorId = "actor-1";
    const organizationId = "40000000-0000-4000-8000-000000000004";
    const scopeDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    const digestHex = Array.from(new Uint8Array(scopeDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(`chaste:sales-order-write-attempt:${digestHex}`, "{");
    const fetchMock = salesFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<SalesPage actorId={actorId} organizationId={organizationId} />);

    expect(await screen.findByText(/saved sales order retry marker is damaged/i)).not.toBeNull();
    expect((await screen.findByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Deliver #41" }) as HTMLButtonElement).disabled).toBe(true);
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);
    expect(localStorage.getItem(`chaste:sales-order-write-attempt:${digestHex}`)).toBe("{");
  });

  it("requires history review before clearing a route-less action and sends no write", async () => {
    const actorId = "actor-1";
    const organizationId = "40000000-0000-4000-8000-000000000004";
    const action = { action: "deliver" as const, orderId: orders[0]!.id };
    const digest = async (value: string) => {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const scope = { actorId, organizationId };
    const scopeDigest = await digest(JSON.stringify(scope));
    const fingerprint = await digest(JSON.stringify({ ...scope, action }));
    const markerKey = `chaste:sales-order-write-attempt:${scopeDigest}`;
    localStorage.setItem(markerKey, JSON.stringify({ fingerprint, intentId: crypto.randomUUID(), action }));
    const fetchMock = salesFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubWebLocks();

    render(<SalesPage actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("heading", { name: "Resolve an older retry marker" })).not.toBeNull();
    const clearButton = screen.getByRole("button", { name: "Clear reviewed retry marker" }) as HTMLButtonElement;
    expect(clearButton.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Deliver #41" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(true);
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);

    fireEvent.click(screen.getByLabelText("I reviewed the Sales order history and understand this only clears the ambiguous retry marker."));
    expect(clearButton.disabled).toBe(false);
    fireEvent.click(clearButton);

    expect(await screen.findByText("The reviewed ambiguous retry marker was cleared. No Sales action was sent.")).not.toBeNull();
    expect(localStorage.getItem(markerKey)).toBeNull();
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);
  });

  it("unlocks a pending create after a terminal error and submits corrected input with a new intent", async () => {
    let writes = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      writes += 1;
      if (writes === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 });
      if (writes === 2) return Response.json({ error: "The order is invalid." }, { status: 422 });
      return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Coffee beans" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Manager approval required")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("The order is invalid.")).not.toBeNull();
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Tea leaves" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();

    const requests = salesWriteCalls(fetchMock)
      .map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; input: Record<string, unknown> });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.intentId).toBe(requests[1]?.intentId);
    expect(requests[2]?.intentId).not.toBe(requests[1]?.intentId);
    expect(requests[2]?.input).toMatchObject({ lines: [{ description: "Tea leaves" }] });
  });

  it("keeps the delivery target open through pending approval and closes after completion", async () => {
    let writes = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") {
        writes += 1;
        return writes === 1
          ? Response.json({ ok: false, pendingApproval: true, reason: "Delivery approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { invoiceId: "40000000-0000-4000-8000-000000000001", invoiceNumber: 900, invoiceTotalMinor: 129900, orderStatus: "delivered" } });
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    render(<SalesPage baseCurrency="USD" actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    const orderRow = await screen.findByRole("row", { name: /#41/ });
    const deliverButton = within(orderRow).getByRole("button", { name: "Deliver #41" }) as HTMLButtonElement;
    await waitFor(() => expect(deliverButton.disabled).toBe(false));
    fireEvent.click(deliverButton);
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");
    fireEvent.click(screen.getByRole("button", { name: "Deliver all and invoice" }));
    expect(await screen.findByText("Delivery approval required")).not.toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");

    fireEvent.click(screen.getByRole("button", { name: "Deliver all and invoice" }));
    expect(await screen.findByText("Order #41 fully delivered and invoiced.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const requests = salesWriteCalls(fetchMock);
    const bodies = requests.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ capabilityId: "sales.deliverOrder", input: { orderId: orders[0]!.id } });
    expect(bodies[0]?.input).not.toHaveProperty("lines");
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
  });

  it("restores an uncertain partial delivery after reload and retries its exact Go intent", async () => {
    const action = {
      action: "deliver" as const,
      orderId: orders[0]!.id,
      lines: [{ lineId: "30000000-0000-4000-8000-000000000001", quantityThousandths: 1250 }],
    };
    let deliveryWrites = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as { capabilityId: string };
        if (body.capabilityId === "sales.deliverOrder") {
          deliveryWrites += 1;
          return deliveryWrites === 1
            ? Response.json({ error: "connection lost" }, { status: 503 })
            : Response.json({ ok: true, data: { invoiceId: "40000000-0000-4000-8000-000000000008", invoiceNumber: 908, invoiceTotalMinor: 25000, orderStatus: "confirmed" } });
        }
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    vi.stubGlobal("__GO_SALES_ORDER_READS__", true);
    await expect(submitSalesOrderWrite(action, { actorId: "actor-1", organizationId: "40000000-0000-4000-8000-000000000004" })).rejects.toMatchObject({ status: 503 });

    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);
    expect(await screen.findByRole("heading", { name: "Retry the unresolved delivery" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Retry saved delivery" }) as HTMLButtonElement).disabled).toBe(false);
    const row = await screen.findByRole("row", { name: /#41/ });
    expect((within(row).getByRole("button", { name: "Deliver #41" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create sales order" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry saved delivery" }));
    expect(await screen.findByText("Reserved quantities delivered and invoiced for order #41. The order remains confirmed.")).not.toBeNull();
    const bodies = salesWriteCalls(fetchMock).map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; input: Record<string, unknown> });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
    expect(bodies[1]?.input).toEqual(bodies[0]?.input);
    expect(fetchMock.mock.calls.every(([input]) => input !== "/api/sales")).toBe(true);
  });

  it("delivers selected reserved quantities through Go and leaves the order open", async () => {
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") return Response.json({
        ok: true,
        data: { invoiceId: "40000000-0000-4000-8000-000000000009", invoiceNumber: 909, invoiceTotalMinor: 25000, orderStatus: "confirmed" },
      });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    const orderRow = await screen.findByRole("row", { name: /#41/ });
    const partialDelivery = within(orderRow).getByRole("button", { name: "Partial delivery" });
    await waitFor(() => expect((partialDelivery as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(partialDelivery);
    const amount = screen.getByRole("spinbutton", { name: "Quantity to deliver for Desk" }) as HTMLInputElement;
    const submit = screen.getByRole("button", { name: "Deliver selected quantities and invoice" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(amount, { target: { value: "2.5" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(amount, { target: { value: "1.25" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(await screen.findByText("Reserved quantities delivered and invoiced for order #41. The order remains confirmed.")).not.toBeNull();
    const write = salesWriteCalls(fetchMock).find(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string };
      return body.capabilityId === "sales.deliverOrder";
    });
    expect(write).toBeDefined();
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      capabilityId: "sales.deliverOrder",
      input: { orderId: orders[0]!.id, lines: [{ lineId: "30000000-0000-4000-8000-000000000001", quantityThousandths: 1250 }] },
    });
  });

  it("keeps the Go partial-delivery status when refreshing the order list fails", async () => {
    let salesReads = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") {
        salesReads += 1;
        return salesReads === 1
          ? Response.json({ orders })
          : Response.json({ error: "order list temporarily unavailable" }, { status: 503 });
      }
      if (input === "/api/capabilities/execute") return Response.json({
        ok: true,
        data: { invoiceId: "40000000-0000-4000-8000-000000000002", invoiceNumber: 901, invoiceTotalMinor: 65000, orderStatus: "confirmed" },
      });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    render(<SalesPage baseCurrency="USD" actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    const orderRow = await screen.findByRole("row", { name: /#41/ });
    const deliverButton = within(orderRow).getByRole("button", { name: "Deliver #41" });
    await waitFor(() => expect((deliverButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(deliverButton);
    const deliveryDialog = await screen.findByRole("dialog");
    expect(deliveryDialog.textContent).toContain("invoice for those delivered lines");
    expect(deliveryDialog.textContent).not.toContain("$1,299.00");
    fireEvent.click(screen.getByRole("button", { name: "Deliver all and invoice" }));

    expect(await screen.findByText("Reserved quantities delivered and invoiced for order #41. The order remains confirmed.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(screen.getByRole("row", { name: /#41/ })).getByRole("cell", { name: "Confirmed" })).not.toBeNull();
    expect(salesReads).toBe(2);
  });

  it("keeps the cancellation target open through pending approval and closes after completion", async () => {
    let writes = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      if (input === "/api/capabilities/execute") {
        writes += 1;
        return writes === 1
          ? Response.json({ ok: false, pendingApproval: true, reason: "Cancellation approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { status: "cancelled", releasedThousandths: 1000 } });
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    const orderRow = await screen.findByRole("row", { name: /#41/ });
    const cancelButton = within(orderRow).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    await waitFor(() => expect(cancelButton.disabled).toBe(false));
    fireEvent.click(cancelButton);
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(await screen.findByText("Cancellation approval required")).not.toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");

    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(await screen.findByText("Order #41 cancelled.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const requests = salesWriteCalls(fetchMock);
    const bodies = requests.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ capabilityId: "sales.cancelOrder", input: { orderId: orders[0]!.id } });
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
  });

  it("keeps the approval intent across remounts and clears it after resolution", async () => {
    let capabilityAttempt = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      capabilityAttempt += 1;
      return capabilityAttempt === 1
        ? Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 })
        : Response.json({ ok: true, data: { confirmed: true, backordered: true, reservedThousandths: 0 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const scopeProps = { actorId: "actor-1", organizationId: "40000000-0000-4000-8000-000000000004" };
    const firstMount = render(<SalesPage {...scopeProps} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Allow backorder" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delivered" }));
    expect(screen.getByText("Manager approval required")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const capabilityCalls = () => salesWriteCalls(fetchMock);
    const intentFrom = (call: ReturnType<typeof capabilityCalls>[number]) =>
      (JSON.parse(String(call[1]?.body)) as { intentId: string }).intentId;
    const backorderInputFrom = (call: ReturnType<typeof capabilityCalls>[number]) =>
      (JSON.parse(String(call[1]?.body)) as { input: { allowBackorder?: boolean } }).input.allowBackorder;
    const originalIntent = intentFrom(capabilityCalls()[0]!);
    const markerKey = confirmAttemptKey("actor-1", "40000000-0000-4000-8000-000000000004", orders[2]!.id);
    expect(JSON.parse(localStorage.getItem(markerKey) ?? "null")).toMatchObject({
      orderId: orders[2]!.id,
      intentId: originalIntent,
      allowBackorder: true,
      pending: true,
    });

    firstMount.unmount();
    render(<SalesPage {...scopeProps} />);
    const resumedBackorderChoice = await screen.findByRole("checkbox", { name: "Allow backorder" });
    expect((resumedBackorderChoice as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((screen.getByRole("button", { name: "Check approval #43" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Check approval #43" }));

    expect(await screen.findByText("Order #43 confirmed.")).not.toBeNull();
    expect(within(screen.getByRole("row", { name: /#43/ })).getByText("Backordered")).not.toBeNull();
    expect(capabilityCalls()).toHaveLength(2);
    expect(intentFrom(capabilityCalls()[1]!)).toBe(originalIntent);
    expect(backorderInputFrom(capabilityCalls()[1]!)).toBe(true);
    expect(localStorage.getItem(markerKey)).toBeNull();

    cleanup();
    render(<SalesPage {...scopeProps} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    expect(await screen.findByText("Order #43 confirmed.")).not.toBeNull();
    expect(capabilityCalls()).toHaveLength(3);
    expect(intentFrom(capabilityCalls()[2]!)).not.toBe(originalIntent);
    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(2);
  });

  it("serializes confirmation retries across tabs and reuses the durable attempt", async () => {
    let capabilityAttempt = 0;
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      void init;
      capabilityAttempt += 1;
      if (capabilityAttempt === 1) throw new TypeError("connection reset after request");
      return Response.json({ ok: true, data: { confirmed: true, backordered: true, reservedThousandths: 0 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const props = { actorId: "actor-1", organizationId: "40000000-0000-4000-8000-000000000004" };
    render(<><SalesPage {...props} /><SalesPage {...props} /></>);

    const confirmButtons = await screen.findAllByRole("button", { name: "Confirm #43" });
    await waitFor(() => expect(confirmButtons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true));
    fireEvent.click(confirmButtons[0]!);
    fireEvent.click(confirmButtons[1]!);

    await waitFor(() => expect(salesWriteCalls(fetchMock)).toHaveLength(2));
    const capabilityCalls = salesWriteCalls(fetchMock);
    const intentFrom = (call: typeof capabilityCalls[number]) =>
      (JSON.parse(String(call[1]?.body)) as { intentId: string }).intentId;
    expect(intentFrom(capabilityCalls[1]!)).toBe(intentFrom(capabilityCalls[0]!));
    expect(await screen.findByText("Order #43 confirmed.")).not.toBeNull();
    expect(localStorage.getItem(confirmAttemptKey("actor-1", "40000000-0000-4000-8000-000000000004", orders[2]!.id))).toBeNull();
  });

  it("fails closed when durable storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is blocked"); });
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      return Response.json({ error: "The sales service is unavailable. Check the order status before trying again." }, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Allow backorder" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Enable browser storage");
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);
  });

  it("fails closed when Web Locks are unavailable", async () => {
    const testNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(testNavigator, "locks", { configurable: true, value: undefined });
    vi.stubGlobal("navigator", testNavigator);
    const fetchMock = goAwareFetch(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/sales/customers") return Response.json(customers);
      if (input === "test-fixture:sales-orders") return Response.json({ orders });
      return Response.json({ ok: true, data: { confirmed: true, backordered: false, reservedThousandths: 0 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SalesPage actorId="actor-1" organizationId="40000000-0000-4000-8000-000000000004" />);

    expect((await screen.findByRole("alert")).textContent).toContain("Web Locks support");
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm #43" }) as HTMLButtonElement).disabled).toBe(true));
    expect(salesWriteCalls(fetchMock).length > 0).toBe(false);
    expect(localStorage.getItem(confirmAttemptKey("actor-1", "40000000-0000-4000-8000-000000000004", orders[2]!.id))).toBeNull();
  });

  it("shows route-level Go permission failures as access denied", async () => {
    vi.stubGlobal("fetch", goAwareFetch(async (input: RequestInfo | URL) => input === "/api/modules"
      ? Response.json(switchboard)
      : input === "/api/sales/customers" ? Response.json(customers)
      : Response.json({ error: "forbidden: missing sales.read" }, { status: 422 })));
    render(<SalesPage organizationId="40000000-0000-4000-8000-000000000004" />);

    expect(await screen.findByRole("heading", { name: "Access denied" })).not.toBeNull();
  });

  it("formats totals using three- and zero-decimal currency minor units", async () => {
    vi.stubGlobal("fetch", salesFetch());
    localStorage.setItem("chaste-prefs", JSON.stringify({ currency: "UGX" }));
    const { rerender } = render(<SalesPage baseCurrency="USD" organizationId="40000000-0000-4000-8000-000000000004" />);
    expect(await screen.findByText((value) => value.includes("129,900"))).not.toBeNull();

    localStorage.clear();
    rerender(<SalesPage baseCurrency="BHD" organizationId="40000000-0000-4000-8000-000000000004" />);
    expect(await screen.findByText((value) => value.includes("129.900"))).not.toBeNull();
  });

  it("does not fetch orders while the Sales module is disabled", async () => {
    const fetchMock = goAwareFetch(async () => Response.json({ catalog: [{ id: "sales" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SalesPage organizationId="40000000-0000-4000-8000-000000000004" />);

    expect(await screen.findByRole("heading", { name: "Sales is turned off" })).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => input === "/api/capabilities/execute"
      && (JSON.parse(String(init?.body)) as { capabilityId?: string }).capabilityId === "sales.listOrders")).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.any(Object));
  });
});
