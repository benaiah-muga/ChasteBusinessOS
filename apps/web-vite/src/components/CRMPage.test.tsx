import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRMPage } from "./CRMPage";

const dealId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const customerId = "2beae091-6921-4e49-97b1-5049196e0ac5";

function customer(name = "Northwind") {
  return { id: customerId, name, email: "contact@northwind.test", phone: null, preferredContactMethod: "email", doNotContact: false, ownerUserId: null, ownerName: null, tags: ["renewal"], notes: "Priority account", nextStep: null, lastActivityAt: "2026-09-28T12:00:00.000Z", deactivatedAt: null };
}
function deal(stage: string) {
  return { id: dealId, title: "Annual renewal", stage, valueMinor: 480000, note: null, customerId, customerName: "Northwind", updatedAt: "2026-09-29T12:00:00.000Z" };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Vite CRM page", () => {
  it("requires a lost reason and restores a stage move that is waiting for approval", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals" && init?.method !== "POST") return Response.json({ deals: [deal("proposal")] });
      if (path === "/api/customers") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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

    expect((await screen.findByRole("status")).textContent).toContain("Manager approval required");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Move Annual renewal" }) as HTMLSelectElement).value).toBe("proposal"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ action: "move", dealId, stage: "lost", lostReason: "Customer chose another vendor" });
  });

  it("keeps customer profile editing and invoice/document timeline tabs available", async () => {
    let currentCustomer = customer();
    let timelineReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method !== "POST") return Response.json({ customers: [currentCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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

  it("bulk assigns selected customers and adds a tag through the governed profile action", async () => {
    const secondCustomerId = "3cebf482-832f-4bf2-b322-03ca9c123456";
    const ownerId = "4a16ce8b-8f2a-4e10-8bd8-2396c61ad78a";
    const customers = [customer(), { ...customer("Contoso"), id: secondCustomerId, tags: [] }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method === "POST") return Response.json({ ok: true, data: { updatedCount: 2, previous: [] } });
      if (path === "/api/customers") return Response.json({ customers });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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

  it("downloads a CSV containing the selected customer rows", async () => {
    const exportedCustomer = { ...customer(), name: "=1+1" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers") return Response.json({ customers: [exportedCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers") return Response.json({ customers: [customer(), secondCustomer] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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
      if (path === "/api/deals") return Response.json({ deals: [deal("lead")] });
      if (path === "/api/customers") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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
      if (path === "/api/deals") return Response.json({ deals: [deal("proposal")] });
      if (path === "/api/customers") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers") return Response.json({ customers: [customer()] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [{ id: taskId, title: "Schedule Northwind review", doneAt: null }] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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
    const taskRow = screen.getByText("Schedule Northwind review").closest("li");
    expect(taskRow).toBe(document.activeElement);
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
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method !== "POST") return Response.json({ customers: [] });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
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
      if (path === "/api/deals") return Response.json({ deals: [] });
      if (path === "/api/customers" && init?.method !== "POST") return Response.json({ customers });
      if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
      if (path === "/api/crm/views") return Response.json({ views: [] });
      if (path === "/api/customers" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string };
        return Response.json({ ok: true, data: body.action === "merge" ? undoSnapshot : {} });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CRMPage />);

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
});
