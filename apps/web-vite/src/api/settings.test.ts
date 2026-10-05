import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAiConfig,
  fetchCompositions,
  fetchModuleSettings,
  fetchModuleSwitchboard,
  fetchPolicy,
  isProtectedModule,
  PROTECTED_MODULE_IDS,
  saveAiConfig,
  sendEmailTest,
  SettingsApiError,
  submitGoverned,
} from "./settings";

const switchboard = {
  catalog: [
    { id: "crm", label: "CRM", description: "Customers and deal pipeline", href: "/crm" },
    { id: "iam", label: "Identity & access", description: "Roles, permissions, module switchboard", href: "/team", protected: true },
  ],
  enabledModules: ["crm", "iam", "routines", "signals"],
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

type Call = [input: RequestInfo | URL, init?: RequestInit | undefined];

function postBodies(fetchMock: { mock: { calls: Call[] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Vite settings API", () => {
  it("reads the module switchboard over the authenticated same-origin session", async () => {
    const fetchMock = vi.fn(async () => Response.json(switchboard));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchModuleSwitchboard()).resolves.toEqual(switchboard);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("treats the platform spine as protected even when the flag is missing", () => {
    expect([...PROTECTED_MODULE_IDS]).toEqual(["iam", "routines", "signals"]);
    expect(isProtectedModule(switchboard.catalog[1]!)).toBe(true);
    expect(isProtectedModule({ id: "routines", label: "Routines", description: "", href: null })).toBe(true);
    expect(isProtectedModule(switchboard.catalog[0]!)).toBe(false);
  });

  it("rejects a switchboard payload with unexpected fields and maps refusals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...switchboard, surprise: true })));
    await expect(fetchModuleSwitchboard()).rejects.toMatchObject({
      name: "SettingsApiError",
      message: "The settings service returned data in an unexpected format.",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })));
    await expect(fetchModuleSwitchboard()).rejects.toMatchObject({
      status: 401,
      message: "Your session has ended. Sign in again to continue.",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden: missing permission: iam.admin" }, { status: 403 })));
    await expect(fetchModuleSwitchboard()).rejects.toMatchObject({
      status: 403,
      message: "You do not have permission to change this workspace setting.",
    });
  });

  it("sends an intent id with every governed write and keeps 202 pending", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, data: { module: "inventory" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitGoverned("/api/module-settings", { module: "inventory", settings: {} }))
      .resolves.toEqual({ kind: "completed", data: { ok: true, data: { module: "inventory" } } });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/module-settings");
    expect(init?.credentials).toBe("same-origin");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ module: "inventory", intentId: expect.any(String) });
    expect(String(body.intentId)).toHaveLength(36);
  });

  it("accepts the Go module switchboard success envelope", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: { enabledModules: ["iam", "crm", "routines", "signals"] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitGoverned("/api/modules", { modules: ["crm", "iam", "routines", "signals"] }))
      .resolves.toEqual({
        kind: "completed",
        data: { ok: true, data: { enabledModules: ["iam", "crm", "routines", "signals"] } },
      });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/modules");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      modules: ["crm", "iam", "routines", "signals"],
      intentId: expect.any(String),
    });
  });

  it("surfaces an approval-pending envelope as pending, not as an error or a success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { pendingApproval: true, hint: "Module changes proposed by the workmate wait for approval in the Approvals inbox." },
      { status: 202 },
    )));

    await expect(submitGoverned("/api/modules", { modules: ["crm"] }))
      .resolves.toEqual({
        kind: "pending",
        reason: "Module changes proposed by the workmate wait for approval in the Approvals inbox.",
      });
  });

  it("refuses a 202 body that is not a recognisable approval envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ queued: true }, { status: 202 })));
    await expect(submitGoverned("/api/policy", { maxRiskAutonomous: "write" })).rejects.toMatchObject({
      status: 202,
      message: "The settings service returned an unexpected approval response.",
    });
  });

  it("reports a governed refusal as an error with the server reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "identity approval required" }, { status: 422 })));
    await expect(submitGoverned("/api/modules", { modules: ["crm"] }))
      .rejects.toBeInstanceOf(SettingsApiError);
    await expect(submitGoverned("/api/modules", { modules: ["crm"] }))
      .rejects.toMatchObject({ status: 422, message: "identity approval required" });
  });

  it("validates the runtime inspection permission message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "requires harness.approve permission" }, { status: 403 })));
    await expect(fetchCompositions()).rejects.toMatchObject({
      message: "Runtime inspection needs the harness.approve permission.",
    });
  });

  it("narrows the policy approval list to the risk names the editor understands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      policy: { maxRiskAutonomous: "write", moneyThresholdMinor: 50_000, requiresApprovalFor: ["identity", 7, "money"] },
      canEdit: true,
    })));

    const policy = await fetchPolicy();
    expect(policy.policy.requiresApprovalFor).toEqual(["identity", "money"]);
    expect(policy.canEdit).toBe(true);
  });

  it("keeps only the short key hint from the model configuration contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(aiConfig)));
    await expect(fetchAiConfig()).resolves.toEqual(aiConfig);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...aiConfig, apiKey: "nvapi-secret-value" })));
    await expect(fetchAiConfig()).rejects.toMatchObject({
      message: "The settings service returned data in an unexpected format.",
    });
  });

  it("rejects an oversized key hint so a whole credential can never render", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...aiConfig, keyHint: "••••nvapi-this-is-a-real-key" })));
    await expect(fetchAiConfig()).rejects.toMatchObject({
      message: "The settings service returned data in an unexpected format.",
    });
  });

  it("saves model configuration without an intent id the route cannot honor", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, ...aiConfig, configured: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveAiConfig({ provider: "nvidia", baseUrl: aiConfig.baseUrl, models: aiConfig.models, apiKey: "  nvapi-typed  " });
    expect(result).toEqual({ kind: "completed", config: { ok: true, ...aiConfig, configured: true } });
    expect(postBodies(fetchMock)[0]).toEqual({
      provider: "nvidia",
      baseUrl: aiConfig.baseUrl,
      models: aiConfig.models,
      apiKey: "nvapi-typed",
    });
  });

  it("keeps an approval-gated credential change pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ pendingApproval: true, error: "secret approval required" }, { status: 202 })));
    await expect(saveAiConfig({ provider: "nvidia", baseUrl: "https://a.example/v1", models: aiConfig.models, clearApiKey: true }))
      .resolves.toEqual({ kind: "pending", reason: "secret approval required" });
  });

  it("rejects an invalid model configuration before touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveAiConfig({
      provider: "nvidia",
      baseUrl: "https://a.example/v1",
      models: { ...aiConfig.models, primary: "   " },
    })).rejects.toMatchObject({ message: "The model configuration contains invalid details." });
    await expect(saveAiConfig({ provider: "nvidia", baseUrl: "not-a-url", models: aiConfig.models })).rejects.toBeInstanceOf(SettingsApiError);
    await expect(saveAiConfig({ provider: "nvidia", baseUrl: "https://a.example/v1", models: aiConfig.models, apiKey: "   " })).rejects.toMatchObject({
      message: "The model configuration contains invalid details.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates module names and email recipients on the client", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchModuleSettings("Not A Module")).rejects.toMatchObject({ message: "That module name is not valid." });
    await expect(sendEmailTest("not-an-email")).rejects.toMatchObject({ message: "Enter a valid email address first." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed SMTP proof send instead of claiming success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sent: false, error: "SMTP_HOST is not set" }, { status: 422 })));
    await expect(sendEmailTest("ops@example.com")).rejects.toMatchObject({ status: 422, message: "SMTP_HOST is not set" });
  });
});
