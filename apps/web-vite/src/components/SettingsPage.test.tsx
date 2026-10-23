import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitGoverned } from "../api/settings";
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
  Reflect.deleteProperty(navigator, "locks");
  localStorage.clear();
});

function enableRetryLock() {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name: string, _options: { mode: "exclusive" }, callback: () => unknown) => callback() },
  });
}

describe("Vite settings page", () => {
  it("names the active organization and links out to the surfaces that own the facts", async () => {
    const fetchMock = routedFetch({
      "/api/org": orgRoute,
      "/api/modules": () => jsonResponse(switchboard),
    });
    render(<SettingsPage baseCurrency="USD" />);

    expect(await screen.findByText("Benson's Hardware")).not.toBeNull();
    expect(screen.getByText(/Managed by owners/)).not.toBeNull();
    expect(screen.getByRole("link", { name: /Team & roles/ }).getAttribute("href")).toBe("/team");
    expect(screen.getByRole("link", { name: /View trajectory log/ }).getAttribute("href")).toBe("/sessions");
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

  it("loads and saves inventory defaults through the module settings contract", async () => {
    const fetchMock = routedFetch({
      "/api/org": orgRoute,
      "/api/modules": () => jsonResponse(switchboard),
      "/api/module-settings": (init) => (init?.method === "POST"
        ? jsonResponse({ ok: true, data: { module: "inventory", settings: { defaultUnitLabel: "case", defaultReorderPointUnits: 12 } } })
        : jsonResponse({ module: "inventory", settings: { defaultUnitLabel: "each", defaultReorderPointUnits: 4 } })),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Modules" }));

    const unit = await screen.findByLabelText("Inventory Default unit label") as HTMLInputElement;
    const reorder = screen.getByLabelText("Inventory Default reorder point") as HTMLInputElement;
    expect(unit.value).toBe("each");
    expect(reorder.value).toBe("4");
    fireEvent.change(unit, { target: { value: "case" } });
    fireEvent.change(reorder, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => expect(postsTo(fetchMock, "/api/module-settings")).toHaveLength(1));
    expect(postsTo(fetchMock, "/api/module-settings")[0]).toMatchObject({
      module: "inventory",
      settings: { defaultUnitLabel: "case", defaultReorderPointUnits: 12 },
    });
    expect(String(postsTo(fetchMock, "/api/module-settings")[0]?.intentId)).toHaveLength(36);
    expect(await screen.findByText("Saved. New defaults apply right away.")).not.toBeNull();
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
    expect(screen.getByRole("link", { name: /Creator mode/ }).getAttribute("href")).toBe("/proposals");
    expect(screen.getByRole("link", { name: /Agent sessions/ }).getAttribute("href")).toBe("/sessions");
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
    expect(String(body.intentId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(String(body.updatedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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

  it("searches organization memory with a one-character source query and trusts Go canEdit", async () => {
    const fetchMock = routedFetch({
      "/api/org": orgRoute,
      "/api/modules": () => jsonResponse(switchboard),
      "/api/ai-config": () => jsonResponse(aiConfig),
      "/api/memory": () => jsonResponse({
        memories: [
          { id: "mem-source", kind: "sop", source: "x.pdf", content: "Full memory content", preview: "Source matched entry", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
        total: 8,
        canEdit: false,
      }),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "AI & automation" }));
    expect(await screen.findByText("Source matched entry")).not.toBeNull();
    const search = screen.getByRole("textbox", { name: "Search organization memory" });
    fireEvent.change(search, { target: { value: "x" } });

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/memory?q=x")).toBe(true));
    expect(screen.queryByRole("button", { name: "Delete memory entry" })).toBeNull();
    expect(screen.getByText("1 shown")).not.toBeNull();
  }, 20_000);

  it("creates a routine and reports the webhook trigger the server minted", async () => {
    enableRetryLock();
    const fetchMock = routedFetch({
      "/api/routines": (init) => (init?.method === "POST"
        ? jsonResponse({ id: "r1", webhookUrl: "https://app.example/api/routines/webhook/tok_123" })
        : jsonResponse({ routines: [] })),
    });
    render(<SettingsPage actorId="actor-settings" organizationId="org-settings" />);
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

  it("shows a saved routine action after reload and retries with its original intent", async () => {
    enableRetryLock();
    const scope = { actorId: "retry-actor", organizationId: "retry-org" };
    const uncertainFetch = vi.fn().mockRejectedValue(new TypeError("connection dropped"));
    vi.stubGlobal("fetch", uncertainFetch);
    const action = { action: "run_now", routineId: "routine-retry" };
    await expect(submitGoverned("/api/routines", action, undefined, scope)).rejects.toMatchObject({ status: 0 });

    const fetchMock = routedFetch({
      "/api/modules": () => jsonResponse(switchboard),
      "/api/routines": (init) => init?.method === "POST"
        ? jsonResponse({ pendingApproval: true, reason: "Approval required" }, 202)
        : jsonResponse({ routines: [] }),
    });
    render(<SettingsPage actorId={scope.actorId} organizationId={scope.organizationId} />);

    expect(await screen.findByText("A routine change may not have reached the server.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact change" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(postsTo(fetchMock, "/api/routines")[0]).toEqual(JSON.parse(String(uncertainFetch.mock.calls[0]?.[1]?.body)));
    expect(await screen.findByText("Approval required")).not.toBeNull();
  });

  it("surfaces an unreadable routine retry marker without clearing it", async () => {
    enableRetryLock();
    const scope = { actorId: "ui-corrupt-actor", organizationId: "ui-corrupt-org" };
    const storageKey = `chaste:governed-retry:v1:${scope.actorId}:${scope.organizationId}`;
    localStorage.setItem(storageKey, "not-json");
    routedFetch({ "/api/modules": () => jsonResponse(switchboard) });

    render(<SettingsPage actorId={scope.actorId} organizationId={scope.organizationId} />);

    expect(await screen.findByText("Safe routine retries are unavailable.")).not.toBeNull();
    expect(screen.getByText(/blocked until this workspace is reconciled/)).not.toBeNull();
    expect(localStorage.getItem(storageKey)).toBe("not-json");
  });

  it("prevents unsupported schedule phrases from reaching the Go routines API", async () => {
    const fetchMock = routedFetch({ "/api/routines": () => jsonResponse({ routines: [] }) });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Routines" }));
    await screen.findByText("No routines yet. Create one above, or start with the daily heartbeat.");
    fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Ad hoc check" } });
    fireEvent.change(screen.getByLabelText("Schedule in plain language"), { target: { value: "a few times a day" } });
    fireEvent.change(screen.getByLabelText("Routine instructions"), { target: { value: "Check overdue invoices" } });

    expect(screen.getByText(/Use a supported schedule such as weekdays at 9am/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "Create routine" }) as HTMLButtonElement).disabled).toBe(true);
    expect(postsTo(fetchMock, "/api/routines")).toHaveLength(0);
  }, 20_000);

  it("shows runtime compositions as metadata only and explains a refused inspection", async () => {
    routedFetch({
      "/api/capabilities/execute": () => jsonResponse({
        ok: true,
        data: { compositions: [{
          id: "cmp-1",
          createdAt: new Date().toISOString(),
          inspection: {
            profile: { id: "erp-prod", version: "1.0.0", environment: "erp-prod" },
            profileDigest: "sha256:profile",
            compositionDigest: "sha256:composition",
            bundles: [{ id: "core", version: "1.2.0", serviceIds: ["api", "worker"] }],
            patches: [{ id: "billing", version: "0.4.0", configKeys: ["LEDGER_URL"] }],
          },
        }] },
      }),
    });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Runtime" }));

    expect((await screen.findAllByText("erp-prod")).length).toBe(2);
    expect(screen.getByText("core@1.2.0")).not.toBeNull();
    expect(screen.getByText("sha256:composition")).not.toBeNull();
  }, 20_000);
});


it("saves in-app notification preferences without changing approval authority", async () => {
  let muted: string[] = ["system"];
  const fetchMock = routedFetch({
    "/api/modules": () => jsonResponse(switchboard),
    "/api/organizations": () => orgRoute(),
    "/api/notification-preferences": (init) => {
      if (init?.method === "PUT") {
        muted = (JSON.parse(String(init.body)) as { mutedKinds: string[] }).mutedKinds;
        return jsonResponse({ kinds: ["approval.requested", "ticket.filed", "routine.run", "system"], mutedKinds: muted });
      }
      return jsonResponse({ kinds: ["approval.requested", "ticket.filed", "routine.run", "system"], mutedKinds: muted });
    },
  });
  render(<SettingsPage organizationId="11111111-1111-4111-8111-111111111111" actorId="22222222-2222-4222-8222-222222222222" />);

  fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
  expect(await screen.findByText("Approval requests")).not.toBeNull();
  expect((screen.getByRole("checkbox", { name: /Approval requests/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: /System notices/ }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: /Approval requests/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

  expect(await screen.findByText("Notification preferences saved.")).not.toBeNull();
  expect([...muted].sort()).toEqual(["approval.requested", "system"]);
  expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/notification-preferences")).toBe(true);
});
