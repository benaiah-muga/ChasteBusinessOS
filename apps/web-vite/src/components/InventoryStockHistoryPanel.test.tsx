import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryStockHistoryPanel } from "./InventoryStockHistoryPanel";

const items = [
  { sku: "SKU-1", name: "Coffee beans", unitLabel: "kg" },
  { sku: "SKU-2", name: "Tea", unitLabel: "box" },
];
const movement = {
  id: "11111111-1111-4111-8111-111111111111",
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ movements: [movement], hasMore: false }), { status: 200 })));
    render(<InventoryStockHistoryPanel items={items} currency="USD" />);
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));

    expect((await screen.findByText("Damaged in transit")).textContent).toBe("Damaged in transit");
    expect(screen.getByText("-1.25 kg").textContent).toBe("-1.25 kg");
    expect(screen.getByText("Adjustment").textContent).toBe("Adjustment");
    expect(screen.getByText("$8.25").textContent).toBe("$8.25");
    expect(screen.getByText("Lot BATCH-A · Location MAIN · By human").textContent).toBe("Lot BATCH-A · Location MAIN · By human");
    expect(screen.getByRole("time").getAttribute("dateTime")).toBe(movement.createdAt);
  });

  it.each([
    { currency: "KWD", expected: "KWD 1.000" },
    { currency: "JPY", expected: "¥1,000" },
  ])("formats $currency unit costs using its minor-unit exponent", async ({ currency, expected }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      movements: [{ ...movement, unitCostMinor: 1000 }], hasMore: false,
    }), { status: 200 })));
    render(<InventoryStockHistoryPanel items={items} currency={currency} />);
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));

    expect(await screen.findByText((_text, element) => element?.textContent === expected)).toBeTruthy();
  });

  it("shows empty history and pending approval as distinct states", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ movements: [], hasMore: false }), { status: 200 }))
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

  it("loads older history pages and appends them without dropping the latest movements", async () => {
    const olderMovement = { ...movement, id: "22222222-2222-4222-8222-222222222222", quantityDelta: 500, createdAt: "2026-09-29T10:15:00.000Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ movements: [movement], hasMore: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ movements: [olderMovement], hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InventoryStockHistoryPanel items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));
    expect(await screen.findByText("Damaged in transit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load older movements" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("Damaged in transit")).toHaveLength(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/inventory?sku=SKU-1&beforeCreatedAt=2026-09-30T10%3A15%3A00.000Z&beforeId=11111111-1111-4111-8111-111111111111", expect.any(Object));
    expect(screen.queryByRole("button", { name: "Load older movements" })).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("clears and ignores an in-flight history response after the organization changes", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<InventoryStockHistoryPanel items={items} organizationId="org-first" />);
    fireEvent.click(screen.getByRole("button", { name: "Load history" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(<InventoryStockHistoryPanel items={items} organizationId="org-second" />);
    resolveResponse?.(new Response(JSON.stringify({ movements: [movement], hasMore: false }), { status: 200 }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Load history" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Damaged in transit")).toBeNull();
    expect(screen.queryByRole("row")).toBeNull();
  });
});
