import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem } from "../api/inventory";
import { InventoryItemActions } from "./InventoryItemActions";

const item: InventoryItem = {
  sku: "BEANS-1KG",
  name: "Coffee beans",
  kind: "goods",
  unitLabel: "bag",
  onHandThousandths: 7000,
  reservedThousandths: 1000,
  availableThousandths: 6000,
  totalValueMinor: 12000,
  reorderPointThousandths: 2000,
  reorderNeeded: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InventoryItemActions", () => {
  it("creates an item and reports an opening-stock approval separately", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { itemId: "6e5f92bb-83f1-45ed-a0b2-e04f2b1e3d43" } }))
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Opening stock needs approval" }, { status: 202 }));
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<InventoryItemActions items={[]} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "BEANS-1KG" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Coffee beans" } });
    fireEvent.change(screen.getByLabelText("Opening stock"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Create item" }));

    expect(await screen.findByText("Item created. Opening stock is waiting for approval.")).not.toBeNull();
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(first).toMatchObject({ action: "createItem", sku: "BEANS-1KG", name: "Coffee beans", kind: "goods", reorderPointThousandths: 0, salePriceMinor: 0 });
    expect(first.intentId).toEqual(expect.any(String));
    expect(second).toMatchObject({ action: "adjustStock", sku: "BEANS-1KG", quantityDelta: 1250, note: "Opening stock" });
    expect(second.intentId).toEqual(expect.any(String));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("records negative stock adjustments through the governed API and refreshes data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    const onChanged = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<InventoryItemActions items={[item]} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Item"), { target: { value: item.sku } });
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "decrease" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Damaged in storage" } });
    fireEvent.click(screen.getByRole("button", { name: "Record adjustment" }));

    expect(await screen.findByText("Stock adjustment recorded.")).not.toBeNull();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const input = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(input).toMatchObject({ action: "adjustStock", sku: item.sku, quantityDelta: -500, note: "Damaged in storage" });
    expect(input.intentId).toEqual(expect.any(String));
  });
});
