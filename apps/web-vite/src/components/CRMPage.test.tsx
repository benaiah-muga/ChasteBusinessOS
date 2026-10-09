import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRMPage } from "./CRMPage";
import { submitCrmTaskMutation } from "../api/crm";

const dealId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const customerId = "2beae091-6921-4e49-97b1-5049196e0ac5";

const isDealsRead = (path: string): boolean => path === "/api/deals" || path === "/api/crm?deals=1";
const isCustomersRead = (path: string): boolean => path === "/api/customers" || path === "/api/crm?customers=1";
const isCustomerViewsRead = (path: string): boolean => path === "/api/crm/views" || path === "/api/crm?views=1";

function customer(name = "Northwind") {
  return { id: customerId, name, email: "contact@northwind.test", phone: null, preferredContactMethod: "email", doNotContact: false, ownerUserId: null, ownerName: null, tags: ["renewal"], notes: "Priority account", nextStep: null, lastActivityAt: "2026-09-28T12:00:00.000Z", deactivatedAt: null };
}
function deal(stage: string) {
  return { id: dealId, title: "Annual renewal", stage, valueMinor: 480000, note: null, customerId, customerName: "Northwind", updatedAt: "2026-09-29T12:00:00.000Z" };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Vite CRM page", () => {
  it("shows the duplicate warning returned after customer creation", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", false);
    const createdId = "d79382ac-743f-4d27-8b5f-92f2cba74d8e";
    const duplicateWarning = 'Looks like existing customer "Northwind" (matched by email). Merge or deactivate one of them.';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method === "POST") return Response.json({ ok: true, data: { customerId: createdId, duplicateWarning } });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Northwind Ltd" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "office@northwind.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

    expect(await screen.findByText(`Customer added. ${duplicateWarning}`)).not.toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(JSON.parse(String(fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/customers" && init?.method === "POST")?.[1]?.body))).toMatchObject({ action: "create", name: "Northwind Ltd", email: "office@northwind.test" });
  });

  it("blocks legacy customer creation until the actor and organization scope resolve", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", false);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={null} organizationId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    expect(await screen.findByText("CRM is waiting for account and organization details or restoring a saved customer draft.")).not.toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add customer" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add customer" }));
    expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/customers" && init?.method === "POST")).toBe(false);
  });

  it("locks an exact Go customer draft after 404 and retries without a legacy write", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", true);
    const goBodies: Array<{ capabilityId: string; input: { name: string }; intentId: string }> = [];
    let legacyWrites = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method === "POST") {
        legacyWrites += 1;
        return Response.json({ ok: true, data: { customerId, duplicateWarning: null } });
      }
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute") {
        const body = JSON.parse(String(init?.body)) as (typeof goBodies)[number];
        goBodies.push(body);
        return goBodies.length === 1
          ? Response.json({ error: "Route not found" }, { status: 404 })
          : Response.json({ ok: true, data: { customerId, duplicateWarning: null } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Add customer" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Northwind Ltd" } });
    fireEvent.click(screen.getByRole("button", { name: "Add customer" }));

    expect(await screen.findByText("This customer creation is pending or uncertain. Retry the same details to resolve it.")).not.toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Northwind Ltd");
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect(legacyWrites).toBe(0);

    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", false);
    view.rerender(<CRMPage actorId={customerId} organizationId={dealId} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry customer" })).toHaveProperty("disabled", false);
      expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry customer" }));
    expect(await screen.findByText(/A Go customer creation is unresolved/)).not.toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Northwind Ltd");
    expect(legacyWrites).toBe(0);
    expect(goBodies).toHaveLength(1);

    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", true);
    view.rerender(<CRMPage actorId={customerId} organizationId={dealId} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry customer" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Retry customer" }));
    expect(await screen.findByText("Customer added.")).not.toBeNull();
    expect(goBodies).toHaveLength(2);
    expect(goBodies[1]).toEqual(goBodies[0]);
    expect(legacyWrites).toBe(0);
  });

  it("ignores a customer-create response after the active account scope changes", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", true);
    let finishCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => { finishCreate = resolve; });
    const otherOrganizationId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method === "POST") return createResponse;
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute") return createResponse;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Add customer" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Old organization customer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add customer" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything()));

    view.rerender(<CRMPage actorId={customerId} organizationId={otherOrganizationId} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Add customer" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");

    await act(async () => {
      finishCreate(Response.json({ ok: true, data: { customerId: "d79382ac-743f-4d27-8b5f-92f2cba74d8e", duplicateWarning: null } }));
    });

    expect(screen.queryByText("Customer added.")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Add customer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps an unrelated CRM mutation busy when customer scope changes", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_CREATE__", true);
    vi.stubGlobal("__GO_CRM_DEAL_CREATE__", false);
    let finishDeal!: (response: Response) => void;
    const dealResponse = new Promise<Response>((resolve) => { finishDeal = resolve; });
    const otherOrganizationId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals" && init?.method === "POST") return dealResponse;
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    fireEvent.change(screen.getByLabelText("Deal name"), { target: { value: "Long-running deal" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "125" } });
    fireEvent.click(screen.getByRole("button", { name: "Add deal" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/deals", expect.objectContaining({ method: "POST" })));

    view.rerender(<CRMPage actorId={customerId} organizationId={otherOrganizationId} />);
    expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      finishDeal(Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 }));
    });

    expect(screen.queryByText("Manager approval required")).toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("keeps a Go deal draft locked and retries the same payload and intent after approval is pending", async () => {
    vi.stubGlobal("__GO_CRM_DEAL_CREATE__", true);
    let createCalls = 0;
    let legacyCreateCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals" && _init?.method === "POST") {
        legacyCreateCalls += 1;
        return Response.json({ ok: true, data: { dealId } });
      }
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute") {
        createCalls += 1;
        return createCalls === 1
          ? Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { dealId } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Deal name"), { target: { value: " Renewal " } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "255.00" } });
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customerId } });
    fireEvent.click(screen.getByRole("button", { name: "Add deal" }));

    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    expect((screen.getByLabelText("Deal name") as HTMLInputElement).value).toBe(" Renewal ");
    expect((screen.getByLabelText("Deal name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Retry deal" }) as HTMLButtonElement).disabled).toBe(false);

    vi.stubGlobal("__GO_CRM_DEAL_CREATE__", false);
    view.rerender(<CRMPage actorId={customerId} organizationId={dealId} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry deal" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry deal" }));
    expect(await screen.findByText(/A Go deal creation is unresolved/)).not.toBeNull();
    expect((screen.getByLabelText("Deal name") as HTMLInputElement).value).toBe("Renewal");
    expect((screen.getByLabelText("Deal name") as HTMLInputElement).disabled).toBe(true);
    expect(legacyCreateCalls).toBe(0);

    vi.stubGlobal("__GO_CRM_DEAL_CREATE__", true);
    view.rerender(<CRMPage actorId={customerId} organizationId={dealId} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry deal" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry deal" }));

    await waitFor(() => expect((screen.getByLabelText("Deal name") as HTMLInputElement).value).toBe(""));
    const submissions = fetchMock.mock.calls.filter(([path]) => String(path) === "/api/capabilities/execute");
    expect(submissions).toHaveLength(2);
    expect(JSON.parse(String(submissions[0]?.[1]?.body))).toMatchObject({ capabilityId: "crm.createDeal", input: { title: "Renewal", valueMinor: 25_500, customerId }, intentId: expect.any(String) });
    expect(JSON.parse(String(submissions[1]?.[1]?.body))).toEqual(JSON.parse(String(submissions[0]?.[1]?.body)));
    expect(legacyCreateCalls).toBe(0);
  });

  it("keeps a Go deal draft locked after 404 and preserves Retry deal for the exact action", async () => {
    vi.stubGlobal("__GO_CRM_DEAL_CREATE__", true);
    let createCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals" && init?.method === "POST") throw new Error("deal create must not fall back to the legacy route");
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute") {
        createCalls += 1;
        return createCalls === 1
          ? Response.json({ error: "not found" }, { status: 404 })
          : Response.json({ ok: true, data: { dealId } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Deal name"), { target: { value: " Quarterly renewal " } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "420.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add deal" }));

    expect(await screen.findByText("not found")).not.toBeNull();
    expect((screen.getByLabelText("Deal name") as HTMLInputElement).value).toBe(" Quarterly renewal ");
    expect((screen.getByLabelText("Deal name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Retry deal" })).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "Retry deal" }));
    await waitFor(() => expect((screen.getByLabelText("Deal name") as HTMLInputElement).value).toBe(""));
    const submissions = fetchMock.mock.calls.filter(([path]) => String(path) === "/api/capabilities/execute");
    expect(submissions).toHaveLength(2);
    expect(JSON.parse(String(submissions[1]?.[1]?.body))).toEqual(JSON.parse(String(submissions[0]?.[1]?.body)));
  });

  it("blocks legacy deal creation until the actor and organization scope resolve", async () => {
    vi.stubGlobal("__GO_CRM_DEAL_CREATE__", false);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={null} organizationId={null} />);

    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    expect(await screen.findByText("CRM is waiting for account and organization details or restoring a saved deal draft.")).not.toBeNull();
    expect((screen.getByLabelText("Deal name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add deal" }));
    expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/deals" && init?.method === "POST")).toBe(false);
  });

  it("ignores an old deal-create response after the organization scope changes", async () => {
    vi.stubGlobal("__GO_CRM_DEAL_CREATE__", true);
    let finishCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => { finishCreate = resolve; });
    const otherOrganizationId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute") return createResponse;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Deal name"), { target: { value: "Old scope deal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add deal" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything()));

    view.rerender(<CRMPage actorId={customerId} organizationId={otherOrganizationId} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Deal name"), { target: { value: "New scope deal" } });
    await act(async () => { finishCreate(Response.json({ ok: true, data: { dealId } })); });

    expect((screen.getByLabelText("Deal name") as HTMLInputElement).value).toBe("New scope deal");
    expect(screen.queryByText("CRM changes saved.")).toBeNull();
    expect((screen.getByRole("button", { name: "Add deal" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("applies a pinned saved customer view to the directory filters", async () => {
    const inactiveCustomer = {
      ...customer("Dormant Company"),
      id: "3cebf482-832f-4bf2-b322-03ca9c123456",
      deactivatedAt: "2026-09-20T12:00:00.000Z",
    };
    const savedViews = [{
      id: "8ea6ef66-d321-4be4-a4ee-32fa0b13e5f9",
      name: "Inactive accounts",
      filters: { status: "inactive", owner: "all", staleOnly: false, duplicateOnly: false, tag: "" },
      isShared: true,
      isPinned: true,
      createdByUserId: "57329d3b-811c-4aad-ad33-9a5be2e96aaf",
      updatedAt: "2026-09-30T12:00:00.000Z",
    }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer(), inactiveCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: savedViews });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    const views = await screen.findByRole("combobox", { name: "Saved customer views" });
    expect(within(views).getByRole("option", { name: "★ Inactive accounts" })).not.toBeNull();
    fireEvent.change(views, { target: { value: savedViews[0]!.id } });

    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("inactive");
    expect(await screen.findByRole("row", { name: /Dormant Company/ })).not.toBeNull();
    expect(screen.queryByRole("row", { name: /Northwind/ })).toBeNull();
  });

  it("requires a lost reason and restores a stage move that is waiting for approval", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path) && init?.method !== "POST") return Response.json({ deals: [deal("proposal")] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/deals" && init?.method === "POST") return Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    const stageSelect = screen.getByRole("combobox", { name: "Move Annual renewal" });
    fireEvent.change(stageSelect, { target: { value: "lost" } });
    expect(await screen.findByRole("dialog", { name: /Mark “Annual renewal” as lost/ })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Confirm lost" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Lost reason"), { target: { value: "Customer chose another vendor" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm lost" }));

    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Move Annual renewal" }) as HTMLSelectElement).value).toBe("proposal"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ action: "move", dealId, stage: "lost", lostReason: "Customer chose another vendor" });
  });

  it("uses Go for lost-stage moves and keeps the reason draft after a pending approval", async () => {
    vi.stubGlobal("__GO_CRM_DEAL_STAGE_MOVE__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path) && init?.method !== "POST") return Response.json({ deals: [deal("proposal")] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute") return Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Move Annual renewal" }), { target: { value: "lost" } });
    const dialog = await screen.findByRole("dialog", { name: /Mark “Annual renewal” as lost/ });
    const reason = screen.getByLabelText("Lost reason") as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(500);
    expect((screen.getByRole("button", { name: "Confirm lost" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "ab" } });
    expect((screen.getByRole("button", { name: "Confirm lost" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "x".repeat(501) } });
    expect((screen.getByRole("button", { name: "Confirm lost" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "Customer chose another vendor" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm lost" }));

    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Move Annual renewal" }) as HTMLSelectElement).value).toBe("proposal"));
    expect(screen.getByRole("dialog", { name: /Mark “Annual renewal” as lost/ })).toBe(dialog);
    expect((screen.getByLabelText("Lost reason") as HTMLTextAreaElement).value).toBe("Customer chose another vendor");
    const post = fetchMock.mock.calls.find(([path]) => String(path) === "/api/capabilities/execute");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      capabilityId: "crm.moveDealStage",
      input: { dealId, stage: "lost", lostReason: "Customer chose another vendor" },
      intentId: expect.any(String),
    });
  });

  it("keeps a follow-up draft intact when task creation is waiting for approval", async () => {
    let taskReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") {
        taskReads += 1;
        return Response.json({ tasks: [] });
      }
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/crm" && init?.method === "POST") {
        return Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Review renewal terms" } });
    fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2026-10-15" } });
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: customerId } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Include the updated service schedule" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    expect((screen.getByLabelText("Task") as HTMLInputElement).value).toBe("Review renewal terms");
    expect((screen.getByLabelText("Due") as HTMLInputElement).value).toBe("2026-10-15");
    expect((screen.getByLabelText("Customer") as HTMLSelectElement).value).toBe(customerId);
    expect((screen.getByLabelText("Note") as HTMLInputElement).value).toBe("Include the updated service schedule");
    expect(taskReads).toBe(1);
    const post = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/crm" && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      action: "createTask",
      title: "Review renewal terms",
      dueAt: new Date("2026-10-15T12:00:00").toISOString(),
      note: "Include the updated service schedule",
      refType: "customer",
      refId: customerId,
    });
  });

  it("loads team members on a fresh Tasks tab and assigns a task after a recoverable team error", async () => {
    const ownerId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const taskId = "44444444-4444-4444-8444-444444444444";
    let taskReads = 0;
    let teamReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") {
        taskReads += 1;
        return Response.json({ tasks: taskReads === 1 ? [] : [{
          id: taskId,
          title: "Review renewal terms",
          dueAt: null,
          doneAt: null,
          note: null,
          refType: null,
          refId: null,
          assigneeUserId: ownerId,
          assigneeName: "Avery",
        }] });
      }
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team" && init?.method !== "POST") {
        teamReads += 1;
        if (teamReads === 1) return new Response(null, { status: 503 });
        return Response.json({ members: [{ userId: ownerId, name: "Avery", email: "avery@example.test" }] });
      }
      if (path === "/api/crm" && init?.method === "POST") return Response.json({ ok: true, data: { taskId } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
    expect(await screen.findByRole("alert")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry team members" }));
    await screen.findByRole("option", { name: "Avery" });
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Review renewal terms" } });
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: ownerId } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    const assignedTask = await screen.findByText("Review renewal terms");
    expect(assignedTask.closest("li")?.textContent).toContain("Avery");
    expect(teamReads).toBe(2);
    expect(taskReads).toBe(2);
    const post = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/crm" && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      action: "createTask",
      title: "Review renewal terms",
      assigneeUserId: ownerId,
    });
  });

  it("keeps an empty team loaded across tab switches and allows an unassigned task", async () => {
    let taskReads = 0;
    let teamReads = 0;
    let resolveTeam!: (response: Response) => void;
    const teamResponse = new Promise<Response>((resolve) => { resolveTeam = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") {
        taskReads += 1;
        return Response.json({ tasks: [] });
      }
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team" && init?.method !== "POST") {
        teamReads += 1;
        return teamResponse;
      }
      if (path === "/api/crm" && init?.method === "POST") return Response.json({ ok: true, data: { taskId: "44444444-4444-4444-8444-444444444444" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
    expect(await screen.findByText("Loading team members…")).not.toBeNull();
    resolveTeam(Response.json({ members: [] }));
    await waitFor(() => expect(screen.queryByText("Loading team members…")).toBeNull());
    const assignee = screen.getByLabelText("Assignee") as HTMLSelectElement;
    expect(within(assignee).getAllByRole("option").map((option) => option.textContent)).toEqual(["Unassigned"]);

    fireEvent.click(screen.getByRole("button", { name: /^Customers/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Tasks/ }));
    expect(teamReads).toBe(1);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Prepare renewal notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("CRM changes saved.")).not.toBeNull();
    expect(taskReads).toBe(2);
    const post = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/crm" && init?.method === "POST");
    const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "createTask", title: "Prepare renewal notes" });
    expect(body).not.toHaveProperty("assigneeUserId");
  });

  it("keeps customer profile editing and invoice/document timeline tabs available", async () => {
    let currentCustomer = customer();
    let timelineReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [currentCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === `/api/crm?timeline=${customerId}`) {
        timelineReads += 1;
        return Response.json({ entries: [
          { kind: "invoice", date: "2026-09-20T12:00:00.000Z", refId: dealId, summary: "Invoice #7 (issued, UGX 120,000)" },
          { kind: "document", date: "2026-09-21T12:00:00.000Z", refId: "doc-1", summary: "Signed agreement" },
        ] });
      }
      if (path === "/api/customers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string; name?: string };
        expect(body.action).toBe("updateProfile");
        currentCustomer = { ...currentCustomer, name: body.name ?? currentCustomer.name };
        return Response.json({ ok: true, data: { updatedCount: 1, previous: [] } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Northwind" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Northwind Ltd" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("heading", { name: "Northwind Ltd" })).not.toBeNull();

    const updatedDialog = screen.getByRole("dialog", { name: "Northwind Ltd" });
    fireEvent.click(within(updatedDialog).getByRole("button", { name: "Invoices" }));
    expect(within(updatedDialog).getByText(/Invoice #7/)).not.toBeNull();
    fireEvent.click(within(updatedDialog).getByRole("button", { name: "Documents" }));
    expect(within(updatedDialog).getByText("Signed agreement")).not.toBeNull();
    expect(timelineReads).toBeGreaterThan(1);
  });

  it("restores and retries the exact Go profile update after pending approval, including close and reopen", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_PROFILE_UPDATE__", true);
    const ownerId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    let currentCustomer = { ...customer(), phone: "+256 700 111 222", notes: "Old note", ownerUserId: ownerId };
    let profileAttempts = 0;
    let resolvePending!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { resolvePending = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [currentCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [{ userId: ownerId, name: "Avery", email: "avery@example.test" }] });
      if (path === `/api/crm?timeline=${customerId}`) return Response.json({ entries: [] });
      if (path === "/api/capabilities/execute") {
        profileAttempts += 1;
        if (profileAttempts === 1) return pendingResponse;
        const body = JSON.parse(String(init?.body)) as { input: { name: string } };
        currentCustomer = { ...currentCustomer, name: body.input.name };
        return Response.json({ ok: true, data: { updatedCount: 1, previous: [{ customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false }] } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let view = render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    let dialog = await screen.findByRole("dialog", { name: "Northwind" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save profile" })).toHaveProperty("disabled", false));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Northwind Ltd" } });
    fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("Owner"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("Notes"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/capabilities/execute")).toBe(true));
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).matches(":disabled")).toBe(true);
    await act(async () => { resolvePending(Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 })); });
    expect(await screen.findByText("This profile update is pending or uncertain. Retry the same action to resolve it.")).not.toBeNull();
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).matches(":disabled")).toBe(true);

    const firstRequest = fetchMock.mock.calls.find(([path]) => String(path) === "/api/capabilities/execute");
    expect(JSON.parse(String(firstRequest?.[1]?.body))).toMatchObject({ input: { name: "Northwind Ltd", phone: null, notes: null, ownerUserId: null } });

    view.unmount();
    view = render(<CRMPage actorId={customerId} organizationId={dealId} />);
    dialog = await screen.findByRole("dialog", { name: "Northwind" });
    expect(within(dialog).getByLabelText("Name")).toHaveProperty("value", "Northwind Ltd");
    expect(within(dialog).getByLabelText("Phone")).toHaveProperty("value", "");
    expect(within(dialog).getByLabelText("Owner")).toHaveProperty("value", "");
    expect(within(dialog).getByLabelText("Notes")).toHaveProperty("value", "");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry profile update" }));

    expect(await screen.findByText("Updated 1 customer.")).not.toBeNull();
    expect(currentCustomer.name).toBe("Northwind Ltd");
    expect(profileAttempts).toBe(2);
    const requests = fetchMock.mock.calls.filter(([path]) => String(path) === "/api/capabilities/execute");
    const first = JSON.parse(String(requests[0]?.[1]?.body)) as { intentId: string; input: unknown };
    const second = JSON.parse(String(requests[1]?.[1]?.body)) as { intentId: string; input: unknown };
    expect(second).toEqual({ ...first, intentId: first.intentId });
    view.unmount();
  });

  it("unlocks a profile draft after a terminal retry error so it can be corrected and restarted", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_PROFILE_UPDATE__", true);
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === `/api/crm?timeline=${customerId}`) return Response.json({ entries: [] });
      if (path === "/api/capabilities/execute") {
        attempts += 1;
        if (attempts === 1) return Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 });
        if (attempts === 2) return Response.json({ error: "The customer name is invalid." }, { status: 422 });
        return Response.json({ ok: true, data: { updatedCount: 1, previous: [{ customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false }] } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Northwind" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save profile" })).toHaveProperty("disabled", false));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Bad name" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("This profile update is pending or uncertain. Retry the same action to resolve it.")).not.toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Retry profile update" }));
    expect(await screen.findByText("The customer name is invalid.")).not.toBeNull();
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).matches(":disabled")).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Save profile" })).toHaveProperty("disabled", false);

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Northwind Ltd" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Updated 1 customer.")).not.toBeNull();
    expect(attempts).toBe(3);
    const requests = fetchMock.mock.calls.filter(([path]) => String(path) === "/api/capabilities/execute");
    const first = JSON.parse(String(requests[0]?.[1]?.body)) as { intentId: string };
    const retry = JSON.parse(String(requests[1]?.[1]?.body)) as { intentId: string };
    const restarted = JSON.parse(String(requests[2]?.[1]?.body)) as { intentId: string };
    expect(retry.intentId).toBe(first.intentId);
    expect(restarted.intentId).not.toBe(first.intentId);
  });

  it("ignores a Go profile update response after the active organization changes", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_PROFILE_UPDATE__", true);
    let finishUpdate!: (response: Response) => void;
    const updateResponse = new Promise<Response>((resolve) => { finishUpdate = resolve; });
    const nextOrganizationId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === `/api/crm?timeline=${customerId}`) return Response.json({ entries: [] });
      if (path === "/api/capabilities/execute") return updateResponse;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CRMPage actorId={customerId} organizationId={dealId} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Northwind" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save profile" })).toHaveProperty("disabled", false));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Northwind Ltd" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/capabilities/execute", expect.anything()));

    view.rerender(<CRMPage actorId={customerId} organizationId={nextOrganizationId} />);
    await act(async () => {
      finishUpdate(Response.json({ ok: true, data: { updatedCount: 1, previous: [{ customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false }] } }));
    });

    expect(screen.queryByText("Updated 1 customer.")).toBeNull();
  });

  it("freezes bulk selections and fields while an exact Go bulk profile update is unresolved", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_PROFILE_UPDATE__", true);
    const secondCustomerId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const ownerId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const customers = [customer(), { ...customer("Contoso"), id: secondCustomerId, tags: [] }];
    let attempts = 0;
    const submittedInputs: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [{ userId: ownerId, name: "Avery", email: "avery@example.test" }] });
      if (path === "/api/capabilities/execute") {
        attempts += 1;
        submittedInputs.push(JSON.parse(String(init?.body)).input);
        if (attempts === 1) return Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 });
        return Response.json({ ok: true, data: { updatedCount: 2, previous: [
          { customerId, name: "Northwind", ownerUserId: null, tags: ["renewal"], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false },
          { customerId: secondCustomerId, name: "Contoso", ownerUserId: null, tags: [], notes: "Priority account", phone: null, preferredContactMethod: "email", doNotContact: false },
        ] } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    await screen.findAllByRole("option", { name: "Avery" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Northwind" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Contoso" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Bulk owner" }), { target: { value: ownerId } });
    const bulkTag = screen.getByRole("textbox", { name: "Bulk tag" });
    fireEvent.change(bulkTag, { target: { value: "vip" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to selected" }));

    const retry = await screen.findByRole("button", { name: "Retry profile update" });
    expect(retry).toHaveProperty("disabled", false);
    expect((screen.getByRole("combobox", { name: "Bulk owner" }) as HTMLSelectElement).matches(":disabled")).toBe(true);
    expect((bulkTag as HTMLInputElement).matches(":disabled")).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select Northwind" }) as HTMLInputElement).matches(":disabled")).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select Contoso" }) as HTMLInputElement).matches(":disabled")).toBe(true);
    expect(screen.getAllByRole("button", { name: "Merge" }).every((button) => (button as HTMLButtonElement).matches(":disabled"))).toBe(true);
    fireEvent.click(retry);

    expect(await screen.findByText("Updated 2 customers.")).not.toBeNull();
    expect(attempts).toBe(2);
    expect(submittedInputs[1]).toEqual(submittedInputs[0]);
    expect(submittedInputs[0]).toEqual({ customerIds: [customerId, secondCustomerId], ownerUserId: ownerId, addTags: ["vip"] });
  });

  it("persists contact preference and do-not-contact fields through profile update", async () => {
    let currentCustomer = customer();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [currentCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/customers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          action: string;
          doNotContact?: boolean;
          preferredContactMethod?: "email" | "phone" | "whatsapp" | "other";
        };
        currentCustomer = {
          ...currentCustomer,
          doNotContact: body.doNotContact ?? currentCustomer.doNotContact,
          preferredContactMethod: body.preferredContactMethod ?? currentCustomer.preferredContactMethod,
        };
        return Response.json({ ok: true, data: { updatedCount: 1, previous: [] } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Northwind" });
    fireEvent.change(within(dialog).getByLabelText("Preferred contact"), { target: { value: "whatsapp" } });
    fireEvent.click(within(dialog).getByLabelText("Do not contact"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(currentCustomer.doNotContact).toBe(true));
    expect(currentCustomer.preferredContactMethod).toBe("whatsapp");
    const updatePost = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/customers" && init?.method === "POST");
    expect(JSON.parse(String(updatePost?.[1]?.body))).toMatchObject({
      action: "updateProfile",
      customerIds: [customerId],
      doNotContact: true,
      preferredContactMethod: "whatsapp",
    });
  });

  it("bulk assigns selected customers and adds a tag through the governed profile action", async () => {
    const secondCustomerId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const ownerId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const customers = [customer(), { ...customer("Contoso"), id: secondCustomerId, tags: [] }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method === "POST") return Response.json({ ok: true, data: { updatedCount: 2, previous: [] } });
      if (isCustomersRead(path)) return Response.json({ customers });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [{ userId: ownerId, name: "Avery", email: "avery@example.test" }] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Northwind" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Contoso" }));
    await screen.findAllByRole("option", { name: "Avery" });
    fireEvent.change(screen.getByRole("combobox", { name: "Bulk owner" }), { target: { value: ownerId } });
    const bulkTag = screen.getByRole("textbox", { name: "Bulk tag" });
    expect(bulkTag).toHaveProperty("maxLength", 40);
    fireEvent.change(bulkTag, { target: { value: "renewal" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to selected" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/customers" && init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/customers" && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      action: "updateProfile",
      customerIds: [customerId, secondCustomerId],
      ownerUserId: ownerId,
      addTags: ["renewal"],
    });
    await waitFor(() => expect(screen.getByText("0 selected")).not.toBeNull());
  });

  it("filters follow-up tasks by due date and assignment, and can include completed work", async () => {
    const assignedUserId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tasks = [
      { id: "55555555-5555-4555-8555-555555555555", title: "Today's call", dueAt: today.toISOString(), doneAt: null, assigneeUserId: assignedUserId, assigneeName: "Avery", refId: null },
      { id: "66666666-6666-4666-8666-666666666666", title: "Past due quote", dueAt: yesterday.toISOString(), doneAt: null, assigneeUserId: assignedUserId, assigneeName: "Avery", refId: null },
      { id: "77777777-7777-4777-8777-777777777777", title: "Unassigned follow-up", dueAt: null, doneAt: null, assigneeUserId: null, assigneeName: null, refId: null },
      { id: "88888888-8888-4888-8888-888888888888", title: "Completed call", dueAt: yesterday.toISOString(), doneAt: today.toISOString(), assigneeUserId: assignedUserId, assigneeName: "Avery", refId: null },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
    expect(screen.getByText("Today's call")).not.toBeNull();
    expect(screen.getByText("Past due quote")).not.toBeNull();
    expect(screen.queryByText("Completed call")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Today/ }));
    expect(screen.getByText("Today's call")).not.toBeNull();
    expect(screen.queryByText("Past due quote")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Overdue/ }));
    expect(screen.getByText("Past due quote")).not.toBeNull();
    expect(screen.queryByText("Today's call")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Unassigned/ }));
    expect(screen.getByText("Unassigned follow-up")).not.toBeNull();
    expect(screen.queryByText("Past due quote")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show completed (1)" }));
    expect(screen.getByText("Completed call")).not.toBeNull();
  });

  it("leaves a task completion checkbox unchecked when the action is pending", async () => {
    const taskId = "99999999-9999-4999-8999-999999999999";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [{ id: taskId, title: "Review renewal", doneAt: null }] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === "/api/crm" && init?.method === "POST") return Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
    const completion = screen.getByRole("checkbox", { name: "Review renewal" }) as HTMLInputElement;
    fireEvent.click(completion);

    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    expect(completion.checked).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/crm" && init?.method === "POST")?.[1]?.body))).toMatchObject({ action: "completeTask", taskId });
  });

  it("saves and retries an exact task detail update through the Go task selector", async () => {
    vi.stubGlobal("__GO_CRM_TASK_WRITES__", true);
    const taskId = "99999999-9999-4999-8999-999999999999";
    const ownerId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const task = { id: taskId, title: "Review renewal", dueAt: null, doneAt: null, assigneeUserId: null, assigneeName: null };
    let capabilityWrites = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [task] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [{ userId: ownerId, name: "Avery", email: "avery@example.test" }] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        capabilityWrites += 1;
        return capabilityWrites === 1
          ? Response.json({ pendingApproval: true, reason: "Manager approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { taskId, previous: { dueAt: null, assigneeUserId: null } } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));
    fireEvent.change(await screen.findByLabelText("Task due date"), { target: { value: "2026-10-15" } });
    fireEvent.change(screen.getByLabelText("Task assignee"), { target: { value: ownerId } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    expect((screen.getByLabelText("Task due date") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Review renewal" }) as HTMLInputElement).disabled).toBe(true);
    const retryButton = screen.getByRole("button", { name: "Retry update" });
    fireEvent.click(retryButton);

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/capabilities/execute" && init?.method === "POST")).toHaveLength(2));
    const bodies = fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/capabilities/execute" && init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0]).toMatchObject({ capabilityId: "crm.updateTaskDetails", input: { taskId, dueAt: new Date("2026-10-15T12:00:00").toISOString(), assigneeUserId: ownerId }, intentId: expect.any(String) });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("recovers task detail retries on mount and prevents completion until resolved", async () => {
    vi.stubGlobal("__GO_CRM_TASK_WRITES__", true);
    const taskId = "99999999-9999-4999-8999-999999999999";
    const otherTaskId = "88888888-8888-4888-8888-888888888888";
    const ownerId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const action = { action: "updateTaskDetails" as const, taskId, dueAt: "2026-10-15T12:00:00.000Z", assigneeUserId: ownerId };
    const scope = { actorId: customerId, organizationId: dealId };
    const preseedFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ pendingApproval: true, error: "Manager approval required" }, { status: 202 }));
    vi.stubGlobal("fetch", preseedFetch);
    await submitCrmTaskMutation(action, undefined, true, scope);
    const savedAttempt = JSON.parse(String(preseedFetch.mock.calls[0]?.[1]?.body));

    let capabilityWrites = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [
        { id: taskId, title: "Review renewal", dueAt: null, doneAt: null, assigneeUserId: null },
        { id: otherTaskId, title: "Check shipment", dueAt: null, doneAt: null, assigneeUserId: null },
      ] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [{ userId: ownerId, name: "Avery", email: "avery@example.test" }] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        capabilityWrites += 1;
        return Response.json({ ok: true, data: { taskId, previous: { dueAt: null, assigneeUserId: null } } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={customerId} organizationId={dealId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Tasks/ }));
    const completion = await screen.findByRole("checkbox", { name: "Review renewal" }) as HTMLInputElement;
    const pendingTaskRow = screen.getByText("Review renewal").closest("li")!;
    const otherTaskRow = screen.getByText("Check shipment").closest("li")!;
    await waitFor(() => expect((within(pendingTaskRow).getByRole("button", { name: "Edit details" }) as HTMLButtonElement).disabled).toBe(false));
    expect(completion.disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Check shipment" }) as HTMLInputElement).disabled).toBe(false);
    expect(capabilityWrites).toBe(0);

    fireEvent.click(within(otherTaskRow).getByRole("button", { name: "Edit details" }));
    expect(completion.disabled).toBe(true);
    fireEvent.click(within(pendingTaskRow).getByRole("button", { name: "Edit details" }));
    expect((await screen.findByLabelText("Task due date") as HTMLInputElement).value).toBe("2026-10-15");
    expect((screen.getByLabelText("Task assignee") as HTMLSelectElement).value).toBe(ownerId);
    fireEvent.click(screen.getByRole("button", { name: "Retry update" }));
    await waitFor(() => expect(capabilityWrites).toBe(1));
    const retriedBody = JSON.parse(String(fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/capabilities/execute" && init?.method === "POST")?.[1]?.body));
    expect(retriedBody).toEqual(savedAttempt);
  });

  it("downloads a CSV containing the selected customer rows", async () => {
    const exportedCustomer = { ...customer(), name: "=1+1" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [exportedCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      return new Response(null, { status: 404 });
    });
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    let downloadedBlob: Blob | undefined;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { downloadedBlob = blob; return "blob:customers"; } });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<CRMPage />);
      fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
      fireEvent.click(await screen.findByRole("checkbox", { name: "Select =1+1" }));
      fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

      expect(click).toHaveBeenCalledOnce();
      expect(click.mock.contexts[0]).toMatchObject({ download: "customers.csv", href: "blob:customers" });
      await expect(downloadedBlob?.text()).resolves.toBe([
        "Name,Email,Owner,Tags,Status",
        `"'=1+1","contact@northwind.test","","renewal","Active"`,
      ].join("\n"));
    } finally {
      if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("keeps the selected customer's timeline when profile requests finish out of order", async () => {
    const secondCustomerId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const secondCustomer = { ...customer("Contoso"), id: secondCustomerId };
    let resolveFirstTimeline!: (response: Response) => void;
    const firstTimeline = new Promise<Response>((resolve) => { resolveFirstTimeline = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer(), secondCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === `/api/crm?timeline=${customerId}`) return firstTimeline;
      if (path === `/api/crm?timeline=${secondCustomerId}`) return Response.json({ entries: [
        { kind: "document", date: "2026-09-21T12:00:00.000Z", refId: "doc-second", summary: "Contoso history" },
      ] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(within(screen.getByRole("row", { name: /Northwind/ })).getByRole("button", { name: "Profile" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Northwind" })).getByRole("button", { name: "Activity" }));
    fireEvent.click(within(screen.getByRole("row", { name: /Contoso/ })).getByRole("button", { name: "Profile" }));
    const contosoDialog = await screen.findByRole("dialog", { name: "Contoso" });
    fireEvent.click(within(contosoDialog).getByRole("button", { name: "Activity" }));
    expect(await within(contosoDialog).findByText("Contoso history")).not.toBeNull();

    resolveFirstTimeline(Response.json({ entries: [
      { kind: "document", date: "2026-09-20T12:00:00.000Z", refId: "doc-first", summary: "Northwind history" },
    ] }));
    await waitFor(() => expect(within(contosoDialog).getByText("Contoso history")).not.toBeNull());
    expect(within(contosoDialog).queryByText("Northwind history")).toBeNull();
  });

  it("ignores a pending timeline rejection after closing the customer profile", async () => {
    let rejectTimeline!: (reason: unknown) => void;
    let signalTimelineRejected!: () => void;
    const timelineRejected = new Promise<void>((resolve) => { signalTimelineRejected = resolve; });
    const pendingTimeline = new Promise<Response>((_resolve, reject) => { rejectTimeline = reject; }).catch((reason) => {
      signalTimelineRejected();
      throw reason;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === `/api/crm?timeline=${customerId}`) return pendingTimeline;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Northwind" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close customer profile" }));
    expect(screen.queryByRole("dialog", { name: "Northwind" })).toBeNull();

    await act(async () => {
      rejectTimeline(new Error("timeline request failed"));
      await timelineRejected;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Northwind" })).toBeNull();
  });

  it("converts a lead into a new customer through the existing CRM capability route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals" && init?.method === "POST") return Response.json({ ok: true, data: { dealId, customerId, stage: "qualified" } });
      if (isDealsRead(path)) return Response.json({ deals: [deal("lead")] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/crm" && init?.method === "POST") return Response.json({ ok: true, data: { dealId, customerId, stage: "qualified" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Convert lead" }));
    const dialog = screen.getByRole("dialog", { name: "Convert lead" });
    fireEvent.change(within(dialog).getByLabelText("Customer name"), { target: { value: "New Northwind" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Convert lead" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/crm" && init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/crm" && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ action: "convertLead", dealId, createCustomer: true, customerName: "New Northwind" });
  });

  it("supports deal search, table mode, and drag-and-drop stage confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals" && init?.method === "POST") return Response.json({ ok: true, data: { moved: true, stage: "qualified" } });
      if (isDealsRead(path)) return Response.json({ deals: [deal("proposal")] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Pipeline/ }));
    fireEvent.change(screen.getByLabelText("Search deals"), { target: { value: "missing" } });
    expect(screen.queryByText("Annual renewal")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search deals"), { target: { value: "renewal" } });
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table").textContent).toContain("Annual renewal");
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    const card = screen.getByText("Annual renewal").closest(".crm-deal-card");
    const transfer = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(card!, { dataTransfer: transfer });
    const target = screen.getByRole("region", { name: "Qualified deals" });
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(await screen.findByRole("dialog", { name: /Move “Annual renewal” to Qualified/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move to Qualified" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/deals" && init?.method === "POST")).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/deals" && init?.method === "POST")?.[1]?.body))).toMatchObject({ action: "move", dealId, stage: "qualified" });
  });

  it("generates an editable AI follow-up draft and displays its source records", async () => {
    const taskId = "44444444-4444-4444-8444-444444444444";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [{ id: taskId, title: "Schedule Northwind review", doneAt: "2026-09-19T12:00:00.000Z" }] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/crm?timeline=" + customerId) return Response.json({ entries: [] });
      if (path === "/api/crm" && init?.method === "POST") return Response.json({ draft: "Hello Northwind, can we review invoice 7?", sources: [{ kind: "invoice", date: "2026-09-20T12:00:00.000Z", refId: dealId, summary: "Invoice #7 is awaiting payment" }, { kind: "task", date: "2026-09-21T12:00:00.000Z", refId: taskId, summary: "Schedule Northwind review" }] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Northwind" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Draft with AI" }));
    expect(await within(dialog).findByLabelText("Message")).not.toBeNull();
    expect(within(dialog).getByText("Invoice #7 is awaiting payment")).not.toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/crm" && init?.method === "POST")?.[1]?.body))).toMatchObject({ action: "draftFollowUp", customerId });
    fireEvent.click(within(dialog).getByRole("button", { name: /Schedule Northwind review/ }));
    expect(await screen.findByRole("heading", { name: "Follow-up tasks" })).not.toBeNull();
    expect((screen.getByRole("checkbox", { name: "Show completed (1)" }) as HTMLInputElement).checked).toBe(true);
    const taskRow = screen.getByText("Schedule Northwind review").closest("li");
    expect(taskRow).toBe(document.activeElement);
  });

  it("does not request an AI follow-up draft for a do-not-contact customer", async () => {
    const protectedCustomer = { ...customer(), doNotContact: true };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path)) return Response.json({ customers: [protectedCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === `/api/crm?timeline=${customerId}`) return Response.json({ entries: [] });
      if (path === "/api/crm" && init?.method === "POST") return Response.json({ draft: "Unexpected draft", sources: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Northwind" });
    expect(within(dialog).getByText("This customer is marked do not contact. Drafting and outreach shortcuts are disabled.")).not.toBeNull();
    const draftButton = within(dialog).getByRole("button", { name: "Draft with AI" }) as HTMLButtonElement;
    expect(draftButton.disabled).toBe(true);

    fireEvent.click(draftButton);
    expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/crm" && init?.method === "POST")).toBe(false);
  });

  it("downloads the template, maps CSV columns, paginates imports, and submits all selected rows", async () => {
    const createObjectURL = vi.fn(() => "blob:crm-template");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const rows = Array.from({ length: 45 }, (_, index) => `Customer ${index + 1},${index + 1} Main St,person${index + 1}@example.test,555000${String(index + 1).padStart(4, "0")}`).join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/team") return Response.json({ members: [] });
      if (path === "/api/import" && init?.method === "POST") return Response.json({ inserted: 45, skippedDuplicates: 0, createdIds: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Customers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Download template" }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    const file = new File([`Company,Address,Contact Email,Phone\n${rows}`], "customers.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose CSV"), { target: { files: [file] } });
    expect(await screen.findByLabelText("Map name")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Map name"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Map email"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Map phone"), { target: { value: "3" } });
    expect(screen.getByText("Rows 1-40 of 45")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Row 42 name")).not.toBeNull();
    expect(screen.getByText("Rows 41-45 of 45")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Import 45 customers/ }));
    await screen.findByText("45 customers imported, 0 duplicates skipped.");
    const importPost = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/import" && init?.method === "POST");
    expect(JSON.parse(String(importPost?.[1]?.body)).rows).toHaveLength(45);
  });

  it("merges into the selected survivor and sends the undo snapshot when Undo merge is used", async () => {
    const survivorCustomerId = "69e5831e-cb62-4f9a-91d5-4b9e7c62d949";
    const duplicateCustomerId = "2beae091-6921-4e49-97b1-5049196e0ac5";
    const customers = [
      { ...customer("Survivor Company"), id: survivorCustomerId, email: "survivor@example.test" },
      { ...customer("Duplicate Company"), id: duplicateCustomerId, email: "duplicate@example.test" },
    ];
    const undoSnapshot = {
      survivorCustomerId,
      duplicateCustomerId,
      previous: [
        {
          customerId: survivorCustomerId,
          email: "survivor@example.test",
          phone: null,
          preferredContactMethod: "email",
          doNotContact: false,
          reminderOptOut: false,
          marketingOptOut: false,
          ownerUserId: null,
          tags: ["renewal"],
          notes: "Priority account",
          creditLimitMinor: 0,
          paymentTermDays: 0,
          deactivatedAt: null,
          mergedIntoCustomerId: null,
          mergedAt: null,
        },
        {
          customerId: duplicateCustomerId,
          email: "duplicate@example.test",
          phone: null,
          preferredContactMethod: "email",
          doNotContact: false,
          reminderOptOut: false,
          marketingOptOut: false,
          ownerUserId: null,
          tags: ["renewal"],
          notes: "Priority account",
          creditLimitMinor: 0,
          paymentTermDays: 0,
          deactivatedAt: null,
          mergedIntoCustomerId: null,
          mergedAt: null,
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/customers" && init?.method === "POST") {
        return Response.json({ ok: true, data: undoSnapshot });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={dealId} organizationId={customerId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    const duplicateRow = screen.getByRole("row", { name: /Duplicate Company/ });
    fireEvent.click(within(duplicateRow).getByRole("button", { name: "Merge" }));
    const mergeDialog = await screen.findByRole("dialog", { name: "Merge customer records" });
    const duplicateSelect = within(mergeDialog).getByLabelText("Duplicate record") as HTMLSelectElement;
    expect(duplicateSelect.value).toBe(duplicateCustomerId);
    fireEvent.change(within(mergeDialog).getByLabelText("Keep this customer"), { target: { value: survivorCustomerId } });
    fireEvent.click(within(mergeDialog).getByRole("button", { name: "Merge records" }));

    const mergePost = await waitFor(() => {
      const post = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/customers" && init?.method === "POST");
      expect(post).toBeDefined();
      return post;
    });
    expect(JSON.parse(String(mergePost?.[1]?.body))).toMatchObject({
      action: "merge",
      survivorCustomerId,
      duplicateCustomerId,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Undo merge" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/customers" && init?.method === "POST")).toHaveLength(2));
    const undoPost = fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/customers" && init?.method === "POST")[1];
    expect(JSON.parse(String(undoPost?.[1]?.body))).toMatchObject({ action: "undoMerge", ...undoSnapshot });
  });

  it("routes merge and undo merge through their Go capabilities", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_MERGE__", true);
    const survivorCustomerId = "69e5831e-cb62-4f9a-91d5-4b9e7c62d949";
    const duplicateCustomerId = customerId;
    const customers = [{ ...customer("Survivor Company"), id: survivorCustomerId }, { ...customer("Duplicate Company"), id: duplicateCustomerId }];
    const mergeResult = {
      survivorCustomerId,
      duplicateCustomerId,
      previous: [survivorCustomerId, duplicateCustomerId].map((id) => ({
        customerId: id,
        email: null,
        phone: null,
        preferredContactMethod: "email",
        doNotContact: false,
        reminderOptOut: false,
        marketingOptOut: false,
        ownerUserId: null,
        tags: [],
        notes: null,
        creditLimitMinor: null,
        paymentTermDays: null,
        deactivatedAt: null,
        mergedIntoCustomerId: null,
        mergedAt: null,
      })),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") return Response.json({ ok: true, data: mergeResult });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<CRMPage actorId={dealId} organizationId={customerId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(within(await screen.findByRole("row", { name: /Duplicate Company/ })).getByRole("button", { name: "Merge" }));
    const mergeDialog = await screen.findByRole("dialog", { name: "Merge customer records" });
    fireEvent.change(within(mergeDialog).getByLabelText("Keep this customer"), { target: { value: survivorCustomerId } });
    fireEvent.click(within(mergeDialog).getByRole("button", { name: "Merge records" }));
    expect(await screen.findByRole("button", { name: "Undo merge" })).not.toBeNull();
    unmount();
    render(<CRMPage actorId={dealId} organizationId={customerId} />);
    expect(await screen.findByRole("button", { name: "Undo merge" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo merge" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/capabilities/execute")).toHaveLength(2));
    const posts = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/capabilities/execute");
    const mergeBody = JSON.parse(String(posts[0]?.[1]?.body));
    const undoBody = JSON.parse(String(posts[1]?.[1]?.body));
    expect(mergeBody).toMatchObject({ capabilityId: "crm.mergeCustomers", input: { survivorCustomerId, duplicateCustomerId }, intentId: expect.any(String) });
    expect(undoBody).toMatchObject({
      capabilityId: "crm.restoreCustomerMerge",
      input: { survivorCustomerId, duplicateCustomerId, mergeIntentId: mergeBody.intentId },
      intentId: expect.any(String),
    });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/customers" && init?.method === "POST")).toBe(false);
  });

  it("imports customers and sends the exact created IDs when Undo this import is used", async () => {
    const createdIds = [
      "8ea6ef66-d321-4be4-a4ee-32fa0b13e5f9",
      "3736fc41-fbf2-4892-b290-ae17fbdbcc36",
    ];
    const importPosts: Array<{ body: string; response: Response }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/import" && init?.method === "POST") {
        const body = String(init.body);
        const requestBody = JSON.parse(body) as { action?: string };
        const response = requestBody.action === "undo"
          ? Response.json({ undone: 2, remaining: 0 })
          : Response.json({ inserted: 2, skippedDuplicates: 0, createdIds });
        importPosts.push({ body, response });
        return response;
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    const file = new File([
      "Company,Email,Phone\nNorthwind,hello@northwind.test,5550101\nContoso,hello@contoso.test,5550102",
    ], "customers.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose CSV"), { target: { files: [file] } });
    expect(await screen.findByLabelText("Map name")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Map name"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Map email"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Map phone"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Import 2 customers" }));

    expect(await screen.findByText("2 customers imported, 0 duplicates skipped.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo this import" }));

    expect(await screen.findByText("Import undone.")).not.toBeNull();
    expect(await screen.findByText("Undid this import. 2 imported customers were deactivated.")).not.toBeNull();
    expect(importPosts).toHaveLength(2);
    expect(JSON.parse(importPosts[1]!.body)).toEqual({ entity: "customers", action: "undo", importIds: createdIds });
  });

  it("requires confirmation to deactivate a customer and keeps the record in inactive history", async () => {
    let currentCustomer: Omit<ReturnType<typeof customer>, "deactivatedAt"> & { deactivatedAt: string | null } = customer();
    const deactivationPosts: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [currentCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === `/api/crm?timeline=${customerId}`) return Response.json({ entries: [
        { kind: "invoice", date: "2026-09-20T12:00:00.000Z", refId: "invoice-history-1", summary: "Invoice #42 (sent, UGX 120,000)" },
      ] });
      if (path === "/api/customers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string; customerId: string };
        deactivationPosts.push(body);
        expect(body).toMatchObject({ action: "deactivate", customerId });
        currentCustomer = { ...currentCustomer, deactivatedAt: "2026-10-01T09:30:00.000Z" };
        return Response.json({ ok: true, data: { deactivated: true } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={dealId} organizationId={customerId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    const row = await screen.findByRole("row", { name: /Northwind/ });
    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog", { name: "Deactivate Northwind?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deactivationPosts).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Deactivate Northwind?" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Deactivate customer" }));

    expect(await screen.findByText("CRM changes saved.")).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("row", { name: /Northwind/ })).toBeNull());
    expect(deactivationPosts).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "inactive" } });
    const inactiveRow = await screen.findByRole("row", { name: /Northwind/ });
    expect(within(inactiveRow).getByText("Inactive")).not.toBeNull();
    fireEvent.click(within(inactiveRow).getByRole("button", { name: "Profile" }));
    const profile = await screen.findByRole("dialog", { name: "Northwind" });
    fireEvent.click(within(profile).getByRole("button", { name: "Activity" }));
    expect(await within(profile).findByText("Invoice #42 (sent, UGX 120,000)")).not.toBeNull();
    expect(within(inactiveRow).queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("routes confirmed deactivation through Go and leaves a pending approval available for exact retry", async () => {
    vi.stubGlobal("__GO_CRM_CUSTOMER_DEACTIVATE__", true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (isDealsRead(path)) return Response.json({ deals: [] });
      if (isCustomersRead(path) && init?.method !== "POST") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (isCustomerViewsRead(path)) return Response.json({ views: [] });
      if (path === "/api/capabilities/execute" && init?.method === "POST") {
        if (fetchMock.mock.calls.filter(([url]) => String(url) === path).length === 1) {
          return Response.json({ error: "Manager approval required", pendingApproval: true }, { status: 202 });
        }
        return Response.json({ ok: true, data: { deactivated: true } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage actorId={dealId} organizationId={customerId} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Customers/ }));
    const row = await screen.findByRole("row", { name: /Northwind/ });
    fireEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog", { name: "Deactivate Northwind?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate customer" }));
    expect(await screen.findByText("Manager approval required")).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "Deactivate Northwind?" })).not.toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate customer" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/capabilities/execute")).toHaveLength(2));
    const posts = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/capabilities/execute");
    const first = JSON.parse(String(posts[0]?.[1]?.body));
    const second = JSON.parse(String(posts[1]?.[1]?.body));
    expect(first).toMatchObject({ capabilityId: "crm.deactivateCustomer", input: { customerId }, intentId: expect.any(String) });
    expect(second).toEqual(first);
    expect(await screen.findByText("CRM changes saved.")).not.toBeNull();
  });
});
