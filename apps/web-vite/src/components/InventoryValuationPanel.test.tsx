import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryValuationPanel } from "./InventoryValuationPanel";

const scope = { actorId: "actor-inventory-value", organizationId: "10000000-0000-4000-8000-000000000001" };
const entryId = "20000000-0000-4000-8000-000000000002";
const reversalId = "30000000-0000-4000-8000-000000000003";

const entry = {
  id: entryId,
  memo: "Inventory valuation summary",
  sourceType: "inventory-valuation",
  reversalOfId: null,
  postedAt: "2026-10-14T10:00:00Z",
  actorType: "human",
  currency: "UGX",
  amountMinor: 2500,
  debitMinor: 2500,
};

function installLocks() {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name: string, _options: unknown, callback: () => unknown) => callback() },
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("InventoryValuationPanel", () => {
  it("confirms a reconciliation and explains a no-op when balances already match", async () => {
    installLocks();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (body && typeof body === "object" && "capabilityId" in body && body.capabilityId === "accounting.overview") {
        return Response.json({ ok: true, data: { entries: [] } });
      }
      return Response.json({ ok: true, data: { posted: false, entryId: null, varianceMinor: 0, ledgerValueMinor: 12000, glBalanceMinor: 12000 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryValuationPanel currency="UGX" retryScope={scope} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconcile stock value" }));
    expect(screen.getByRole("dialog", { name: "Reconcile inventory value" }).textContent).toContain("Workspace policy may require approval");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and submit" }));
    expect(await screen.findByText(/already matches the General Ledger/)).not.toBeNull();
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")).capabilityId)).toContain("inventory.postValuationSummary");
  });

  it("retains approval pending and retries the exact action and intent", async () => {
    installLocks();
    let writeCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (body && typeof body === "object" && "capabilityId" in body && body.capabilityId === "accounting.overview") {
        return Response.json({ ok: true, data: { entries: [] } });
      }
      writeCount += 1;
      if (writeCount === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 });
      return Response.json({ ok: true, data: { posted: true, entryId, varianceMinor: 500, ledgerValueMinor: 12500, glBalanceMinor: 12000 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryValuationPanel currency="UGX" retryScope={scope} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconcile stock value" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and submit" }));
    expect(await screen.findByText(/waiting for approval: Manager approval required/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved valuation action" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saved valuation action" })).toBeNull());

    const writes = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body ?? "{}")))
      .filter((body) => body.capabilityId === "inventory.postValuationSummary");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ input: writes[0].input, intentId: writes[0].intentId });
    expect(await screen.findByText(/Valuation summary posted/)).not.toBeNull();
  });

  it("keeps posting available when accounting.read cannot load reversal history", async () => {
    installLocks();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (body && typeof body === "object" && "capabilityId" in body && body.capabilityId === "accounting.overview") {
        return Response.json({ error: "forbidden: requires accounting.read" }, { status: 403 });
      }
      return Response.json({ ok: true, data: { posted: false, entryId: null, varianceMinor: 0, ledgerValueMinor: 12000, glBalanceMinor: 12000 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryValuationPanel currency="UGX" retryScope={scope} />);

    expect(await screen.findByText(/Valuation history requires accounting.read/)).not.toBeNull();
    const postButton = screen.getByRole("button", { name: "Reconcile stock value" }) as HTMLButtonElement;
    expect(postButton.disabled).toBe(false);
    fireEvent.click(postButton);
    expect(screen.getByRole("dialog", { name: "Reconcile inventory value" }).textContent).toContain("Workspace policy may require approval");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and submit" }));
    expect(await screen.findByText(/already matches the General Ledger/)).not.toBeNull();
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")).capabilityId)).toContain("inventory.postValuationSummary");
  });

  it("lets the user reverse an unreversed valuation summary and refreshes its history", async () => {
    installLocks();
    let reversed = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (body && typeof body === "object" && "capabilityId" in body && body.capabilityId === "accounting.overview") {
        return Response.json({ ok: true, data: { entries: reversed ? [entry, { ...entry, id: reversalId, sourceType: "inventory-valuation-reversal", reversalOfId: entryId }] : [entry] } });
      }
      reversed = true;
      return Response.json({ ok: true, data: { reversed: true, reversalEntryId: reversalId } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryValuationPanel currency="UGX" retryScope={scope} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reverse" }));
    expect(screen.getByRole("dialog", { name: "Reverse valuation summary" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and submit" }));
    expect(await screen.findByText(/Valuation entry reversed/)).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reverse" })).toBeNull());
    const write = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}"))).find((body) => body.capabilityId === "inventory.reverseValuationSummary");
    expect(write).toMatchObject({ input: { entryId } });
  });
});
