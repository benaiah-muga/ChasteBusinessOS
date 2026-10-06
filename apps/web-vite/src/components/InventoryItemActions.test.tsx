import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryItemActionRequest } from "../api/inventory-items";
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
  it("maps item writes to Go capabilities without forwarding the UI action discriminator", () => {
    const request = inventoryItemActionRequest({
      action: "adjustStock",
      sku: "BEANS-1KG",
      quantityDelta: 1250,
      note: "Opening stock",
    }, "intent-1", true);

    expect(request.url).toBe("/api/capabilities/execute");
    expect(request.body).toEqual({
      capabilityId: "inventory.adjustStock",
      input: { sku: "BEANS-1KG", quantityDelta: 1250, note: "Opening stock" },
      intentId: "intent-1",
    });
  });

  it("keeps the legacy inventory contract selected when the Go slice is disabled", () => {
    const request = inventoryItemActionRequest({
      action: "createItem",
      sku: "BEANS-1KG",
      name: "Coffee beans",
      kind: "goods",
      unitLabel: "bag",
      salePriceMinor: 0,
      reorderPointThousandths: 0,
      tags: [],
    }, "intent-2", false);

    expect(request.url).toBe("/api/inventory");
    expect(request.body).toMatchObject({ action: "createItem", sku: "BEANS-1KG", intentId: "intent-2" });
  });

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

  it("locks and restores the exact Go adjustment after an approval response and page reload", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Owner review" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
    const onChanged = vi.fn();
    const retryScope = { actorId: "actor-1", organizationId: "org-1" };
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    const firstRender = render(<InventoryItemActions items={[item]} onChanged={onChanged} retryScope={retryScope} />);
    await screen.findByRole("button", { name: "Record adjustment" });
    fireEvent.change(screen.getByLabelText("Item"), { target: { value: item.sku } });
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "decrease" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Damaged in storage" } });
    fireEvent.click(screen.getByRole("button", { name: "Record adjustment" }));

    expect(await screen.findByText("Owner review")).not.toBeNull();
    expect(screen.getByLabelText("Quantity")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Retry saved adjustment" })).not.toHaveProperty("disabled", true);
    firstRender.unmount();

    render(<InventoryItemActions items={[item]} onChanged={onChanged} retryScope={retryScope} />);
    expect(await screen.findByText("A stock adjustment is unresolved. Retry the saved adjustment to confirm its outcome.")).not.toBeNull();
    expect(screen.getByLabelText("Item")).toHaveProperty("value", item.sku);
    expect(screen.getByLabelText("Direction")).toHaveProperty("value", "decrease");
    expect(screen.getByLabelText("Quantity")).toHaveProperty("value", "0.5");
    expect(screen.getByLabelText("Reason")).toHaveProperty("value", "Damaged in storage");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved adjustment" }));

    expect(await screen.findByText("Stock adjustment recorded.")).not.toBeNull();
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { intentId: string; input: Record<string, unknown> });
    expect(bodies[1]?.intentId).toBe(bodies[0]?.intentId);
    expect(bodies[1]?.input).toMatchObject({ sku: item.sku, quantityDelta: -500, note: "Damaged in storage" });
  });

  it("disables inputs while saving and ignores a delayed response after the active workspace changes", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const delayedResponse = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(delayedResponse);
    const onChanged = vi.fn();
    const firstScope = { actorId: "actor-1", organizationId: "org-1" };
    const secondScope = { actorId: "actor-2", organizationId: "org-2" };
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__GO_INVENTORY_ITEM_SLICE__", true);

    const view = render(<InventoryItemActions items={[item]} onChanged={onChanged} retryScope={firstScope} />);
    await screen.findByRole("button", { name: "Record adjustment" });
    fireEvent.change(screen.getByLabelText("Item"), { target: { value: item.sku } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Damaged in storage" } });
    fireEvent.click(screen.getByRole("button", { name: "Record adjustment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Quantity")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Reason")).toHaveProperty("disabled", true);

    view.rerender(<InventoryItemActions items={[item]} onChanged={onChanged} retryScope={secondScope} />);
    await screen.findByRole("button", { name: "Record adjustment" });
    expect(screen.getByLabelText("Quantity")).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("Quantity")).toHaveProperty("value", "");

    await act(async () => {
      resolveResponse?.(Response.json({ ok: true, data: { onHandThousandths: 6500 } }));
      await delayedResponse;
    });
    expect(screen.queryByText("Stock adjustment recorded.")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
