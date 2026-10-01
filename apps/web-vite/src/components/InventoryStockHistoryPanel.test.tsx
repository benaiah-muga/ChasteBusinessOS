import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryStockHistoryPanel } from "./InventoryStockHistoryPanel";

const items = [
  { sku: "SKU-1", name: "Coffee beans", unitLabel: "kg" },
  { sku: "SKU-2", name: "Tea", unitLabel: "box" },
];
const movement = {
  id: "move-1",
  quantityDelta: -1250,
  reason: "adjustment",
  note: "Damaged in transit",
  refType: null,
  unitCostMinor: 825,
  lotCode: "BATCH-A",
  locationCode: "MAIN",
  actorType: "human",
  createdAt: "2026-09-30T10:15:00.000Z",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("InventoryStockHistoryPanel", () => {
  it("loads and displays date, quantity, reason, cost, and movement details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ movements: [movement] }), { status: 200 })));
    render(<InventoryStockHistoryPanel items={items} currency="USD" />);
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));

    expect((await screen.findByText("Damaged in transit")).textContent).toBe("Damaged in transit");
    expect(screen.getByText("-1.25 kg").textContent).toBe("-1.25 kg");
    expect(screen.getByText("Adjustment").textContent).toBe("Adjustment");
    expect(screen.getByText("$8.25").textContent).toBe("$8.25");
    expect(screen.getByText("Lot BATCH-A · Location MAIN · By human").textContent).toBe("Lot BATCH-A · Location MAIN · By human");
    expect(screen.getByRole("time").getAttribute("dateTime")).toBe(movement.createdAt);
  });

  it("shows empty history and pending approval as distinct states", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ movements: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, pendingApproval: true, reason: "Approval is required." }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryStockHistoryPanel items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));
    expect((await screen.findByText("No stock movements have been recorded for this item.")).textContent).toContain("No stock movements");

    fireEvent.change(screen.getByLabelText("Item"), { target: { value: "SKU-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));
    expect((await screen.findByText("Approval is required.")).getAttribute("role")).toBe("status");
  });

  it("surfaces API and network errors accessibly", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "History unavailable." }), { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryStockHistoryPanel items={items} />);

    fireEvent.click(screen.getByRole("button", { name: "Load history" }));
    expect((await screen.findByRole("alert")).textContent).toContain("History unavailable.");
    await waitFor(() => expect((screen.getByRole("button", { name: "Load history" }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Load history" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Check your connection");
  });
});
