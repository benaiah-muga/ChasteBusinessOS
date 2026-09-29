import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { dashboardFixture, myWorkFixture, setupFixture } from "./test/dashboard-fixture";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

const legacyMocks = vi.hoisted(() => ({
  legacyUrl: vi.fn((path: string) => new URL(path, "http://localhost:3001").toString()),
  redirectToLegacy: vi.fn(),
}));

vi.mock("./api/auth", () => ({
  authClient: {
    getSession: authMocks.getSession,
    signOut: authMocks.signOut,
  },
}));

vi.mock("./legacy", () => legacyMocks);

const firstOrgId = "62d994c0-a6d8-4ac2-9ec6-6689ba2bfc12";
const secondOrgId = "21e89f2b-996f-4b18-9078-c0f2f743a5ab";

let activeOrgId = firstOrgId;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  activeOrgId = firstOrgId;
  legacyMocks.redirectToLegacy.mockClear();
  legacyMocks.legacyUrl.mockClear();
  authMocks.getSession.mockResolvedValue({ data: { user: { id: "user-1", name: "Ada Lovelace", email: "ada@example.test" } } });
  authMocks.signOut.mockImplementation(async () => {
    authMocks.getSession.mockResolvedValue({ data: { user: null } });
    return { data: { success: true }, error: null };
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/org" && init?.method === "POST") {
      activeOrgId = JSON.parse(String(init.body)).orgId as string;
      return Response.json({ ok: true });
    }
    if (path === "/api/org") return Response.json({
      activeOrgId,
      orgs: [
        { id: firstOrgId, name: "First workspace", baseCurrency: "USD" },
        { id: secondOrgId, name: "Second workspace", baseCurrency: "UGX" },
      ],
    });
    if (path === "/api/approvals") {
      const workspace = activeOrgId === firstOrgId ? "First" : "Second";
      return Response.json({
        approvals: [{
          id: `approval-${workspace.toLowerCase()}`,
          capabilityId: "crm.createCustomer",
          riskClass: "write",
          payload: { name: `${workspace} workspace approval` },
          rationale: "A person needs to review this change.",
          createdAt: "2026-09-27T10:15:00.000Z",
          status: "pending",
        }],
        history: [],
      });
    }
    if (path === "/api/ledger?limit=100") {
      return Response.json({ events: [{
        seq: 24,
        kind: activeOrgId === firstOrgId ? "invoice.created" : "payment.recorded",
        capabilityId: "accounting.recordPayment",
        actorType: "agent",
        actorId: "user-1",
        sessionId: "session-abcdefgh",
        payload: { amountMinor: 12500 },
        hash: "1234567890abcdef1234567890abcdef",
        prevHash: "fedcba0987654321fedcba0987654321",
        occurredAt: "2026-09-27T10:15:00.000Z",
      }] });
    }
    if (path === "/api/dashboard") return Response.json(dashboardFixture);
    if (path === "/api/setup") return Response.json({ items: setupFixture, remaining: 1 });
    if (path === "/api/my-work") return Response.json({ cards: myWorkFixture, generatedAt: "2026-09-27T10:15:00.000Z" });
    if (path === "/api/my-work/summarize") return Response.json({ brief: "The ranked work is ready." });
    if (path === "/api/modules") return Response.json({
      catalog: [
        { id: "accounting", label: "Accounting", description: "Financial reports and invoices", href: "/accounting/invoices" },
        { id: "purchasing", label: "Purchasing", description: "Supplier purchasing and payment runs", href: "/purchasing/payment-runs" },
        { id: "projects", label: "Projects", description: "Project boards and tasks", href: "/projects" },
        { id: "analytics", label: "Analytics", description: "Governed reports", href: "/analytics" },
        { id: "inventory", label: "Inventory", description: "Stock levels and reorder needs", href: "/inventory" },
      ],
      enabledModules: ["accounting", "purchasing", "projects", "analytics", "inventory"],
      usingDefaults: false,
    });
    if (path === "/api/analytics" && init?.method === "POST") return Response.json({
      region: "East Africa",
      html: "<html></html>",
      sections: [{ heading: "Pipeline by stage", svg: null, columns: ["stage", "dealCount"], rows: [{ stage: "Qualified", dealCount: 3 }] }],
    });
    if (path === "/api/analytics?dataset=analytics.pipelineByStage") return Response.json({
      columns: ["stage", "dealCount", "valueMinor"],
      rows: [{ stage: "Qualified", dealCount: 3, valueMinor: 120000 }],
    });
    if (path === "/api/analytics") return Response.json({ datasets: [
      { id: "analytics.pipelineByStage", label: "Pipeline by stage", description: "Deal counts and values per stage" },
    ] });
    if (path === "/api/projects") return Response.json({ projects: [{
      id: activeOrgId === firstOrgId ? "0d57752c-41c1-4aae-9c78-b51d9ec07d62" : "2beae091-6921-4e49-97b1-5049196e0ac5",
      name: activeOrgId === firstOrgId ? "First workspace project" : "Second workspace project",
      status: "active",
      dueAt: null,
      createdAt: "2026-09-20T09:30:00.000Z",
    }] });
    if (path.startsWith("/api/projects?projectId=")) return Response.json({ columns: [
      { status: "todo", tasks: [] },
      { status: "doing", tasks: [] },
      { status: "done", tasks: [] },
    ] });
    if (path === "/api/team") return Response.json({
      members: [{ userId: "user-1", name: "Ada Lovelace", email: "ada@example.test", roleKeys: ["owner"] }],
      roles: [{ id: "role-bookkeeper", key: "bookkeeper", name: "Bookkeeper", isSystem: false, permissions: ["accounting.read"] }],
      catalog: ["accounting.read", "accounting.write"],
    });
    if (path === "/api/deals") return Response.json({ deals: [] });
    if (path === "/api/customers") return Response.json({ customers: [] });
    if (path === "/api/crm?tasks=1") return Response.json({ tasks: [] });
    if (path === "/api/crm/views") return Response.json({ views: [] });
    if (path === "/api/inventory") return Response.json({
      items: [{ sku: "MUG-1", name: "Ceramic mug", kind: "product", unitLabel: "unit", onHandThousandths: 4000, reservedThousandths: 1000, availableThousandths: 3000, totalValueMinor: 2000, reorderPointThousandths: 5000, reorderNeeded: true }],
      totalValueMinor: 2000,
    });
    if (path === "/api/accounting") return Response.json({ invoices: [{
      id: "f9184ddd-a042-4e24-9fe1-553cadc44df1",
      number: 1042,
      customerId: "348a55cb-0d16-47e0-aee3-6e61952e05af",
      customerName: "Acme Supplies",
      status: "sent",
      currency: "USD",
      totalMinor: 15000,
      paidMinor: 5000,
      outstandingMinor: 10000,
      issuedAt: "2026-09-29T09:00:00.000Z",
    }] });
    if (path.startsWith("/api/accounting/close?")) {
      const query = new URL(path, "http://localhost").searchParams;
      const year = Number(query.get("year"));
      const month = Number(query.get("month"));
      const tasks = [
        { key: "review_journal", label: "Review journals", detail: "Review posted journals for this month.", completed: true, note: "Reviewed with controller", blocking: false, status: "complete" },
        { key: "bank_reconciliation", label: "Reconcile bank activity", detail: "3 statement lines remain unmatched.", completed: false, note: null, blocking: true, status: "blocked" },
        { key: "fx_revaluation", label: "Revalue foreign receivables", detail: "Open foreign receivables: EUR, KES.", completed: false, note: null, blocking: true, status: "needs_revaluation" },
      ];
      return Response.json({ ok: true, data: {
        year,
        month,
        start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
        end: new Date(Date.UTC(year, month, 1) - 1).toISOString(),
        tasks,
        blockers: tasks.filter((task) => task.blocking).map((task) => task.key),
        readyToClose: false,
        unmatchedLineCount: 3,
        currenciesWithExposure: ["EUR", "KES"],
      } });
    }
    if (path === "/api/purchasing/payment-runs") return Response.json({ ok: true, data: { runs: [{
      id: "10000000-0000-4000-8000-000000000003",
      reference: "PAY-204",
      currency: "USD",
      totalMinor: 45000,
      status: "instructed",
      createdAt: "2026-09-28T09:00:00.000Z",
      instructedAt: "2026-09-28T10:00:00.000Z",
      confirmedAt: null,
      entryId: null,
      lines: [{ billId: "10000000-0000-4000-8000-000000000004", billNumber: 88, vendorName: "Acme Supplies", vendorRef: null, amountMinor: 45000 }],
    }] } });
    if (path === "/api/purchasing" && init?.method === "POST") return Response.json({ ok: true, data: {
      receipts: [{
        number: 2,
        receivedAt: "2026-09-28T09:30:00.000Z",
        note: "Second delivery",
        lines: [{
          position: 1,
          description: "Steel rods",
          acceptedThousandths: 7000,
          rejectedThousandths: 1000,
          returnedThousandths: 500,
          rejectionNote: "Damaged ends",
        }],
      }],
      orderLines: [{
        position: 1,
        description: "Steel rods",
        orderedThousandths: 10000,
        acceptedThousandths: 7000,
        rejectedThousandths: 1000,
        returnedThousandths: 500,
        remainingThousandths: 2000,
      }],
    } });
    if (path === "/api/purchasing") return Response.json({ baseCurrency: "USD", orders: [{
      id: "10000000-0000-4000-8000-000000000005",
      number: 204,
      vendorName: "Acme Supplies",
      status: "partially_received",
      memo: null,
      orderedMinor: 150000,
      lines: [{ lineNumber: 1, description: "Steel rods", quantity: 10000, unitPriceMinor: 15000 }],
    }] });
    if (path === "/api/pos" && init?.method === "POST") return Response.json({ ok: true, data: {
      register: "Main register",
      status: "closed",
      salesCount: 4,
      takingsMinor: 12_500,
      tenderTotals: [{ method: "cash", amountMinor: 10_000 }, { method: "card", amountMinor: 2_500 }],
      refundTotals: [],
      expectedCashMinor: 10_000,
      countedCashMinor: 10_000,
      varianceMinor: 0,
    } });
    if (path === "/api/pos") return Response.json({ sessions: [{
      id: "9f761d17-27fc-49c5-9d4a-327711a1f011",
      number: 3,
      status: "closed",
      openedAt: "2026-09-29T08:00:00.000Z",
      closedAt: "2026-09-29T16:00:00.000Z",
    }], sales: [] });
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("Vite app frame", () => {
  it("sends an unauthenticated visitor to the existing Better Auth login", async () => {
    authMocks.getSession.mockResolvedValue({ data: { user: null } });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Good to see you." })).not.toBeNull();
    expect(window.location.pathname).toBe("/login");
  });

  it("keeps direct CRM access behind the existing session check", async () => {
    window.history.replaceState(null, "", "/crm");
    authMocks.getSession.mockResolvedValue({ data: { user: null } });
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Good to see you." })).not.toBeNull();
    expect(window.location.pathname).toBe("/login");
    expect(fetchMock.mock.calls.some(([input]) => ["/api/deals", "/api/customers", "/api/crm", "/api/crm/views"].includes(String(input)))).toBe(false);
  });

  it("loads the authenticated home and signs out through Better Auth", async () => {
    render(<App />);

    expect(await screen.findByText("$12,500.00")).not.toBeNull();
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Active organization" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Good to see you." })).not.toBeNull();
    expect(authMocks.signOut).toHaveBeenCalledOnce();
  });

  it("opens the POS shift-summary preview within the authenticated shell", async () => {
    window.history.replaceState(null, "", "/pos/shift-summary");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "POS shift summary" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "POS summary" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Open full POS workspace" })).not.toBeNull();
    expect(await screen.findByText("$125.00")).not.toBeNull();
  });

  it("opens the inventory stock preview within the authenticated shell", async () => {
    window.history.replaceState(null, "", "/inventory");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Inventory" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Inventory" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Open full inventory workspace" })).not.toBeNull();
    expect(await screen.findByText("MUG-1")).not.toBeNull();
    expect(await screen.findAllByText("$20.00")).toHaveLength(2);
  });

  it("opens the invoice preview within the authenticated shell", async () => {
    window.history.replaceState(null, "", "/accounting/invoices");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Accounting invoices" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Accounting" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Open full Accounting workspace" })).not.toBeNull();
    expect(await screen.findByText("#1042")).not.toBeNull();
  });

  it("opens Accounting close readiness in the authenticated shell", async () => {
    window.history.replaceState(null, "", "/accounting/close");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Period close readiness" })).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Not ready to close" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Close readiness" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Open full period close workspace" }).getAttribute("href"))
      .toBe("http://localhost:3001/accounting/close");
    expect(await screen.findByText("3 statement lines remain unmatched.")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/accounting/close?"))).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(legacyMocks.redirectToLegacy).not.toHaveBeenCalled();
  });

  it("opens the supplier payment-run preview within the authenticated shell", async () => {
    window.history.replaceState(null, "", "/purchasing/payment-runs");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Supplier payment runs" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Purchasing" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Open full Purchasing workspace" })).not.toBeNull();
    expect(await screen.findByText("PAY-204")).not.toBeNull();
  });

  it("opens the purchase receipt history preview within the authenticated shell", async () => {
    window.history.replaceState(null, "", "/purchasing/receipts");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Purchase receipt history" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Receipts" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Open full receiving workspace" }).getAttribute("href"))
      .toBe("http://localhost:3001/purchasing/receiving");
    expect(await screen.findByText("Damaged ends")).not.toBeNull();
    expect(screen.getByText("2.000")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/purchasing", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "receiptDetail", poNumber: 204 }),
      credentials: "same-origin",
    }));
    expect(legacyMocks.redirectToLegacy).not.toHaveBeenCalled();
  });

  it("refreshes dashboard context and currency after switching organizations", async () => {
    render(<App />);
    const selector = await screen.findByRole("combobox", { name: "Active organization" });
    expect(await screen.findByText("$12,500.00")).not.toBeNull();

    fireEvent.change(selector, { target: { value: secondOrgId } });
    expect(await screen.findByText("USh1,250,000")).not.toBeNull();
    expect((screen.getByRole("combobox", { name: "Active organization" }) as HTMLSelectElement).value).toBe(secondOrgId);
  });

  it("renders the approvals preview and reloads its queue after an organization switch", async () => {
    window.history.replaceState(null, "", "/approvals");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Approvals" })).not.toBeNull();
    expect(await screen.findByText("First workspace approval", { selector: "dd" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Approvals" }).getAttribute("aria-current")).toBe("page");

    const selector = screen.getByRole("combobox", { name: "Active organization" });
    fireEvent.change(selector, { target: { value: secondOrgId } });

    expect(await screen.findByText("Second workspace approval", { selector: "dd" })).not.toBeNull();
    expect(screen.queryByText("First workspace approval", { selector: "dd" })).toBeNull();
    expect((screen.getByRole("combobox", { name: "Active organization" }) as HTMLSelectElement).value).toBe(secondOrgId);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/approvals")).toHaveLength(2);
  });

  it("renders the ledger preview in the authenticated shell and reloads after an organization switch", async () => {
    window.history.replaceState(null, "", "/ledger");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Event Ledger" })).not.toBeNull();
    expect(await screen.findByText("invoice.created")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Ledger" }).getAttribute("aria-current")).toBe("page");
    expect(fetchMock).toHaveBeenCalledWith("/api/ledger?limit=100", expect.objectContaining({ credentials: "same-origin" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Active organization" }), { target: { value: secondOrgId } });

    expect(await screen.findByText("payment.recorded")).not.toBeNull();
    expect(screen.queryByText("invoice.created")).toBeNull();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/ledger?limit=100")).toHaveLength(2);
  });

  it("keeps the team and roles page in Vite and reloads its data after an organization switch", async () => {
    window.history.replaceState(null, "", "/team");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Team & roles" })).not.toBeNull();
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Team" }).getAttribute("href")).toBe("/team");
    expect(screen.getByRole("link", { name: "Team" }).getAttribute("aria-current")).toBe("page");
    expect(legacyMocks.redirectToLegacy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "Active organization" }), { target: { value: secondOrgId } });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/team")).toHaveLength(2));
  });

  it("renders the CRM preview in Vite and keeps its APIs same-origin", async () => {
    window.history.replaceState(null, "", "/crm");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "CRM" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "CRM" }).getAttribute("href")).toBe("/crm");
    expect(screen.getByRole("link", { name: "CRM" }).getAttribute("aria-current")).toBe("page");
    expect(legacyMocks.redirectToLegacy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/deals", expect.objectContaining({ credentials: "same-origin" }));
      expect(fetchMock).toHaveBeenCalledWith("/api/customers", expect.objectContaining({ credentials: "same-origin" }));
    });
  });

  it("loads the projects board in the authenticated shell and resets it after an organization switch", async () => {
    window.history.replaceState(null, "", "/projects");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Board · First workspace project" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ credentials: "same-origin" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Active organization" }), { target: { value: secondOrgId } });

    expect(await screen.findByRole("heading", { name: "Board · Second workspace project" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Board · First workspace project" })).toBeNull();
  });

  it("loads Analytics in the authenticated shell and reloads after an organization switch", async () => {
    window.history.replaceState(null, "", "/analytics");
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Analytics" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Analytics" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("combobox", { name: /Add a dataset/ })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/analytics", expect.objectContaining({ credentials: "same-origin" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Active organization" }), { target: { value: secondOrgId } });

    expect(await screen.findByRole("heading", { name: "Analytics" })).not.toBeNull();
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/analytics")).toHaveLength(2);
    });
  });

  it("keeps unported route ownership in legacy and preserves query and hash on the fallback", async () => {
    window.history.replaceState(null, "", "/onboarding?step=profile#business");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Opening this page in the current app." })).not.toBeNull();
    expect(legacyMocks.redirectToLegacy).toHaveBeenCalledWith("/onboarding?step=profile#business");
    expect(screen.getByRole("link", { name: "Continue to the existing app" }).getAttribute("href"))
      .toBe("http://localhost:3001/onboarding?step=profile#business");
  });
});
