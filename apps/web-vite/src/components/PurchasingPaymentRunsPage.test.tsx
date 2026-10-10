import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitPurchasingPaymentRunAction } from "../api/purchasing-payment-runs";
import { PurchasingPaymentRunsPage } from "./PurchasingPaymentRunsPage";

const actorId = "44444444-4444-4444-8444-444444444444";
const organizationId = "55555555-5555-4555-8555-555555555555";
const bill = {
  id: "33333333-3333-4333-8333-333333333333",
  number: 17,
  vendorName: "Harbor Supplies",
  vendorRef: "HS-17",
  currency: "BHD",
  dueMinor: 1234,
};
const run = {
  id: "11111111-1111-4111-8111-111111111111",
  reference: "PR-2026-0042",
  currency: "BHD",
  totalMinor: 1234,
  status: "draft",
  createdAt: "2026-09-29T08:15:00.000Z",
  instructedAt: null,
  confirmedAt: null,
  entryId: null,
  lines: [{ billId: bill.id, billNumber: bill.number, vendorName: bill.vendorName, vendorRef: bill.vendorRef, amountMinor: 1234 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function reads(capabilityId: string) {
  return capabilityId === "purchasing.listPaymentRuns"
    ? { ok: true, data: { runs: [] } }
    : { ok: true, data: { bills: [bill] } };
}

function stubPaymentRunLocks(): void {
  const tails = new Map<string, Promise<void>>();
  const locks = {
    request: async <T,>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release = (): void => {};
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(name, current);
      await previous;
      try { return await callback(); }
      finally {
        release();
        if (tails.get(name) === current) tails.delete(name);
      }
    },
  };
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { locks }));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

beforeEach(stubPaymentRunLocks);

describe("Purchasing payment runs page", () => {
  it("loads Go data and creates a draft without using compatibility routes", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    let runCreated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/capabilities/execute");
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown> };
      if (body.capabilityId === "purchasing.createPaymentRun") {
        expect(body.input).toEqual({ lines: [{ billId: bill.id, amountMinor: 1234 }] });
        runCreated = true;
        return jsonResponse({ ok: true, data: { paymentRunId: run.id, reference: run.reference, currency: run.currency, totalMinor: run.totalMinor, billCount: 1 } });
      }
      return jsonResponse(body.capabilityId === "purchasing.listPaymentRuns" && runCreated
        ? { ok: true, data: { runs: [run] } }
        : reads(body.capabilityId));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PurchasingPaymentRunsPage actorId={actorId} organizationId={organizationId} />);
    expect(await screen.findByRole("heading", { name: "Supplier payment runs" })).not.toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bill 17 from Harbor Supplies" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save payment draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save payment draft" }));

    expect(await screen.findByText("Payment draft completed.")).not.toBeNull();
    expect(await screen.findByText("PR-2026-0042")).not.toBeNull();
    expect(fetchMock.mock.calls.every(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });

  it("freezes bill edits while approval is pending and retries the exact action after reload", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const intents: string[] = [];
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; input: Record<string, unknown>; intentId: string };
      if (body.capabilityId !== "purchasing.createPaymentRun") return jsonResponse(reads(body.capabilityId));
      intents.push(body.intentId);
      writes += 1;
      return writes === 1
        ? jsonResponse({ pendingApproval: true, reason: "Finance approval required." }, 202)
        : jsonResponse({ ok: true, data: { paymentRunId: run.id, reference: run.reference, currency: run.currency, totalMinor: run.totalMinor, billCount: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = render(<PurchasingPaymentRunsPage actorId={actorId} organizationId={organizationId} />);
    await screen.findByText("Harbor Supplies");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bill 17 from Harbor Supplies" }));
    fireEvent.change(screen.getByLabelText("Run memo (optional)"), { target: { value: "September payables" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save payment draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save payment draft" }));

    const retry = await screen.findByRole("button", { name: "Retry exact payment run action" });
    expect((screen.getByRole("checkbox", { name: "Select bill 17 from Harbor Supplies" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Run memo (optional)") as HTMLInputElement).disabled).toBe(true);
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    first.unmount();

    render(<PurchasingPaymentRunsPage actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact payment run action" }));
    expect(await screen.findByText("Payment run action completed.")).not.toBeNull();
    await waitFor(() => expect(intents).toHaveLength(2));
    expect(intents[1]).toBe(intents[0]);
    const createCalls = fetchMock.mock.calls.filter(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { capabilityId: string };
      return body.capabilityId === "purchasing.createPaymentRun";
    });
    expect(createCalls).toHaveLength(2);
    expect(createCalls.every(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });

  it("keeps an unresolved retry available when Go reads fail after reload", async () => {
    vi.stubGlobal("__GO_PURCHASING_PAYMENT_RUNS__", true);
    const action = { action: "create" as const, memo: "September payables", lines: [{ billId: bill.id, amountMinor: 1000 }] };
    const intents: string[] = [];
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/capabilities/execute");
      const body = JSON.parse(String(init?.body)) as { capabilityId: string; intentId: string };
      if (body.capabilityId === "purchasing.createPaymentRun") {
        intents.push(body.intentId);
        writes += 1;
        return writes === 1
          ? jsonResponse({ pendingApproval: true, reason: "Finance approval required." }, 202)
          : jsonResponse({ ok: true, data: { paymentRunId: run.id, reference: run.reference, currency: run.currency, totalMinor: 1000, billCount: 1 } });
      }
      return jsonResponse({ error: "Go read service unavailable" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPurchasingPaymentRunAction(action, { actorId, organizationId })).resolves.toMatchObject({ kind: "pending" });
    render(<PurchasingPaymentRunsPage actorId={actorId} organizationId={organizationId} />);

    expect(await screen.findByRole("heading", { name: "Could not load payment runs" })).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact payment run action" }));
    expect(await screen.findByText("Payment run action completed.")).not.toBeNull();
    expect(intents).toHaveLength(2);
    expect(intents[1]).toBe(intents[0]);
    expect(fetchMock.mock.calls.every(([path]) => path === "/api/capabilities/execute")).toBe(true);
  });
});
