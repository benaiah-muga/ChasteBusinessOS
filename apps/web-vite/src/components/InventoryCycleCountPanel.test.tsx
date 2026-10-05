import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryCycleCount, InventoryItem, InventoryLocation } from "../api/inventory";
import { InventoryCycleCountPanel } from "./InventoryCycleCountPanel";

const items: InventoryItem[] = [
  { sku: "MUG-1", name: "Ceramic mug", kind: "product", unitLabel: "unit", onHandThousandths: 4_000, reservedThousandths: 0, availableThousandths: 4_000, totalValueMinor: 2_000, reorderPointThousandths: 0, reorderNeeded: false },
  { sku: "SERVICE", name: "Delivery service", kind: "service", unitLabel: "service", onHandThousandths: 0, reservedThousandths: 0, availableThousandths: 0, totalValueMinor: 0, reorderPointThousandths: 0, reorderNeeded: false },
];
const locations: InventoryLocation[] = [{ id: "location-1", code: "MAIN", name: "Main warehouse" }];
const openCount: InventoryCycleCount = {
  id: "d2b53ec3-1b61-4f05-a56f-4a0f9d4d3571",
  status: "open",
  note: "Aisle check",
  locationCode: "MAIN",
  createdAt: "2026-05-12T10:30:00.000Z",
  lines: [{ sku: "MUG-1", expectedThousandths: 4_000, countedThousandths: null, varianceThousandths: null }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InventoryCycleCountPanel", () => {
  it("creates a location snapshot for selected items and refreshes after success", async () => {
    const onChanged = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { countId: openCount.id, lineCount: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryCycleCountPanel items={items} locations={locations} counts={[]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /Count every stocked item/ }));
    fireEvent.change(screen.getByLabelText("Count location"), { target: { value: "location-1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search products for this count" }), { target: { value: "mug" } });
    fireEvent.click(screen.getByRole("button", { name: /Ceramic mug/ }));
    fireEvent.change(screen.getByLabelText("Count reason or reference"), { target: { value: "Aisle 4" } });
    fireEvent.click(screen.getByRole("button", { name: "Start count sheet" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
    }));
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({ action: "createCycleCount", skus: ["MUG-1"], locationId: "location-1", note: "Aisle 4" });
    expect(requestBody.intentId).toEqual(expect.any(String));
    expect((await screen.findByRole("status")).textContent).toContain("Open stock count done.");
  });

  it("looks up a barcode, records a quantity, and keeps approval-pending edits", async () => {
    let nextResponse: Response = Response.json({ ok: true, data: { item: { sku: "MUG-1", name: "Ceramic mug" } } });
    const onChanged = vi.fn();
    const fetchMock = vi.fn(async () => nextResponse);
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryCycleCountPanel items={items} locations={locations} counts={[openCount]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /Count every stocked item/ }));
    fireEvent.change(screen.getByLabelText("Scan a barcode into the count"), { target: { value: "MUG-CODE" } });
    fireEvent.click(screen.getByRole("button", { name: "Add scan" }));
    expect(await screen.findByText("Ceramic mug added to this count.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({ body: JSON.stringify({ action: "lookupByBarcode", barcode: "MUG-CODE" }) }));

    const quantityInput = screen.getByLabelText("Counted quantity") as HTMLInputElement;
    fireEvent.change(quantityInput, { target: { value: "3.75" } });
    nextResponse = Response.json({ ok: false, pendingApproval: true, reason: "Approval required" }, { status: 202 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Record MUG-1 requires approval.")).toBeTruthy();
    expect(quantityInput.value).toBe("3.75");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reviews and posts a complete count, while errors are surfaced and do not refresh", async () => {
    const completeCount: InventoryCycleCount = {
      ...openCount,
      lines: [{ sku: "MUG-1", expectedThousandths: 4_000, countedThousandths: 3_750, varianceThousandths: -250 }],
    };
    const onChanged = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "stock moved since the snapshot" }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryCycleCountPanel items={items} locations={locations} counts={[completeCount]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Review & post" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("-0.25 units")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Post to stock ledger" }));

    expect((await screen.findByRole("alert")).textContent).toContain("stock moved since the snapshot");
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("rejects blank counts but allows an intentional zero", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { recorded: true } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryCycleCountPanel items={items} locations={locations} counts={[openCount]} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Use 0 only when no stock is present");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "recordCycleCounts", counts: [{ sku: "MUG-1", countedThousandths: 0 }] });
    expect(body.intentId).toEqual(expect.any(String));
  });

  it("records decimal quantities exactly in thousandths", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { recorded: true } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryCycleCountPanel items={items} locations={locations} counts={[openCount]} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Counted quantity"), { target: { value: "1.005" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "recordCycleCounts", counts: [{ sku: "MUG-1", countedThousandths: 1_005 }] });
  });

  it("cancels an open sheet and refreshes the supplied inventory state", async () => {
    const onChanged = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { cancelled: true } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryCycleCountPanel items={items} locations={locations} counts={[openCount]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel count" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "cancelCycleCount", countId: openCount.id });
    expect(body.intentId).toEqual(expect.any(String));
  });
});
