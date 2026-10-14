import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubWebLocks } from "../test/web-locks";
import {
  completeOnboardingSetup,
  createWorkspace,
  failureOf,
  importOnboardingRows,
  markOnboardingStep,
  OnboardingApiError,
  readOnboardingState,
  recoveryFor,
  undoOnboardingImport,
} from "./onboarding";

const stateBody = { state: { path: "import", steps: { import_customers: "skipped" }, startedAt: "2026-01-01T00:00:00.000Z" } };
const workspace = {
  orgName: "Glow Works",
  businessDescription: "We design and sell handmade lighting fixtures online and to interior designers.",
  baseCurrency: "USD",
path: "import" as const,
  deferredSteps: ["import_customers", "import_products"],
  intentId: "11111111-2222-4333-8444-555555555555",
};

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  fetchMock.mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(stubWebLocks);
afterEach(() => vi.unstubAllGlobals());

describe("onboarding API", () => {
  it("reads and validates resumable setup state from Go", async () => {
    const state = { path: "import", steps: { import_products: "pending" }, startedAt: "2026-01-01T00:00:00.000Z" };
    const fetchMock = stubFetch(Response.json({ state, steps: [{ key: "import_products", status: "pending" }] }));
    await expect(readOnboardingState()).resolves.toEqual(state);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/onboarding");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("accepts a null state for a user without a workspace and rejects malformed state", async () => {
    stubFetch(Response.json({ state: null, steps: [] }));
    await expect(readOnboardingState()).resolves.toBeNull();

    stubFetch(Response.json({ state: { path: "unknown", steps: {}, startedAt: "now" }, steps: [] }));
    await expect(readOnboardingState()).rejects.toMatchObject({ status: 200, failure: { code: "invalid_response" } });
  });

  it("creates the workspace with the caller's bootstrap intent and validates the reply", async () => {
    const fetchMock = stubFetch(Response.json({ orgId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30", replayed: true }));
    await expect(createWorkspace(workspace)).resolves.toEqual({
      orgId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30",
      replayed: true,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/onboarding");
    expect(JSON.parse(String(init?.body))).toEqual(workspace);
  });

  it("refuses to send a profile the server would reject anyway", async () => {
    const fetchMock = stubFetch();
    await expect(createWorkspace({ ...workspace, businessDescription: "too short" })).rejects.toBeInstanceOf(OnboardingApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a 202 create as waiting for approval, never as a created workspace", async () => {
    stubFetch(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }));
    const error = await createWorkspace(workspace).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(OnboardingApiError);
    const failure = failureOf(error);
    expect(failure.code).toBe("pending_approval");
    expect(failure.hint).toContain("Owner review");
    expect(recoveryFor(failure.code)).toBe("none");
  });

  it("explains a failed create and keeps the way out out of the raw payload", async () => {
    stubFetch(Response.json({ error: '{"sql":"select 1"}', code: "server_error" }, { status: 500 }));
    const failure = failureOf(await createWorkspace(workspace).catch((thrown: unknown) => thrown));
    expect(failure.title).toBe("That didn't work");
    expect(failure.hint).toBe("Nothing was changed. Try again in a moment.");
    expect(failure.detail).toContain("/api/onboarding");
  });

  it("maps known codes to their own copy and passes on the rate limit countdown", async () => {
    stubFetch(Response.json({ error: "Your session has expired. Sign in again to continue.", code: "unauthorized" }, { status: 401 }));
    const session = failureOf(await createWorkspace(workspace).catch((thrown: unknown) => thrown));
    expect(session.code).toBe("unauthorized");
    expect(session.title).toBe("Your session ended");
    expect(recoveryFor(session.code)).toBe("signin");

    stubFetch(Response.json({ error: "Try again in 30 seconds.", code: "rate_limited", retryAfterSec: 30 }, { status: 429 }));
    const limited = failureOf(await createWorkspace(workspace).catch((thrown: unknown) => thrown));
    expect(limited.title).toBe("Too many attempts");
    expect(limited.hint).toBe("Try again in 30 seconds.");
    expect(limited.retryAfterSec).toBe(30);

    stubFetch(Response.json({ error: "This account already has a workspace.", code: "already_onboarded" }, { status: 409 }));
    const onboarded = failureOf(await createWorkspace(workspace).catch((thrown: unknown) => thrown));
    expect(recoveryFor(onboarded.code)).toBe("dashboard");
  });

  it("records a step as done, skipped or pending and seals the setup when finishing", async () => {
    const fetchMock = stubFetch(Response.json(stateBody), Response.json(stateBody));
    await markOnboardingStep("import_customers", "skipped");
    await completeOnboardingSetup();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/onboarding");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ step: "import_customers", status: "skipped" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ complete: true });
  });

  it("sends product imports through Go with source rows, minor units, duplicate IDs, and no legacy fallback", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return Response.json({ ok: true, data: { createdIds: ["10000000-0000-4000-8000-000000000001"], imported: 1, skippedDuplicateRows: [4] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const imported = await importOnboardingRows("products", {
      rows: [{ name: "Glow Lamp", sku: "GLOW-1", salePrice: "24.99", salePriceMinor: "2499", type: "product" }, { name: "Duplicate Lamp", sku: "GLOW-1", salePrice: "9", salePriceMinor: "900", type: "product" }],
      rowNumbers: [3, 4], currency: "USD", scope: { actorId: "owner-user", organizationId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30" },
      errors: [{ row: 2, field: "name", message: "Needs a name." }],
    });
    expect(imported).toMatchObject({ inserted: 1, skippedDuplicates: 1, errors: [{ row: 2 }, { row: 4, message: expect.stringContaining("product") }], createdIds: ["10000000-0000-4000-8000-000000000001"] });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/capabilities/execute");
    expect(JSON.parse(String(init?.body))).toMatchObject({ capabilityId: "inventory.importItems", input: { rows: [{ rowNumber: 3, salePriceMinor: 2499 }, { rowNumber: 4, salePriceMinor: 900 }] } });
    expect(fetchMock.mock.calls.some(([callUrl]) => callUrl === "/api/import")).toBe(false);
  });

  it("sends customer credit in currency minor units and retains the Go receipt for undo", async () => {
    const customerId = "10000000-0000-4000-8000-000000000002";
    let importIntentId = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string; input?: { rows?: unknown[]; customerIds?: string[]; importIntentId?: string } };
      if (body.capabilityId === "crm.importCustomers") {
        importIntentId = body.intentId;
        return Response.json({ ok: true, data: { createdIds: [customerId], imported: 1, skippedDuplicateRows: [4], importIntentId } });
      }
      return Response.json({ ok: true, data: { customerIds: [customerId], deactivated: 1, importIntentId, undoIntentId: body.intentId } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scope = { actorId: "owner-user", organizationId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30" };
    const imported = await importOnboardingRows("customers", {
      rows: [{ name: "Glow Works", email: "owner@example.com", creditLimitMinor: "500000", paymentTermDays: "30" }, { name: "Duplicate" }],
      rowNumbers: [3, 4], currency: "UGX", scope,
    });
    expect(imported).toMatchObject({ inserted: 1, skippedDuplicates: 1, errors: [{ row: 4 }], createdIds: [customerId] });
    expect(imported.importIntentId).toBeTruthy();
    const importBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(importBody).toMatchObject({ capabilityId: "crm.importCustomers", input: { rows: [{ rowNumber: 3, creditLimitMinor: 500000, paymentTermDays: 30 }, { rowNumber: 4, name: "Duplicate" }] } });
    await expect(undoOnboardingImport("customers", [customerId], scope, imported.importIntentId)).resolves.toEqual({ undone: 1, remaining: 0 });
    const undoBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(undoBody).toMatchObject({ capabilityId: "crm.undoCustomerImport", input: { customerIds: [customerId], importIntentId } });
    expect(undoBody.input.importIntentId).toBe(importBody.intentId);
    expect(fetchMock.mock.calls.some(([callUrl]) => callUrl === "/api/import")).toBe(false);
  });

  it("rejects non-minor-unit customer amounts and safely preflights large batches", async () => {
    const fetchMock = stubFetch();
    const scope = { actorId: "owner-user", organizationId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30" };
    await expect(importOnboardingRows("customers", {
      rows: [{ name: "Invalid", creditLimitMinor: "1.2345" }], rowNumbers: [2], currency: "KWD", scope,
    })).rejects.toBeInstanceOf(OnboardingApiError);
    await expect(importOnboardingRows("customers", {
      rows: Array.from({ length: 1000 }, (_, index) => ({ name: "A".repeat(120), email: `person${index}@example.com` })),
      rowNumbers: Array.from({ length: 1000 }, (_, index) => index + 2), currency: "USD", scope,
    })).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps approval-pending imports and undo out of the success path without legacy fallback", async () => {
    const fetchMock = stubFetch(
      Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }),
      Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }),
    );
    const scope = { actorId: "owner-user", organizationId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30" };
    const request = { rows: [{ name: "Mug", sku: "MUG-1", salePrice: "1", salePriceMinor: "100" }], rowNumbers: [2], currency: "USD", scope };
    expect(failureOf(await importOnboardingRows("products", request).catch((thrown: unknown) => thrown)).code).toBe("pending_approval");
    expect(failureOf(await undoOnboardingImport("products", ["10000000-0000-4000-8000-000000000001"], { actorId: "another-user", organizationId: scope.organizationId }).catch((thrown: unknown) => thrown)).code).toBe("pending_approval");
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/capabilities/execute")).toBe(true);
  });

  it("requires loaded organization scope and a valid capability result", async () => {
    const fetchMock = stubFetch();
    await expect(importOnboardingRows("products", { rows: [], rowNumbers: [], currency: "USD", scope: null })).rejects.toBeInstanceOf(OnboardingApiError);
    await expect(importOnboardingRows("products", {
      rows: [{ name: "Mug", sku: "MUG-1", salePrice: "1", salePriceMinor: "100" }], rowNumbers: [2], currency: "USD",
      scope: { actorId: "owner-user", organizationId: "3f1c9a52-0d2b-4c8f-9a51-5f2f7c2a1b30" },
    })).rejects.toBeInstanceOf(OnboardingApiError);
    expect(fetchMock.mock.calls.every(([url]) => url !== "/api/import")).toBe(true);
  });

  it("turns an unreachable or stalled service into copy the wizard can show", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const offline = failureOf(await createWorkspace(workspace).catch((thrown: unknown) => thrown));
    expect(offline.code).toBe("network");
    expect(offline.title).toBe("Can't reach the server");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Request timed out", "TimeoutError")));
    const stalled = failureOf(await createWorkspace(workspace).catch((thrown: unknown) => thrown));
    expect(stalled.code).toBe("timeout");
    expect(stalled.title).toBe("That took too long");
  });
});
