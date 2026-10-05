import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const switchboard = {
  catalog: [
    { id: "crm", label: "CRM", description: "Customers and deal pipeline", href: "/crm" },
    { id: "accounting", label: "Accounting", description: "Ledger, invoicing, bills", href: "/accounting" },
    { id: "iam", label: "Identity & access", description: "Roles, permissions, module switchboard", href: "/team", protected: true },
    { id: "routines", label: "Routines", description: "Scheduled agent runs", href: null, protected: true },
    { id: "signals", label: "Signals", description: "Needs-attention registry", href: null, protected: true },
  ],
  enabledModules: ["crm", "accounting", "iam", "routines", "signals"],
  usingDefaults: true,
};

const aiConfig = {
  provider: "nvidia",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  models: {
    primary: "moonshotai/kimi-k2.6",
    fast: "meta/muse-glimmer-30b",
    reasoning: "nvidia/nemotron-3-ultra-550b-a55b",
    embeddings: "nvidia/nv-embedqa-e5-v5",
  },
  configured: true,
  keyHint: "••••1234",
  source: "workspace",
};

const policy = {
  policy: { maxRiskAutonomous: "write", moneyThresholdMinor: 50_000, requiresApprovalFor: ["identity"] },
  canEdit: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

type Route = [input: RequestInfo | URL, init?: RequestInit | undefined];

function routedFetch(handlers: Record<string, (init: RequestInit | undefined) => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const handler = handlers[path] ?? handlers[path.split("?")[0] ?? path];
    return handler ? handler(init) : jsonResponse({ error: "not stubbed" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postsTo(fetchMock: { mock: { calls: Route[] } }, path: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url) === path && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

const orgRoute = () => jsonResponse({
  activeOrgId: "11111111-1111-4111-8111-111111111111",
  orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Benson's Hardware", baseCurrency: "USD" }],
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Vite settings page", () => {
  it("names the active organization and links out to the surfaces that own the facts", async () => {
    const fetchMock = routedFetch({
      "/api/org": orgRoute,
      "/api/modules": () => jsonResponse(switchboard),
    });
    render(<SettingsPage baseCurrency="USD" />);

    expect(await screen.findByText("Benson's Hardware")).not.toBeNull();
    expect(screen.getByText(/Managed by owners/)).not.toBeNull();
    expect(screen.getByRole("link", { name: /Team & roles/ }).getAttribute("href")).toContain("/team");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain("/api/org");
  }, 20_000);

  it("locks the platform spine and unions it back in on a governed switchboard change", async () => {
    const fetchMock = routedFetch({
      "/api/modules": (init) => (init?.method === "POST"
        ? jsonResponse({ ok: true, data: { modules: switchboard.enabledModules } })
        : jsonResponse({ ...switchboard, enabledModules: ["accounting", "iam", "routines", "signals"] })),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Modules" }));

    const iamSwitch = await screen.findByRole("switch", { name: "Disable Identity & access" });
    expect((iamSwitch as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Disable Routines" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Disable Signals" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Enable CRM" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: "Enable CRM" }));

    await waitFor(() => expect(postsTo(fetchMock, "/api/modules")).toHaveLength(1));
    const body = postsTo(fetchMock, "/api/modules")[0]!;
    const modules = [...(body.modules as string[])].sort();
    expect(modules).toEqual(["accounting", "crm", "iam", "routines", "signals"]);
    expect(String(body.intentId)).toHaveLength(36);
    expect(await screen.findByText(/Module switchboard updated/)).not.toBeNull();
  }, 20_000);

  it("keeps an approval-gated module change pending instead of calling it saved or failed", async () => {
    routedFetch({
      "/api/modules": (init) => (init?.method === "POST"
        ? jsonResponse({ pendingApproval: true, hint: "Module changes proposed by the workmate wait for approval in the Approvals inbox." }, 202)
        : jsonResponse(switchboard)),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Modules" }));
    await screen.findByRole("switch", { name: "Disable CRM" });
    fireEvent.click(screen.getByRole("switch", { name: "Disable CRM" }));

    expect(await screen.findByText("Module changes proposed by the workmate wait for approval in the Approvals inbox.")).not.toBeNull();
    expect(screen.queryByText(/Module switchboard updated/)).toBeNull();
  }, 20_000);

  it("refuses to empty the switchboard", async () => {
    const fetchMock = routedFetch({ "/api/modules": () => jsonResponse({ ...switchboard, catalog: [switchboard.catalog[3]!], enabledModules: ["routines"] }) });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Modules" }));
    const spine = await screen.findByRole("switch", { name: "Disable Routines" });
    expect((spine as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("At least one module must stay enabled.")).toBeNull();
    expect(postsTo(fetchMock, "/api/modules")).toHaveLength(0);
  }, 20_000);

  it("converts the payment threshold into minor units and gates policy edits on iam.admin", async () => {
    const fetchMock = routedFetch({
      "/api/policy": (init) => (init?.method === "POST"
        ? jsonResponse({ ok: true, data: {} })
        : jsonResponse({ ...policy, policy: { ...policy.policy, moneyThresholdMinor: 50_000 } })),
    });
    render(<SettingsPage baseCurrency="USD" />);
    fireEvent.click(screen.getByRole("tab", { name: "Governance" }));

    const threshold = await screen.findByLabelText("Payment approval threshold");
    expect((threshold as HTMLInputElement).value).toBe("500");
    fireEvent.change(threshold, { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

    await waitFor(() => expect(postsTo(fetchMock, "/api/policy")).toHaveLength(1));
    expect(postsTo(fetchMock, "/api/policy")[0]).toMatchObject({
      maxRiskAutonomous: "write",
      moneyThresholdMinor: 1_250,
      requiresApprovalFor: ["identity"],
    });
    expect(await screen.findByText(/Policy saved/)).not.toBeNull();
  }, 20_000);

  it("hides the policy save control from non-admins and explains why", async () => {
    routedFetch({ "/api/policy": () => jsonResponse({ ...policy, canEdit: false }) });
    render(<SettingsPage baseCurrency="USD" />);
    fireEvent.click(screen.getByRole("tab", { name: "Governance" }));

    expect(await screen.findByText("Only organization admins can change policy.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Save policy" })).toBeNull();
    expect((screen.getByLabelText("Max autonomous risk") as HTMLSelectElement).disabled).toBe(true);
  }, 20_000);

  it("shows only the short key hint, keeps the key field write-only, and never echoes a credential", async () => {
    const fetchMock = routedFetch({
      "/api/org": (init) => (init?.method === "PUT" ? jsonResponse({ agentSoul: "" }) : orgRoute()),
      "/api/ai-config": () => jsonResponse(aiConfig),
      "/api/memory": () => jsonResponse({ memories: [], total: 0, canEdit: false }),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "AI & automation" }));

    const keyField = (await screen.findByLabelText("API key")) as HTMLInputElement;
    expect(keyField.type).toBe("password");
    expect(keyField.value).toBe("");
    expect(keyField.placeholder).toBe("Current key ••••1234");
    expect(document.body.textContent).toContain("••••1234");
    expect(document.body.textContent).not.toContain("encryptedApiKey");

    fireEvent.change(keyField, { target: { value: "nvapi-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model configuration" }));

    await waitFor(() => expect(postsTo(fetchMock, "/api/ai-config")).toHaveLength(1));
    const body = postsTo(fetchMock, "/api/ai-config")[0]!;
    expect(body).toMatchObject({ provider: "nvidia", apiKey: "nvapi-secret-value" });
    expect(body).not.toHaveProperty("intentId");
    expect(body).not.toHaveProperty("keyHint");
  }, 20_000);

  it("surfaces a gated credential change as pending and keeps Clear stored key disabled without one", async () => {
    routedFetch({
      "/api/org": (init) => (init?.method === "PUT" ? jsonResponse({ agentSoul: "" }) : orgRoute()),
      "/api/ai-config": () => jsonResponse({ ...aiConfig, configured: false, keyHint: null }),
      "/api/memory": () => jsonResponse({ memories: [], total: 0, canEdit: false }),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "AI & automation" }));

    expect(await screen.findByText("credential missing")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Clear stored key" }) as HTMLButtonElement).disabled).toBe(true);
  }, 20_000);

  it("confirms before forgetting a memory and reports a gated deletion as pending", async () => {
    const fetchMock = routedFetch({
      "/api/org": (init) => (init?.method === "PUT" ? jsonResponse({ agentSoul: "" }) : orgRoute()),
      "/api/ai-config": () => jsonResponse(aiConfig),
      "/api/memory": (init) => (init?.method === "POST"
        ? jsonResponse({ pendingApproval: true, hint: "Memory deletion proposed by the workmate waits for approval in the Approvals inbox." }, 202)
        : jsonResponse({
            memories: [{ id: "mem-1", kind: "sop", source: "invoice.pdf", content: "full", preview: "Refunds need a receipt", createdAt: "2026-01-01T00:00:00.000Z" }],
            total: 1,
            canEdit: true,
          })),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "AI & automation" }));

    expect(await screen.findByText("Refunds need a receipt")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete memory entry" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Forget this memory?")).not.toBeNull();
    expect(postsTo(fetchMock, "/api/memory")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
    expect(await screen.findByText("Memory deletion proposed by the workmate waits for approval in the Approvals inbox.")).not.toBeNull();
    expect(postsTo(fetchMock, "/api/memory")[0]).toMatchObject({ action: "delete", memoryId: "mem-1" });
  }, 20_000);

  it("creates a routine and reports the webhook trigger the server minted", async () => {
    const fetchMock = routedFetch({
      "/api/routines": (init) => (init?.method === "POST"
        ? jsonResponse({ id: "r1", webhookUrl: "https://app.example/api/routines/webhook/tok_123" })
        : jsonResponse({ routines: [] })),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Routines" }));

    expect(await screen.findByText("No routines yet. Create one above, or start with the daily heartbeat.")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Morning check" } });
    fireEvent.change(screen.getByLabelText("Schedule in plain language"), { target: { value: "weekdays at 9am" } });
    fireEvent.change(screen.getByLabelText("Routine instructions"), { target: { value: "Check overdue invoices" } });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

    expect(await screen.findByText(/Routine created. Webhook trigger: https:\/\/app.example/)).not.toBeNull();
    expect(postsTo(fetchMock, "/api/routines")[0]).toMatchObject({
      action: "create",
      name: "Morning check",
      scheduleText: "weekdays at 9am",
      withWebhook: false,
    });
    await waitFor(() => expect((screen.getByLabelText("Routine name") as HTMLInputElement).value).toBe(""));
  }, 20_000);

  it("shows the Go routine schedule validation guidance for unsupported phrases", async () => {
    const guidance = "could not parse the schedule: try 'twice a day', 'each morning at 8', 'every 30 minutes', 'daily at 08:00', 'weekdays at 9am' or 'weekly on monday at 09:00'";
    routedFetch({
      "/api/routines": (init) => (init?.method === "POST"
        ? jsonResponse({ error: guidance }, 422)
        : jsonResponse({ routines: [] })),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Routines" }));
    await screen.findByText("No routines yet. Create one above, or start with the daily heartbeat.");
    fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Ad hoc check" } });
    fireEvent.change(screen.getByLabelText("Schedule in plain language"), { target: { value: "a few times a day" } });
    fireEvent.change(screen.getByLabelText("Routine instructions"), { target: { value: "Check overdue invoices" } });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

    expect((await screen.findByRole("alert")).textContent).toBe(guidance);
    expect(screen.queryByText("Routine created.")).toBeNull();
  }, 20_000);

  it("shows runtime compositions as metadata only and explains a refused inspection", async () => {
    routedFetch({
      "/api/harness/compositions": () => jsonResponse({
        compositions: [{
          id: "cmp-1",
          createdAt: new Date().toISOString(),
          inspection: {
            profile: { id: "erp-prod", version: "1.0.0", environment: "erp-prod" },
            profileDigest: "sha256:profile",
            compositionDigest: "sha256:composition",
            bundles: [{ id: "core", version: "1.2.0", serviceIds: ["api", "worker"] }],
            patches: [{ id: "billing", version: "0.4.0", configKeys: ["LEDGER_URL"] }],
          },
        }],
      }),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Runtime" }));

    expect((await screen.findAllByText("erp-prod")).length).toBe(2);
    expect(screen.getByText("core@1.2.0")).not.toBeNull();
    expect(screen.getByText("sha256:composition")).not.toBeNull();
  }, 20_000);
});
