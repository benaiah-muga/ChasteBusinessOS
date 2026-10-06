import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmInventoryTransfer, createInventoryTransfer, InventoryTransferApiError } from "../api/inventory-transfers";
import type { InventoryItem, InventoryLocation, InventoryTransfer } from "../api/inventory";
import { InventoryTransfersPanel } from "./InventoryTransfersPanel";

const items: InventoryItem[] = [{
  sku: "BAG-50", name: "Cement 50kg", kind: "goods", unitLabel: "bag", onHandThousandths: 12000,
  reservedThousandths: 2000, availableThousandths: 10000, totalValueMinor: 28000, reorderPointThousandths: 0, reorderNeeded: false,
}];
const locations: InventoryLocation[] = [
  { id: "loc-main", code: "MAIN", name: "Main warehouse" },
  { id: "loc-shop", code: "SHOP", name: "Shop" },
];
const retryScope = { actorId: "actor-1", organizationId: "org-1" };
const transferResponseId = "60000000-0000-4000-8000-000000000006";
const transfer: InventoryTransfer = {
  id: "transfer-1", number: 7, status: "pending", note: "Counter stock", from: "MAIN", to: "SHOP",
  lines: [{ lineId: "line-1", sku: "BAG-50", quantityThousandths: 5000, confirmedThousandths: 0 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("inventory transfer API", () => {
  it("posts a governed transfer draft in thousandths to the same-origin compatibility BFF", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { transferId: transferResponseId, number: 7, status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createInventoryTransfer({ fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "BAG-50", quantityThousandths: 1250, note: "Shelf stock" }, retryScope)).resolves.toEqual({ kind: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      action: "createTransfer", fromLocationCode: "MAIN", toLocationCode: "SHOP", lines: [{ sku: "BAG-50", quantityThousandths: 1250 }], note: "Shelf stock",
    });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("submits line-scoped partial confirmations and distinguishes pending approval", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: false, pendingApproval: true, reason: "manager review" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(confirmInventoryTransfer("transfer-1", retryScope, [{ lineId: "line-1", quantityThousandths: 1250 }])).resolves.toEqual({ kind: "pending", reason: "manager review" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "confirmTransfer", transferId: "transfer-1", lines: [{ lineId: "line-1", quantityThousandths: 1250 }] });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("surfaces capability refusals and rejects malformed 2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "insufficient stock at source" }, 422)));
    await expect(confirmInventoryTransfer("transfer-1", retryScope)).rejects.toMatchObject({ status: 422, message: "insufficient stock at source" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    await expect(confirmInventoryTransfer("transfer-1", retryScope)).rejects.toBeInstanceOf(InventoryTransferApiError);
  });

  it("warns about unknown outcomes when a transfer request times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Timed out", "TimeoutError"); }));
    await expect(confirmInventoryTransfer("transfer-1", retryScope))
      .rejects.toThrow("Check transfer history before retrying");
  });
});

describe("Vite inventory transfers panel", () => {
  it("drafts a transfer through the existing action and refreshes after completion", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { transferId: transferResponseId, number: 8, status: "pending" } }));
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[]} onChanged={onChanged} retryScope={retryScope} />);

    fireEvent.change(screen.getByLabelText("From location"), { target: { value: "MAIN" } });
    fireEvent.change(screen.getByLabelText("To location"), { target: { value: "SHOP" } });
    fireEvent.change(screen.getByLabelText("Item to transfer"), { target: { value: "BAG-50" } });
    fireEvent.change(screen.getByLabelText("Quantity in units"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Transfer note"), { target: { value: "Shelf stock" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft transfer" }));

    expect((await screen.findByRole("status")).textContent).toContain("Transfer draft created.");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ action: "createTransfer", lines: [{ sku: "BAG-50", quantityThousandths: 1250 }] });
  });

  it("keeps approval-pending transfers visible without refreshing as completed", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: false, pendingApproval: true, reason: "owner approval required" }, 202));
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[transfer]} onChanged={onChanged} retryScope={retryScope} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm remaining" }));

    expect((await screen.findByRole("status")).textContent).toContain("requires approval");
    expect(screen.getByRole("status").textContent).toContain("owner approval required");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps a draft transfer form intact through approval pending and retries the same intent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, pendingApproval: true, reason: "owner approval required" }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId: transferResponseId, number: 9, status: "pending" } }));
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[]} onChanged={onChanged} retryScope={retryScope} />);

    fireEvent.change(screen.getByLabelText("From location"), { target: { value: "MAIN" } });
    fireEvent.change(screen.getByLabelText("To location"), { target: { value: "SHOP" } });
    fireEvent.change(screen.getByLabelText("Item to transfer"), { target: { value: "BAG-50" } });
    fireEvent.change(screen.getByLabelText("Quantity in units"), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Transfer note"), { target: { value: "Shelf stock" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft transfer" }));

    expect((await screen.findByRole("status")).textContent).toContain("owner approval required");
    expect((screen.getByLabelText("Item to transfer") as HTMLSelectElement).value).toBe("BAG-50");
    expect((screen.getByLabelText("Quantity in units") as HTMLInputElement).value).toBe("1.25");
    expect((screen.getByLabelText("Transfer note") as HTMLInputElement).value).toBe("Shelf stock");
    fireEvent.click(screen.getByRole("button", { name: "Draft transfer" }));

    expect((await screen.findByRole("status")).textContent).toContain("Transfer draft created.");
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string });
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Item to transfer") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Quantity in units") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Transfer note") as HTMLInputElement).value).toBe("");
  });

  it("allows partial confirmation when transfer lines include IDs, and displays API errors", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: false, error: "insufficient stock at source" }, 422));
    vi.stubGlobal("fetch", fetchMock);
    const withLineId = { ...transfer, lines: [{ ...transfer.lines[0]!, lineId: "line-1" }] };
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[withLineId]} onChanged={vi.fn()} retryScope={retryScope} />);
    fireEvent.change(screen.getByLabelText("Partial quantity for BAG-50"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));

    expect((await screen.findByRole("alert")).textContent).toContain("insufficient stock at source");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "confirmTransfer", transferId: "transfer-1", lines: [{ lineId: "line-1", quantityThousandths: 1250 }] });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("blocks repeat partial confirmation until refreshed props show transfer progress", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId: transferResponseId, status: "partial", confirmedNowThousandths: 1250 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { transferId: transferResponseId, status: "partial", confirmedNowThousandths: 500 } }));
    const onChanged = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    const staleTransfer = { ...transfer, lines: [{ ...transfer.lines[0]!, lineId: "line-1" }] };
    const rendered = render(<InventoryTransfersPanel items={items} locations={locations} transfers={[staleTransfer]} onChanged={onChanged} retryScope={retryScope} />);

    fireEvent.change(screen.getByLabelText("Partial quantity for BAG-50"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));
    expect((await screen.findByRole("status")).textContent).toContain("Partial confirmation saved");
    expect(onChanged).toHaveBeenCalledTimes(1);

    const partialButton = screen.getByRole("button", { name: "Confirm entered quantities" }) as HTMLButtonElement;
    const remainingButton = screen.getByRole("button", { name: "Confirm remaining" }) as HTMLButtonElement;
    expect(partialButton.disabled).toBe(true);
    expect(remainingButton.disabled).toBe(true);
    fireEvent.click(partialButton);
    fireEvent.click(remainingButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const refreshedTransfer = {
      ...staleTransfer,
      status: "partial",
      lines: [{ ...staleTransfer.lines[0]!, confirmedThousandths: 1250 }],
    };
    rendered.rerender(<InventoryTransfersPanel items={items} locations={locations} transfers={[refreshedTransfer]} onChanged={onChanged} retryScope={retryScope} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirm entered quantities" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText("Partial quantity for BAG-50") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Partial quantity for BAG-50"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      capabilityId: "inventory.confirmTransfer",
      input: { transferId: "transfer-1", lines: [{ lineId: "line-1", quantityThousandths: 500 }] },
    });
  });

  it("keeps the partial confirmation guard when refreshed transfer lines are reordered", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { transferId: transferResponseId, status: "partial", confirmedNowThousandths: 1000 } }));
    const onChanged = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_TRANSFER_WRITES__", true);
    const orderedTransfer = {
      ...transfer,
      lines: [
        { ...transfer.lines[0]!, lineId: "line-1" },
        { lineId: "line-2", sku: "PAPER", quantityThousandths: 3000, confirmedThousandths: 0 },
      ],
    };
    const rendered = render(<InventoryTransfersPanel items={items} locations={locations} transfers={[orderedTransfer]} onChanged={onChanged} retryScope={retryScope} />);

    fireEvent.change(screen.getByLabelText("Partial quantity for BAG-50"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Partial quantity for PAPER"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));
    expect((await screen.findByRole("status")).textContent).toContain("Partial confirmation saved");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rendered.rerender(<InventoryTransfersPanel items={items} locations={locations} transfers={[{ ...orderedTransfer, lines: [...orderedTransfer.lines].reverse() }]} onChanged={onChanged} retryScope={retryScope} />);
    expect((screen.getByRole("button", { name: "Confirm entered quantities" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Confirm remaining" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires every remaining line quantity so omitted lines are not confirmed in full by accident", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { transferId: transferResponseId, status: "partial", confirmedNowThousandths: 3250 } }));
    vi.stubGlobal("fetch", fetchMock);
    const withTwoLines = {
      ...transfer,
      lines: [
        { ...transfer.lines[0]!, lineId: "line-1" },
        { sku: "BAG-25", quantityThousandths: 4000, confirmedThousandths: 0, lineId: "line-2" },
      ],
    };
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[withTwoLines]} onChanged={vi.fn()} retryScope={retryScope} />);
    fireEvent.change(screen.getByLabelText("Partial quantity for BAG-50"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));

    expect((await screen.findByRole("alert")).textContent).toContain("every remaining line");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Partial quantity for BAG-25"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: "confirmTransfer",
      lines: [{ lineId: "line-1", quantityThousandths: 1250 }, { lineId: "line-2", quantityThousandths: 2000 }],
    });
  });
});
