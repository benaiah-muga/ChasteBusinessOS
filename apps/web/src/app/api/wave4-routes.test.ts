import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  dispatchGoCapabilityRoute: vi.fn(),
  goCapabilityUnavailable: vi.fn(),
  executeGoCapability: vi.fn(),
  hasPermission: vi.fn(),
  missingPermission: vi.fn(),
  checkRateLimit: vi.fn(),
  setOnboardingStep: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), asc: vi.fn(), eq: vi.fn(), inArray: vi.fn() }));
vi.mock("@chaste/db", () => ({ accounts: {}, getDb: mocks.getDb }));
vi.mock("@chaste/kernel", () => ({ hasPermission: mocks.hasPermission }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/route-guards", () => ({ missingPermission: mocks.missingPermission }));
vi.mock("@/server/go-route-response", () => ({ dispatchGoCapabilityRoute: mocks.dispatchGoCapabilityRoute, goCapabilityUnavailable: mocks.goCapabilityUnavailable }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));
vi.mock("@/server/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/server/onboarding", () => ({ setOnboardingStep: mocks.setOnboardingStep }));

import { POST as budgetsPost } from "./accounting/budgets/route";
import { GET as closeGet, POST as closePost } from "./accounting/close/route";
import { POST as importPost } from "./import/route";
import { POST as inventoryPost } from "./inventory/route";
import { GET as paymentRunsGet, POST as paymentRunsPost } from "./purchasing/payment-runs/route";

const user = { userId: "11111111-1111-4111-8111-111111111111", orgId: "22222222-2222-4222-8222-222222222222", authSessionId: "auth-session", permissions: new Set(["*"]) };
const ctx = { actor: { type: "human", id: user.userId, orgId: user.orgId, permissions: user.permissions }, intentId: "wave4-intent" };

function request(path: string, body: unknown, method = "POST") {
  return new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
}

describe("Wave 4 Go route bridges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of ["GO_ACCOUNTING_BUDGET_WRITES", "GO_ACCOUNTING_PERIOD_CLOSE_WRITES", "GO_INVENTORY_IMPORT_WRITES", "GO_INVENTORY_RESERVATION_WRITES", "GO_PURCHASING_PAYMENT_RUN_WRITES", "GO_PURCHASING_PAYMENT_RUN_READS"]) vi.stubEnv(name, "0");
    mocks.getResolvedUser.mockResolvedValue(user);
    mocks.actorFromResolved.mockReturnValue(ctx);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { legacy: true } });
    mocks.dispatchGoCapabilityRoute.mockResolvedValue(Response.json({ ok: true, data: { go: true } }));
    mocks.goCapabilityUnavailable.mockImplementation((message: string) => Response.json({ error: message }, { status: 503 }));
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data: { createdIds: [], imported: 0, skippedDuplicateRows: [] } }) });
    mocks.hasPermission.mockReturnValue(true);
    mocks.missingPermission.mockReturnValue(null);
    mocks.checkRateLimit.mockReturnValue({ allowed: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("dispatches budget saves and period-close actions through signed Go only when enabled", async () => {
    vi.stubEnv("GO_ACCOUNTING_BUDGET_WRITES", "1");
    const budget = { action: "save", intentId: "budget-save", scenarioKey: "annual-plan", name: "Annual plan", fiscalYear: 2026, currency: "USD", lines: [{ month: 1, accountCode: "4000", plannedMinor: 100 }] };
    await budgetsPost(request("/api/accounting/budgets", budget));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ actionContext: ctx, session: user, capabilityId: "accounting.saveBudgetScenario" }), expect.stringContaining("check budget status"));
    expect(mocks.execute).not.toHaveBeenCalled();

    vi.stubEnv("GO_ACCOUNTING_PERIOD_CLOSE_WRITES", "1");
    await closePost(request("/api/accounting/close", { action: "close", year: 2025, month: 12, intentId: "close-period" }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "accounting.closePeriod", input: { year: 2025, month: 12 } }), expect.stringContaining("period close status"));
    await closeGet(new Request("http://localhost/api/accounting/close?year=2025&month=12"));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "accounting.periodCloseWorkbench", input: { year: 2025, month: 12 } }), expect.stringContaining("period close status"));
  });

  it("bridges the remaining public Wave 4 lifecycle actions with normalized inputs", async () => {
    vi.stubEnv("GO_ACCOUNTING_BUDGET_WRITES", "1");
    await budgetsPost(request("/api/accounting/budgets", { action: "undo", scenarioId: "33333333-3333-4333-8333-333333333333", previousScenarioId: null }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "accounting.undoBudgetScenarioVersion", input: { scenarioId: "33333333-3333-4333-8333-333333333333", previousScenarioId: null } }), expect.any(String));

    vi.stubEnv("GO_ACCOUNTING_PERIOD_CLOSE_WRITES", "1");
    await closePost(request("/api/accounting/close", { action: "checklist", year: 2025, month: 12, taskKey: "review_tax", completed: true, note: "Reviewed" }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "accounting.updatePeriodCloseCheck", input: { year: 2025, month: 12, taskKey: "review_tax", completed: true, note: "Reviewed" } }), expect.any(String));
    await closePost(request("/api/accounting/close", { action: "reopen", year: 2025, month: 12 }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "accounting.reopenPeriod", input: { year: 2025, month: 12 } }), expect.any(String));

    vi.stubEnv("GO_PURCHASING_PAYMENT_RUN_WRITES", "1");
    await paymentRunsPost(request("/api/purchasing/payment-runs", { action: "create", lines: [{ billId: "44444444-4444-4444-8444-444444444444", amountMinor: 2500 }] }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "purchasing.createPaymentRun", input: { memo: undefined, lines: [{ billId: "44444444-4444-4444-8444-444444444444", amountMinor: 2500 }] } }), expect.any(String));
    await paymentRunsPost(request("/api/purchasing/payment-runs", { action: "instruct", paymentRunId: "55555555-5555-4555-8555-555555555555" }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "purchasing.instructPaymentRun", input: { paymentRunId: "55555555-5555-4555-8555-555555555555" } }), expect.any(String));
    await paymentRunsPost(request("/api/purchasing/payment-runs", { action: "reverse", paymentRunId: "66666666-6666-4666-8666-666666666666", reason: "bank instruction error" }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "purchasing.reversePaymentRun", input: { paymentRunId: "66666666-6666-4666-8666-666666666666", reason: "bank instruction error" } }), expect.any(String));

    vi.stubEnv("GO_INVENTORY_RESERVATION_WRITES", "1");
    await inventoryPost(request("/api/inventory", { action: "releaseReservation", reservationId: "77777777-7777-4777-8777-777777777777" }));
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "inventory.releaseReservation", input: { reservationId: "77777777-7777-4777-8777-777777777777" } }));
  });

  it("dispatches supplier payment runs and inventory reservations through Go behind default-off flags", async () => {
    vi.stubEnv("GO_PURCHASING_PAYMENT_RUN_WRITES", "1");
    await paymentRunsPost(request("/api/purchasing/payment-runs", { action: "cancel", paymentRunId: "33333333-3333-4333-8333-333333333333" }));
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "purchasing.cancelPaymentRunDraft" }), expect.stringContaining("payment run status"));
    await paymentRunsGet();
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "purchasing.listPaymentRuns" }), expect.stringContaining("payment run status"));

    vi.stubEnv("GO_INVENTORY_RESERVATION_WRITES", "1");
    await inventoryPost(request("/api/inventory", { action: "reserveStock", sku: "MUG-1", quantityThousandths: 1000, reason: "order allocation" }));
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "inventory.reserveStock", input: { sku: "MUG-1", quantityThousandths: 1000, reason: "order allocation" } }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("opts payment-run reads into Go independently and fails closed on malformed run data", async () => {
    const legacyResponse = await paymentRunsGet();
    expect(await legacyResponse.json()).toEqual({ ok: true, data: { legacy: true } });
    expect(mocks.dispatchGoCapabilityRoute).not.toHaveBeenCalled();
    mocks.execute.mockClear();

    vi.stubEnv("GO_PURCHASING_PAYMENT_RUN_READS", "1");
    const run = {
      id: "33333333-3333-4333-8333-333333333333",
      reference: "PR-001",
      currency: "USD",
      totalMinor: 1250,
      status: "draft",
      createdAt: "2026-09-29T09:00:00.000Z",
      instructedAt: null,
      confirmedAt: null,
      entryId: null,
      lines: [{ billId: "44444444-4444-4444-8444-444444444444", billNumber: 7, vendorName: "Acme Supplies", vendorRef: "INV-7", amountMinor: 1250 }],
    };
    mocks.dispatchGoCapabilityRoute.mockResolvedValueOnce(Response.json({ ok: true, data: { runs: [run] } }));
    const goResponse = await paymentRunsGet();
    expect(goResponse.status).toBe(200);
    expect(await goResponse.json()).toEqual({ ok: true, data: { runs: [run] } });
    expect(mocks.dispatchGoCapabilityRoute).toHaveBeenCalledWith(expect.objectContaining({ actionContext: ctx, session: user, capabilityId: "purchasing.listPaymentRuns", input: {} }), expect.stringContaining("payment run status"));
    expect(mocks.execute).not.toHaveBeenCalled();

    const malformedRuns = [
      { ...run, totalMinor: 1250.5 },
      { ...run, totalMinor: Number.MAX_SAFE_INTEGER + 1 },
      { ...run, lines: [{ ...run.lines[0], billNumber: 7.5 }] },
      { ...run, lines: [{ ...run.lines[0], amountMinor: 1250.5 }] },
      { ...run, lines: [{ ...run.lines[0], amountMinor: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...run, lines: [{ ...run.lines[0], amountMinor: "1250" }] },
    ];
    for (const malformedRun of malformedRuns) {
      mocks.dispatchGoCapabilityRoute.mockResolvedValueOnce(Response.json({ ok: true, data: { runs: [malformedRun] } }));
      const malformedResponse = await paymentRunsGet();
      expect(malformedResponse.status).toBe(503);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps product import response shape and refuses TypeScript fallback after uncertain Go writes", async () => {
    vi.stubEnv("GO_INVENTORY_IMPORT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: true, data: { createdIds: ["33333333-3333-4333-8333-333333333333"], imported: 1, skippedDuplicateRows: [3] } }) });
    const response = await importPost(request("/api/import", { entity: "products", rows: [{ name: "Mug", sku: "MUG-1", salePriceMinor: 100 }] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: 1, skippedDuplicates: 1, skippedDuplicateRows: [3], createdIds: ["33333333-3333-4333-8333-333333333333"] });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "inventory.importItems" }));
    expect(mocks.execute).not.toHaveBeenCalled();

    mocks.executeGoCapability.mockResolvedValueOnce({ kind: "outcome-unknown" });
    const failed = await importPost(request("/api/import", { entity: "products", rows: [{ name: "Cup", sku: "CUP-1", salePriceMinor: 100 }] }));
    expect(failed.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("bridges product-import undo while customers remain on their current action path", async () => {
    vi.stubEnv("GO_INVENTORY_IMPORT_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: true, data: { archived: 1 } }) });
    const response = await importPost(request("/api/import", { entity: "products", action: "undo", importIds: ["88888888-8888-4888-8888-888888888888"] }));
    expect(await response.json()).toEqual({ undone: 1, remaining: 0 });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: "inventory.undoItemImport", input: { itemIds: ["88888888-8888-4888-8888-888888888888"] } }));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("retains legacy route behavior when each Wave 4 Go flag is off", async () => {
    await budgetsPost(request("/api/accounting/budgets", { action: "save" }));
    await closePost(request("/api/accounting/close", { action: "close", year: 2025, month: 12 }));
    await paymentRunsPost(request("/api/purchasing/payment-runs", { action: "cancel", paymentRunId: "33333333-3333-4333-8333-333333333333" }));
    expect(mocks.dispatchGoCapabilityRoute).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalled();
  });
});
