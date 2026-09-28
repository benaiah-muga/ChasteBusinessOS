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
        { id: "projects", label: "Projects", description: "Project boards and tasks", href: "/projects" },
        { id: "analytics", label: "Analytics", description: "Governed reports", href: "/analytics" },
      ],
      enabledModules: ["projects", "analytics"],
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

  it("loads the authenticated home and signs out through Better Auth", async () => {
    render(<App />);

    expect(await screen.findByText("$12,500.00")).not.toBeNull();
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Active organization" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Good to see you." })).not.toBeNull();
    expect(authMocks.signOut).toHaveBeenCalledOnce();
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
