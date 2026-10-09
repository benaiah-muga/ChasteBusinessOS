import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  sessionStorage.clear();
  vi.restoreAllMocks();
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

  it("confirms a draft through the governed Go capability endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { confirmed: true, backordered: true, reservedThousandths: 0 } });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SalesPage />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Allow backorder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));

    expect(await screen.findByRole("status")).not.toBeNull();
    expect(screen.getByText("Order #43 confirmed.")).not.toBeNull();
    expect(within(screen.getByRole("row", { name: /#43/ })).getByRole("cell", { name: "Confirmed" })).not.toBeNull();
    const request = fetchMock.mock.calls.find(([input]) => input === "/api/capabilities/execute");
    expect(request?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      capabilityId: "sales.confirmOrder",
      input: { orderId: orders[2]!.id, allowBackorder: true },
      intentId: expect.any(String),
    });
  });

  it("ignores a confirmation response from the prior organization", async () => {
    const orgBOrder = {
      ...orders[2]!,
      id: "10000000-0000-4000-8000-000000000099",
      number: 99,
    };
    let activeOrganization = "org-1";
    let releaseOrgA: ((response: Response) => void) | undefined;
    let releaseOrgB: ((response: Response) => void) | undefined;
    const orgAResponse = new Promise<Response>((resolve) => { releaseOrgA = resolve; });
    const orgBResponse = new Promise<Response>((resolve) => { releaseOrgB = resolve; });
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders: activeOrganization === "org-1" ? orders : [orgBOrder] });
      if (input === "/api/capabilities/execute") {
        writes += 1;
        return writes === 1 ? orgAResponse : orgBResponse;
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const view = render(<SalesPage actorId="actor-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    await waitFor(() => expect(writes).toBe(1));

    activeOrganization = "org-2";
    view.rerender(<SalesPage actorId="actor-1" organizationId="org-2" />);
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
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
    render(<SalesPage actorId="actor-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
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
    const requests = fetchMock.mock.calls.filter(([input]) => input === "/api/capabilities/execute");
    expect(requests).toHaveLength(2);
    const firstBody = JSON.parse(String(requests[0]?.[1]?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> };
    const retryBody = JSON.parse(String(requests[1]?.[1]?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> };
    expect(firstBody).toMatchObject({ capabilityId: "sales.createOrder", input: { customerId: customers.customers[0]!.id, note: "Deliver Friday" } });
    expect(firstBody.intentId).toBe(retryBody.intentId);
    expect(retryBody.input).toEqual(firstBody.input);
  });

  it("restores and locks an unresolved create draft after remount", async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
      writes += 1;
      return writes === 1
        ? Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 })
        : Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    const props = { actorId: "actor-1", organizationId: "org-1" };
    const firstMount = render(<SalesPage {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Coffee beans" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    const firstRequest = fetchMock.mock.calls.find(([input]) => input === "/api/capabilities/execute");
    const firstBody = JSON.parse(String(firstRequest?.[1]?.body)) as { intentId: string; input: Record<string, unknown> };

    firstMount.unmount();
    render(<SalesPage {...props} />);
    expect((await screen.findByLabelText("Description") as HTMLInputElement).value).toBe("Coffee beans");
    expect((screen.getByLabelText("Customer") as HTMLSelectElement).value).toBe(customers.customers[0]!.id);
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));

    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();
    const requests = fetchMock.mock.calls.filter(([input]) => input === "/api/capabilities/execute");
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
      if (new TextDecoder().decode(data) === JSON.stringify({ actorId: "actor-1", organizationId: "org-2" })) {
        scopeDigestStarted = true;
        await scopeDigestGate;
      }
      return originalDigest(algorithm, data);
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
      void init;
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    const view = render(<SalesPage actorId="actor-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Org A draft" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "12.50" } });

    view.rerender(<SalesPage actorId="actor-1" organizationId="org-2" />);
    await waitFor(() => expect(scopeDigestStarted).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Create sales order" }));
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(fetchMock.mock.calls.some(([input]) => input === "/api/capabilities/execute")).toBe(false);

    releaseScopeDigest?.();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[1]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Org B draft" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();

    const request = fetchMock.mock.calls.find(([input]) => input === "/api/capabilities/execute");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      capabilityId: "sales.createOrder",
      input: { customerId: customers.customers[1]!.id, lines: [{ description: "Org B draft" }] },
    });
  });

  it("drops a stale order action target and reloads rows when organization scope changes", async () => {
    let activeOrganization = "org-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders: activeOrganization === "org-1" ? orders : [] });
      if (input === "/api/capabilities/execute") return Response.json({ ok: true, data: { status: "cancelled", releasedThousandths: 1000 } });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    const view = render(<SalesPage actorId="actor-1" organizationId="org-1" />);

    const row = await screen.findByRole("row", { name: /#41/ });
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");

    activeOrganization = "org-2";
    view.rerender(<SalesPage actorId="actor-1" organizationId="org-2" />);

    expect(await screen.findByText("No sales orders yet")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => input === "/api/capabilities/execute")).toBe(false);
  });

  it("ignores a prior-scope create response after restoring the active scope's pending draft", async () => {
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    let releaseOrgA: ((response: Response) => void) | undefined;
    const orgAResponse = new Promise<Response>((resolve) => { releaseOrgA = resolve; });
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
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
    await expect(submitSalesOrderWrite(orgBAction, { actorId: "actor-1", organizationId: "org-2" })).resolves.toMatchObject({ kind: "pending" });

    const view = render(<SalesPage actorId="actor-1" organizationId="org-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customers.customers[0]!.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Org A in-flight draft" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(writes).toBe(2));

    view.rerender(<SalesPage actorId="actor-1" organizationId="org-2" />);
    expect(await screen.findByDisplayValue("Org B pending draft")).not.toBeNull();
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(false);

    releaseOrgA?.(Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } }));
    await waitFor(() => expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Org B pending draft"));
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("An earlier sales order submission is unresolved. Retry the restored draft to check its result.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Sales order created as a draft.")).not.toBeNull();

    const writeBodies = fetchMock.mock.calls
      .filter(([input]) => input === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; input: Record<string, unknown> });
    expect(writeBodies).toHaveLength(3);
    expect(writeBodies[2]?.intentId).toBe(writeBodies[0]?.intentId);
    expect(writeBodies[2]?.input).toEqual(writeBodies[0]?.input);
  });

  it("keeps create recovery locked when the scoped retry marker is corrupt", async () => {
    const actorId = "actor-1";
    const organizationId = "org-1";
    const scopeDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ actorId, organizationId })));
    const digestHex = Array.from(new Uint8Array(scopeDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(`chaste:sales-order-write-attempt:${digestHex}`, "{");
    vi.stubGlobal("fetch", salesFetch());
    render(<SalesPage actorId={actorId} organizationId={organizationId} />);

    expect(await screen.findByText(/saved sales order retry marker is damaged/i)).not.toBeNull();
    expect((await screen.findByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem(`chaste:sales-order-write-attempt:${digestHex}`)).toBe("{");
  });

  it("unlocks a pending create after a terminal error and submits corrected input with a new intent", async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
      writes += 1;
      if (writes === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 });
      if (writes === 2) return Response.json({ error: "The order is invalid." }, { status: 422 });
      return Response.json({ ok: true, data: { orderId: "10000000-0000-4000-8000-000000000004", orderNumber: 44 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_SALES_ORDER_WRITES__", true);
    render(<SalesPage actorId="actor-1" organizationId="org-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Create sales order" }));
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

    const requests = fetchMock.mock.calls
      .filter(([input]) => input === "/api/capabilities/execute")
      .map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; input: Record<string, unknown> });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.intentId).toBe(requests[1]?.intentId);
    expect(requests[2]?.intentId).not.toBe(requests[1]?.intentId);
    expect(requests[2]?.input).toMatchObject({ lines: [{ description: "Tea leaves" }] });
  });

  it("keeps the delivery target open through pending approval and closes after completion", async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
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
    render(<SalesPage baseCurrency="USD" actorId="actor-1" organizationId="org-1" />);

    const orderRow = await screen.findByRole("row", { name: /#41/ });
    fireEvent.click(within(orderRow).getByRole("button", { name: "Deliver #41" }));
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");
    fireEvent.click(screen.getByRole("button", { name: "Deliver all and invoice" }));
    expect(await screen.findByText("Delivery approval required")).not.toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");

    fireEvent.click(screen.getByRole("button", { name: "Deliver all and invoice" }));
    expect(await screen.findByText("Order #41 fully delivered and invoiced.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const requests = fetchMock.mock.calls.filter(([input]) => input === "/api/capabilities/execute");
    const bodies = requests.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ capabilityId: "sales.deliverOrder", input: { orderId: orders[0]!.id } });
    expect(bodies[0]?.input).not.toHaveProperty("lines");
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
  });

  it("keeps the Go partial-delivery status when refreshing the order list fails", async () => {
    let salesReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") {
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
    render(<SalesPage baseCurrency="USD" actorId="actor-1" organizationId="org-1" />);

    const orderRow = await screen.findByRole("row", { name: /#41/ });
    fireEvent.click(within(orderRow).getByRole("button", { name: "Deliver #41" }));
    expect(screen.getByRole("dialog").textContent).toContain("invoice for those delivered lines");
    expect(screen.getByRole("dialog").textContent).not.toContain("$1,299.00");
    fireEvent.click(screen.getByRole("button", { name: "Deliver all and invoice" }));

    expect(await screen.findByText("Reserved quantities delivered and invoiced for order #41. The order remains confirmed.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(screen.getByRole("row", { name: /#41/ })).getByRole("cell", { name: "Confirmed" })).not.toBeNull();
    expect(salesReads).toBe(2);
  });

  it("keeps the cancellation target open through pending approval and closes after completion", async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
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
    render(<SalesPage actorId="actor-1" organizationId="org-1" />);

    const orderRow = await screen.findByRole("row", { name: /#41/ });
    fireEvent.click(within(orderRow).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(await screen.findByText("Cancellation approval required")).not.toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Order #41");

    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(await screen.findByText("Order #41 cancelled.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const requests = fetchMock.mock.calls.filter(([input]) => input === "/api/capabilities/execute");
    const bodies = requests.map(([, init]) => JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input: Record<string, unknown> });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ capabilityId: "sales.cancelOrder", input: { orderId: orders[0]!.id } });
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
  });

  it("keeps the approval intent across remounts and clears it after resolution", async () => {
    let capabilityAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
      capabilityAttempt += 1;
      return capabilityAttempt === 1
        ? Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 })
        : Response.json({ ok: true, data: { confirmed: true, backordered: true, reservedThousandths: 0 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const firstMount = render(<SalesPage />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Allow backorder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delivered" }));
    expect(screen.getByText("Manager approval required")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const capabilityCalls = () => fetchMock.mock.calls.filter(([input]) => input === "/api/capabilities/execute");
    const intentFrom = (call: ReturnType<typeof capabilityCalls>[number]) =>
      (JSON.parse(String(call[1]?.body)) as { intentId: string }).intentId;
    const backorderInputFrom = (call: ReturnType<typeof capabilityCalls>[number]) =>
      (JSON.parse(String(call[1]?.body)) as { input: { allowBackorder?: boolean } }).input.allowBackorder;
    const originalIntent = intentFrom(capabilityCalls()[0]!);
    expect(sessionStorage.getItem(`chaste:sales-confirm-intent:${orders[2]!.id}`)).toBe(originalIntent);
    expect(sessionStorage.getItem(`chaste:sales-confirm-backorder:${orders[2]!.id}`)).toBe("1");

    firstMount.unmount();
    render(<SalesPage />);
    const resumedBackorderChoice = await screen.findByRole("checkbox", { name: "Allow backorder" });
    expect((resumedBackorderChoice as HTMLInputElement).checked).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Check approval #43" }));

    expect(await screen.findByText("Order #43 confirmed.")).not.toBeNull();
    expect(within(screen.getByRole("row", { name: /#43/ })).getByText("Backordered")).not.toBeNull();
    expect(capabilityCalls()).toHaveLength(2);
    expect(intentFrom(capabilityCalls()[1]!)).toBe(originalIntent);
    expect(backorderInputFrom(capabilityCalls()[1]!)).toBe(true);
    expect(sessionStorage.getItem(`chaste:sales-confirm-intent:${orders[2]!.id}`)).toBeNull();
    expect(sessionStorage.getItem(`chaste:sales-confirm-pending:${orders[2]!.id}`)).toBeNull();
    expect(sessionStorage.getItem(`chaste:sales-confirm-backorder:${orders[2]!.id}`)).toBeNull();

    cleanup();
    render(<SalesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    expect(await screen.findByText("Order #43 confirmed.")).not.toBeNull();
    expect(capabilityCalls()).toHaveLength(3);
    expect(intentFrom(capabilityCalls()[2]!)).not.toBe(originalIntent);
    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(2);
  });

  it("keeps confirmation errors visible when the order is filtered out", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is blocked"); });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/modules") return Response.json(switchboard);
      if (input === "/api/customers") return Response.json(customers);
      if (input === "/api/sales") return Response.json({ orders });
      return Response.json({ error: "The sales service is unavailable. Check the order status before trying again." }, { status: 503 });
    }));
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SalesPage />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Allow backorder" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm #43" }));
    expect(await screen.findByRole("alert")).not.toBeNull();
    expect((screen.getByRole("checkbox", { name: "Allow backorder" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Delivered" }));

    expect(screen.getByRole("alert").textContent).toContain("Check the order status before trying again.");
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
