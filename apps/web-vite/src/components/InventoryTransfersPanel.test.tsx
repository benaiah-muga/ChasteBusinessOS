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
const transfer: InventoryTransfer = {
  id: "transfer-1", number: 7, status: "pending", note: "Counter stock", from: "MAIN", to: "SHOP",
  lines: [{ lineId: "line-1", sku: "BAG-50", quantityThousandths: 5000, confirmedThousandths: 0 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("inventory transfer API", () => {
  it("posts a governed transfer draft in thousandths to the same-origin compatibility BFF", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { transferId: "transfer-1", status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createInventoryTransfer({ fromLocationCode: "MAIN", toLocationCode: "SHOP", sku: "BAG-50", quantityThousandths: 1250, note: "Shelf stock" })).resolves.toEqual({ kind: "completed" });
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
    await expect(confirmInventoryTransfer("transfer-1", [{ lineId: "line-1", quantityThousandths: 1250 }])).resolves.toEqual({ kind: "pending", reason: "manager review" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "confirmTransfer", transferId: "transfer-1", lines: [{ lineId: "line-1", quantityThousandths: 1250 }] });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("surfaces capability refusals and rejects malformed 2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "insufficient stock at source" }, 422)));
    await expect(confirmInventoryTransfer("transfer-1")).rejects.toMatchObject({ status: 422, message: "insufficient stock at source" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    await expect(confirmInventoryTransfer("transfer-1")).rejects.toBeInstanceOf(InventoryTransferApiError);
  });

  it("warns about unknown outcomes when a transfer request times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Timed out", "TimeoutError"); }));
    await expect(confirmInventoryTransfer("transfer-1"))
      .rejects.toThrow("Check transfer history before retrying");
  });
});

describe("Vite inventory transfers panel", () => {
  it("drafts a transfer through the existing action and refreshes after completion", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { transferId: "transfer-2" } }));
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[]} onChanged={onChanged} />);

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
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[transfer]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm remaining" }));

    expect((await screen.findByRole("status")).textContent).toContain("requires approval");
    expect(screen.getByRole("status").textContent).toContain("owner approval required");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("allows partial confirmation when transfer lines include IDs, and displays API errors", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: false, error: "insufficient stock at source" }, 422));
    vi.stubGlobal("fetch", fetchMock);
    const withLineId = { ...transfer, lines: [{ ...transfer.lines[0]!, lineId: "line-1" }] };
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[withLineId]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Partial quantity for BAG-50"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm entered quantities" }));

    expect((await screen.findByRole("alert")).textContent).toContain("insufficient stock at source");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "confirmTransfer", transferId: "transfer-1", lines: [{ lineId: "line-1", quantityThousandths: 1250 }] });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("requires every remaining line quantity so omitted lines are not confirmed in full by accident", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, data: { transferId: "transfer-1", status: "partial" } }));
    vi.stubGlobal("fetch", fetchMock);
    const withTwoLines = {
      ...transfer,
      lines: [
        { ...transfer.lines[0]!, lineId: "line-1" },
        { sku: "BAG-25", quantityThousandths: 4000, confirmedThousandths: 0, lineId: "line-2" },
      ],
    };
    render(<InventoryTransfersPanel items={items} locations={locations} transfers={[withTwoLines]} onChanged={vi.fn()} />);
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
