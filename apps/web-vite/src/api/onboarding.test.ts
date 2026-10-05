import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeOnboardingSetup,
  createWorkspace,
  failureOf,
  importOnboardingRows,
  markOnboardingStep,
  OnboardingApiError,
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

afterEach(() => vi.unstubAllGlobals());

describe("onboarding API", () => {
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

  it("refuses a malformed import payload before it reaches the server", async () => {
    const fetchMock = stubFetch();
    await expect(importOnboardingRows("customers", [])).rejects.toBeInstanceOf(OnboardingApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports rows with an intent identity and reports duplicates, row errors and undo handles", async () => {
    const createdIds = ["10000000-0000-4000-8000-000000000001"];
    const fetchMock = stubFetch(
      Response.json({ inserted: 2, skippedDuplicates: 1, errors: [{ row: 4, field: "email", message: "not an email" }], createdIds }),
      Response.json({ undone: 2, remaining: 0 }),
    );
    const imported = await importOnboardingRows("customers", [{ name: "Glow Works" }, { name: "Pantry Co" }], "fixed-intent");
    expect(imported).toMatchObject({ inserted: 2, skippedDuplicates: 1, errors: [{ row: 4 }] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      entity: "customers",
      rows: [{ name: "Glow Works" }, { name: "Pantry Co" }],
      intentId: "fixed-intent",
    });
    await expect(undoOnboardingImport("customers", createdIds)).resolves.toEqual({ undone: 2, remaining: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ action: "undo", importIds: createdIds });
  });

  it("keeps an approval-pending import and an approval-pending undo out of the success path", async () => {
    stubFetch(Response.json({ error: "Import is awaiting approval.", pendingApproval: true }, { status: 202 }));
    const failure = failureOf(await importOnboardingRows("products", [{ name: "Mug" }]).catch((thrown: unknown) => thrown));
    expect(failure.code).toBe("pending_approval");
    expect(failure.hint).toContain("awaiting approval");

    stubFetch(Response.json({ error: "Undo is awaiting approval.", pendingApproval: true }, { status: 202 }));
    const undo = failureOf(
      await undoOnboardingImport("products", ["10000000-0000-4000-8000-000000000001"]).catch((thrown: unknown) => thrown),
    );
    expect(undo.code).toBe("pending_approval");
  });

  it("rejects a success reply it cannot trust", async () => {
    stubFetch(Response.json({ inserted: 1, skippedDuplicates: 0 }));
    await expect(importOnboardingRows("products", [{ name: "Mug" }])).rejects.toBeInstanceOf(OnboardingApiError);

    stubFetch(Response.json({ state: "done" }));
    await expect(markOnboardingStep("invite_team", "done")).rejects.toBeInstanceOf(OnboardingApiError);
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