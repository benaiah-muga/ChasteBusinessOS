import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosPage } from "./PosPage";

const sessionId = "10000000-0000-4000-8000-000000000001";
const closedSessionId = "10000000-0000-4000-8000-000000000002";
const saleId = "20000000-0000-4000-8000-000000000003";
const saleLineId = "30000000-0000-4000-8000-000000000004";

/** Session timestamps are relative to now so relative-time copy stays assertable on any day. */
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const openSession = {
  id: sessionId,
  register: "Front register",
  status: "open",
  openingFloatMinor: 10000,
  expectedCashMinor: 4500,
  countedCashMinor: null,
  varianceMinor: null,
  openedAt: hoursAgo(7),
  closedAt: null,
};

const closedSession = {
  ...openSession,
  id: closedSessionId,
  status: "closed",
  expectedCashMinor: 2000,
  countedCashMinor: 1800,
  varianceMinor: -200,
  varianceReason: "one refund entered after the count",
  closedAt: hoursAgo(3),
};

const sale = {
  id: saleId,
  number: 41,
  status: "posted",
  totalMinor: 2500,
  creditedMinor: 0,
  memo: null,
  customerId: null,
  customerName: "Amina",
  method: "cash",
  returnMode: "itemized" as const,
  unallocatedCreditMinor: 0,
  lines: [{
    id: saleLineId,
    itemId: "item-1",
    description: "Boda bread",
    quantity: 1000,
    unitPriceMinor: 2500,
    taxMinor: 0,
    returnedQuantity: 0,
    stockTracked: true,
  }],
  createdAt: "2026-09-28T10:00:00.000Z",
};

const catalogItem = {
  sku: "BRD-001",
  name: "Boda bread",
  kind: "goods",
  unitLabel: "loaf",
  salePriceMinor: 2500,
  barcode: "6001234567890",
  availableThousandths: 12000,
  tags: ["bakery"],
};

const shiftSummary = {
  register: "Front register",
  status: "open",
  salesCount: 3,
  takingsMinor: 129900,
  tenderTotals: [{ method: "cash", amountMinor: 89900 }, { method: "card", amountMinor: 40000 }],
  refundTotals: [{ method: "cash", amountMinor: 1000 }],
  expectedCashMinor: 4500,
  countedCashMinor: null,
  varianceMinor: null,
};

type Payload = Record<string, unknown>;

/** Routes the page's own reads and writes so each test only overrides what it asserts. */
function registerRoute(overrides: (url: string, payload: Payload | null) => Response | null = () => null) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const payload = init?.body ? (JSON.parse(String(init.body)) as Payload) : null;
    const override = overrides(url, payload);
    if (override) return override;
    if (url === "/api/modules") return Response.json({ catalog: [{ id: "pos" }, { id: "inventory" }], enabledModules: ["pos", "inventory"] });
    if (url === "/api/inventory") return Response.json({ items: [catalogItem] });
    if (url === "/api/customers") return Response.json({ customers: [{ id: "20000000-0000-4000-8000-000000000001", name: "Amina", email: "amina@example.test", purchaseCount: 2, lifetimeSpendMinor: 10000 }] });
    if (url === "/api/pos" && !payload) return Response.json({ sessions: [openSession, closedSession], sales: [sale] });
    if (url === "/api/pos" && payload?.action === "shiftSummary") return Response.json({ ok: true, data: shiftSummary });
    if (url === "/api/pos" && payload?.action === "sale") {
      return Response.json({
        ok: true,
        data: { invoiceId: saleId, invoiceNumber: 41, totalMinor: 2500, tenderedMinor: 2500, changeGivenMinor: 0, tenders: [{ method: "cash", amountMinor: 2500 }] },
      });
    }
    if (url === "/api/pos" && payload?.action === "open") return Response.json({ ok: true, data: { sessionId } });
    if (url === "/api/pos" && payload?.action === "close") {
      return Response.json({ ok: true, data: { expectedCashMinor: 14500, varianceMinor: -500, flagged: true } });
    }
    if (url === "/api/pos" && payload?.action === "returnSale") {
      return Response.json({ ok: true, data: { refundEntryId: "e1", refundMinor: 2500, creditedMinor: 0, restockedLines: 1, refundMethod: "cash" } });
    }
    return Response.json({ ok: true, data: {} });
  });
}

function postedPayloads(fetchMock: ReturnType<typeof registerRoute>, action: string): Payload[] {
  return fetchMock.mock.calls
    .map((call) => (call[1]?.body ? (JSON.parse(String(call[1].body)) as Payload) : null))
    .filter((payload): payload is Payload => payload?.action === action);
}

/** The mobile checkout bar repeats the checkout action, so scope it to the ring-a-sale panel. */
function completeSaleButton(): Promise<HTMLElement> {
  return within(screen.getByRole("region", { name: "Ring a sale" }))
    .findByRole("button", { name: /^(Complete sale|Retry same sale attempt)/ });
}

/** Recent sales renders a table and a card stack, so scope the return action to the sale's row. */
function returnButtonForSale(number: number): Promise<HTMLElement> {
  return screen.findByRole("row", { name: new RegExp(`^#${number}`) })
    .then((row) => within(row).getByRole("button", { name: "Return" }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/pos");
  vi.unstubAllGlobals();
});

describe("Vite POS register page", () => {
  it("summarises the floor and the drawer from the register state", async () => {
    vi.stubGlobal("fetch", registerRoute());
    render(<PosPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Register workspace" })).not.toBeNull();
    expect(await screen.findByText("Front register")).not.toBeNull();
    expect(screen.getByText("Expected in drawer")).not.toBeNull();
    expect(screen.getByText("$145.00")).not.toBeNull();
    expect(screen.getByText("Watch list")).not.toBeNull();
    expect(screen.getByText(/Front register · closed/)).not.toBeNull();
    expect(screen.getByText("−$2.00")).not.toBeNull();
    expect(screen.getByRole("link", { name: "POS shift summary" }).getAttribute("href")).toBe("/pos/shift-summary");
    fireEvent.click(screen.getByRole("tab", { name: "Sell · register open" }));
    expect(screen.getByRole("link", { name: "Full shift summary" }).getAttribute("href")).toBe("/pos/shift-summary");
  });

  it("keeps the module gate visible instead of rendering a register that is switched off", async () => {
    vi.stubGlobal("fetch", registerRoute((url) => url === "/api/modules"
      ? Response.json({ catalog: [{ id: "pos" }, { id: "inventory" }], enabledModules: [] })
      : null));
    render(<PosPage />);
    expect(await screen.findByRole("heading", { name: "Point of sale is not enabled" })).not.toBeNull();
  });

  it("offers a retry when register data cannot be read, then loads", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", registerRoute((url, payload) => {
      if (url === "/api/pos" && !payload) {
        attempt += 1;
        if (attempt === 1) return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return null;
    }));
    render(<PosPage />);
    expect(await screen.findByRole("heading", { name: "Could not load register data" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Expected in drawer")).not.toBeNull();
  });

  it("refuses register data whose money is not integer minor units", async () => {
    vi.stubGlobal("fetch", registerRoute((url, payload) => url === "/api/pos" && !payload
      ? Response.json({ sessions: [{ ...openSession, openingFloatMinor: "100.00" }], sales: [] })
      : null));
    render(<PosPage />);
    expect(await screen.findByRole("heading", { name: "Could not load register data" })).not.toBeNull();
    expect(screen.getByText("The POS service returned register data in an unexpected format.")).not.toBeNull();
  });

  it("opens a register session with the opening float in minor units", async () => {
    const fetchMock = registerRoute((url, payload) => {
      if (url === "/api/pos" && payload?.action === "open") return Response.json({ ok: true, data: { sessionId } });
      if (url === "/api/pos" && !payload) return Response.json({ sessions: [closedSession], sales: [sale] });
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Open the register" })).not.toBeNull();
    // The label wraps its helper copy, so its accessible name is longer than the visible title.
    fireEvent.change(screen.getByLabelText(/^Opening float/), { target: { value: "120.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Open register" }));

    await waitFor(() => expect(postedPayloads(fetchMock, "open")).toHaveLength(1));
    expect(postedPayloads(fetchMock, "open")[0]).toEqual({
      action: "open",
      openingFloatMinor: 12050,
      intentId: expect.any(String),
    });
    expect(await screen.findByText("Register session opened.")).not.toBeNull();
  });

  it("computes drawer variance, requires a reason, and records the close", async () => {
    const fetchMock = registerRoute();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    const counted = await screen.findByLabelText("Counted cash");
    fireEvent.change(counted, { target: { value: "140.00" } });
    expect(screen.getByText("Variance preview:").textContent).toContain("−$5.00");
    expect(screen.getByRole("button", { name: "Close session and reconcile" }).hasAttribute("disabled")).toBe(true);

    // Same wrapped-label shape as the opening float field above.
    fireEvent.change(screen.getByLabelText(/^Explain the variance/), { target: { value: "one cash refund entered after the count" } });
    fireEvent.click(screen.getByRole("button", { name: "Close session and reconcile" }));

    expect(await screen.findByRole("dialog", { name: "Close this register session?" })).not.toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close and reconcile" }));

    await waitFor(() => expect(postedPayloads(fetchMock, "close")).toHaveLength(1));
    expect(postedPayloads(fetchMock, "close")[0]).toEqual({
      action: "close",
      sessionId,
      countedCashMinor: 14000,
      varianceReason: "one cash refund entered after the count",
      intentId: expect.any(String),
    });
    expect(await screen.findByText("Drawer variance of −$5.00 recorded")).not.toBeNull();
  });

  it("rings a cash sale with change and clears the cart", async () => {
    const fetchMock = registerRoute();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    const search = await screen.findByLabelText("Search products by name, SKU, or barcode");
    fireEvent.change(search, { target: { value: "bread" } });
    // The row's favourite toggle is named after the item as well, so anchor on the quick-add name.
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));

    expect(await screen.findByText("Cart · 1 line")).not.toBeNull();
    expect(screen.getByText("Change due $0.00")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Cash received"), { target: { value: "30.00" } });
    expect(screen.getByText("Change due $5.00")).not.toBeNull();

    fireEvent.click(await completeSaleButton());

    await waitFor(() => expect(postedPayloads(fetchMock, "sale")).toHaveLength(1));
    const salePayload = postedPayloads(fetchMock, "sale")[0]!;
    expect(salePayload).toEqual({
      action: "sale",
      sessionId,
      method: "cash",
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      tenders: [{ method: "cash", amountMinor: 2500 }],
      cashReceivedMinor: 3000,
      intentId: expect.any(String),
    });
    expect(await screen.findByText("Sale #41 recorded for $25.00 (cash $25.00).")).not.toBeNull();
    expect(screen.getByText("Receipt ready for Walk-in customer.")).not.toBeNull();
  });

  it("keeps the selected customer's email on the receipt after checkout clears the selection", async () => {
    vi.stubGlobal("fetch", registerRoute());
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    fireEvent.click(await screen.findByText(/^Attach customer/));
    fireEvent.change(await screen.findByLabelText("Customer lookup"), { target: { value: "amina" } });
    const customerResults = within(await screen.findByRole("list", { name: "Matching customers" }));
    fireEvent.click(customerResults.getByRole("button", { name: /Amina/ }));

    fireEvent.change(await screen.findByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());

    expect(await screen.findByText("Receipt ready for Amina.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
    expect(await screen.findByText(/^Attach customer/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview and share" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Receipt preview" }));
    expect(dialog.getByText("For Amina")).not.toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Email draft" }));
    expect(await dialog.findByText("Email draft opened for amina@example.test. Review it before sending.")).not.toBeNull();
  });

  it("reuses the opaque sale intent after an uncertain send and clears it after completion", async () => {
    let saleAttempts = 0;
    const fetchMock = registerRoute((url, payload) => {
      if (url !== "/api/capabilities/execute" || payload?.capabilityId !== "pos.completeSale") return null;
      saleAttempts += 1;
      if (saleAttempts === 1) throw new TypeError("connection reset");
      return Response.json({
        ok: true,
        data: { invoiceId: saleId, invoiceNumber: 41, totalMinor: 2500, tenderedMinor: 2500, changeGivenMinor: 0, tenders: [{ method: "cash", amountMinor: 2500 }] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    const firstRender = render(<PosPage baseCurrency="USD" actorId="operator-retry" useGoCompleteSale />);

    fireEvent.change(await screen.findByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.focus(screen.getByRole("button", { name: "Remove Boda bread" }));
    fireEvent.click(await completeSaleButton());
    expect(await screen.findByText("Sale status is not confirmed")).not.toBeNull();
    expect(screen.getByLabelText("Search products by name, SKU, or barcode").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Cash received").hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(window, { key: "Backspace", ctrlKey: true });
    expect(screen.getByText("Cart · 1 line")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove Boda bread" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("chaste.pos.cart.v2:unresolved-org:operator-retry") ?? "{}").attemptUncertain).toBe(true));

    const saved = Object.entries(localStorage).find(([key]) => key.startsWith("chaste.pos.sale-intent.v1:"));
    expect(saved).toBeDefined();
    expect(saved![0]).toMatch(/^chaste\.pos\.sale-intent\.v1:[0-9a-f]{64}$/);
    expect(saved![1]).not.toContain("Boda bread");
    const firstIntentId = JSON.parse(saved![1]!).intentId;

    firstRender.unmount();
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="operator-retry" useGoCompleteSale />);
    expect(await screen.findByText(/locked to the same attempt/)).not.toBeNull();
    expect(screen.getByLabelText("Search products by name, SKU, or barcode").hasAttribute("disabled")).toBe(true);
    fireEvent.click(await completeSaleButton());
    await waitFor(() => expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/capabilities/execute")).toHaveLength(2));
    const payloads = fetchMock.mock.calls
      .map((call) => call[1]?.body ? JSON.parse(String(call[1].body)) as Payload : null)
      .filter((payload): payload is Payload => payload?.capabilityId === "pos.completeSale");
    expect(payloads[0]!.intentId).toBe(firstIntentId);
    expect(payloads[1]!.intentId).toBe(firstIntentId);
    expect(Object.keys(localStorage).some((key) => key.startsWith("chaste.pos.sale-intent.v1:"))).toBe(false);
    expect(await screen.findByText("Sale #41 recorded for $25.00 (cash $25.00).")).not.toBeNull();
  });

  it("surfaces a governed 202 as pending rather than as a posted sale", async () => {
    const fetchMock = registerRoute((url, payload) => url === "/api/pos" && payload?.action === "sale"
      ? Response.json({ ok: false, pendingApproval: true, reason: "needs a manager" }, { status: 202 })
      : null);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    fireEvent.change(await screen.findByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());

    const pending = await screen.findByText("This sale is waiting for approval.");
    expect(pending.closest(".pos-notice")?.className).toContain("pos-notice-pending");
    expect(await screen.findByText(/This cart is already waiting for approval/)).not.toBeNull();
    expect(postedPayloads(fetchMock, "sale")[0]).toEqual(expect.objectContaining({ intentId: expect.any(String) }));
  });

  it("rotates the pending attempt only when Start another sale is chosen", async () => {
    let saleAttempts = 0;
    const fetchMock = registerRoute((url, payload) => {
      if (url !== "/api/capabilities/execute" || payload?.capabilityId !== "pos.completeSale") return null;
      saleAttempts += 1;
      if (saleAttempts === 1) return Response.json({ ok: false, pendingApproval: true, reason: "needs a manager" }, { status: 202 });
      return Response.json({
        ok: true,
        data: { invoiceId: saleId, invoiceNumber: 42, totalMinor: 2500, tenderedMinor: 2500, changeGivenMinor: 0, tenders: [{ method: "cash", amountMinor: 2500 }] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="operator-rotate" useGoCompleteSale />);

    fireEvent.change(await screen.findByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());
    await screen.findByText("This sale is waiting for approval.");
    const retryKey = Object.keys(localStorage).find((key) => key.startsWith("chaste.pos.sale-intent.v1:"));
    expect(retryKey).toBeDefined();
    const firstIntentId = JSON.parse(localStorage.getItem(retryKey!)!).intentId;

    fireEvent.click(screen.getByRole("button", { name: "Start another sale" }));
    await waitFor(() => expect(localStorage.getItem(retryKey!)).toBeNull());
    fireEvent.change(screen.getByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());

    await screen.findByText("Sale #42 recorded for $25.00 (cash $25.00).");
    const saleRequests = fetchMock.mock.calls
      .map((call) => call[1]?.body ? JSON.parse(String(call[1].body)) as Payload : null)
      .filter((payload): payload is Payload => payload?.capabilityId === "pos.completeSale");
    expect(saleRequests).toHaveLength(2);
    expect(saleRequests[1]!.intentId).not.toBe(firstIntentId);
  });

  it("requires an explicit abandon action before an uncertain sale can be replaced", async () => {
    let saleAttempts = 0;
    const fetchMock = registerRoute((url, payload) => {
      if (url !== "/api/capabilities/execute" || payload?.capabilityId !== "pos.completeSale") return null;
      saleAttempts += 1;
      if (saleAttempts === 1) throw new TypeError("connection reset");
      return Response.json({ ok: true, data: { invoiceId: saleId, invoiceNumber: 44, totalMinor: 2500, tenderedMinor: 2500, changeGivenMinor: 0, tenders: [{ method: "cash", amountMinor: 2500 }] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="operator-abandon" useGoCompleteSale />);

    fireEvent.change(await screen.findByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());
    await screen.findByText("Sale status is not confirmed");
    const firstIntentId = JSON.parse(localStorage.getItem("chaste.pos.cart.v2:unresolved-org:operator-abandon") ?? "{}").attemptIntentId;
    expect(firstIntentId).toEqual(expect.any(String));

    fireEvent.click(screen.getByRole("button", { name: "Abandon attempt and start another sale" }));
    await waitFor(() => expect(localStorage.getItem("chaste.pos.cart.v2:unresolved-org:operator-abandon")).toBeNull());
    fireEvent.change(screen.getByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());
    await screen.findByText("Sale #44 recorded for $25.00 (cash $25.00).");

    const saleRequests = fetchMock.mock.calls
      .map((call) => call[1]?.body ? JSON.parse(String(call[1].body)) as Payload : null)
      .filter((payload): payload is Payload => payload?.capabilityId === "pos.completeSale");
    expect(saleRequests).toHaveLength(2);
    expect(saleRequests[0]!.intentId).toBe(firstIntentId);
    expect(saleRequests[1]!.intentId).not.toBe(firstIntentId);
  });

  it("refuses a sale the payload schema rejects before any request is sent", async () => {
    const fetchMock = registerRoute((url, payload) => url === "/api/pos" && payload?.action === "sale"
      ? Response.json({ error: "line quantity must be positive" }, { status: 400 })
      : null);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    fireEvent.change(await screen.findByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());

    const notice = await screen.findByText("The POS service rejected the request. Review the details and try again.");
    expect(notice.closest(".pos-notice")?.className).toContain("pos-notice-error");
  });

  it("requests an itemized return with the chosen quantities", async () => {
    const fetchMock = registerRoute();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    fireEvent.click(await returnButtonForSale(41));
    const dialog = await screen.findByRole("dialog", { name: "Return sale #41" });

    fireEvent.change(within(dialog).getByLabelText("Quantity to return for Boda bread, 1 available"), { target: { value: "1" } });
    expect(within(dialog).getByText("Selected refund: $25.00")).not.toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Reason for return"), { target: { value: "damaged on arrival" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Request selected return" }));

    await waitFor(() => expect(postedPayloads(fetchMock, "returnSale")).toHaveLength(1));
    expect(postedPayloads(fetchMock, "returnSale")[0]).toEqual({
      action: "returnSale",
      invoiceId: saleId,
      reason: "damaged on arrival",
      refundMethod: "cash",
      lines: [{ invoiceLineId: saleLineId, quantity: 1000 }],
      intentId: expect.any(String),
    });
    expect(await screen.findByText("Return posted, $25.00 refunded to cash.")).not.toBeNull();
  });

  it("recovers a pending Go return after reload and retries the exact same attempt", async () => {
    let goAttempts = 0;
    let reloadAsCompleted = false;
    const fetchMock = registerRoute((url, payload) => {
      if (url === "/api/pos" && !payload && reloadAsCompleted) {
        return Response.json({ sessions: [openSession, closedSession], sales: [{ ...sale, creditedMinor: 2500, lines: [{ ...sale.lines[0], returnedQuantity: 1000 }] }] });
      }
      if (url === "/api/capabilities/execute" && payload?.capabilityId === "pos.returnSale") {
        return ++goAttempts === 1
          ? Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 })
          : Response.json({ ok: true, data: { refundEntryId: "e1", refundMinor: 2500, creditedMinor: 2500, restockedLines: 1, refundMethod: "cash" } });
      }
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    const { unmount } = render(<PosPage baseCurrency="USD" actorId="actor-1" organizationId="org-1" useGoReturnSale />);

    fireEvent.click(await returnButtonForSale(41));
    const dialog = await screen.findByRole("dialog", { name: "Return sale #41" });
    fireEvent.change(within(dialog).getByLabelText("Quantity to return for Boda bread, 1 available"), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText("Reason for return"), { target: { value: "damaged on arrival" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request selected return" }));

    expect(await screen.findByText(/Return of sale #41 is waiting for approval/)).not.toBeNull();
    expect(within(dialog).getByLabelText("Reason for return")).toHaveProperty("value", "damaged on arrival");
    expect(within(dialog).getByLabelText("Quantity to return for Boda bread, 1 available")).toHaveProperty("value", "1");
    expect(within(dialog).getByRole("button", { name: "Retry pending return safely" })).not.toBeNull();
    unmount();
    reloadAsCompleted = true;
    render(<PosPage baseCurrency="USD" actorId="actor-1" organizationId="org-1" useGoReturnSale />);

    const restoredDialog = await screen.findByRole("dialog", { name: "Return sale #41" });
    expect(within(restoredDialog).getByLabelText("Reason for return")).toHaveProperty("value", "damaged on arrival");
    expect(within(restoredDialog).getByLabelText("Quantity to return for Boda bread, 0 available")).toHaveProperty("value", "1");
    fireEvent.click(within(restoredDialog).getByRole("button", { name: "Retry pending return safely" }));
    expect(await screen.findByText("Return posted, $25.00 refunded to cash.")).not.toBeNull();
    const request = fetchMock.mock.calls.find((call) => String(call[0]) === "/api/capabilities/execute");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      capabilityId: "pos.returnSale",
      input: { invoiceId: saleId, reason: "damaged on arrival", refundMethod: "cash", lines: [{ invoiceLineId: saleLineId, quantity: 1000 }] },
      intentId: expect.any(String),
    });
    const goPayloads = fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/capabilities/execute").map((call) => JSON.parse(String(call[1]?.body)));
    expect(goPayloads).toHaveLength(2);
    expect(goPayloads[0]).toEqual(goPayloads[1]);
    expect(postedPayloads(fetchMock, "returnSale")).toHaveLength(0);
  });

  it("clears a pending return attempt after terminal 4xx and permits a corrected fresh request", async () => {
    let goAttempts = 0;
    const fetchMock = registerRoute((url, payload) => {
      if (url === "/api/capabilities/execute" && payload?.capabilityId === "pos.returnSale") {
        goAttempts += 1;
        if (goAttempts === 1) return Response.json({ ok: false, pendingApproval: true, reason: "Manager approval required" }, { status: 202 });
        if (goAttempts === 2) return Response.json({ error: "Approval expired" }, { status: 403 });
        return Response.json({ ok: true, data: { refundEntryId: "e2", refundMinor: 625, creditedMinor: 625, restockedLines: 1, refundMethod: "cash" } });
      }
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="actor-terminal" organizationId="org-terminal" useGoReturnSale />);

    fireEvent.click(await returnButtonForSale(41));
    let dialog = await screen.findByRole("dialog", { name: "Return sale #41" });
    const quantity = within(dialog).getByLabelText("Quantity to return for Boda bread, 1 available");
    fireEvent.change(quantity, { target: { value: "0.5" } });
    fireEvent.change(within(dialog).getByLabelText("Reason for return"), { target: { value: "damaged on arrival" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request selected return" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Retry pending return safely" }));

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Request selected return" }).hasAttribute("disabled")).toBe(false));
    dialog = screen.getByRole("dialog", { name: "Return sale #41" });
    const correctedQuantity = within(dialog).getByLabelText("Quantity to return for Boda bread, 1 available");
    expect(correctedQuantity.hasAttribute("disabled")).toBe(false);
    fireEvent.change(correctedQuantity, { target: { value: "0.25" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request selected return" }));

    expect(await screen.findByText("Return posted, $6.25 refunded to cash.")).not.toBeNull();
    const attempts = fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/capabilities/execute").map((call) => JSON.parse(String(call[1]?.body)));
    expect(attempts).toHaveLength(3);
    expect(attempts[0].intentId).toBe(attempts[1].intentId);
    expect(attempts[2].intentId).not.toBe(attempts[1].intentId);
    expect(attempts[2].input.lines).toEqual([{ invoiceLineId: saleLineId, quantity: 250 }]);
  });

  it("locks an uncertain Go return to its exact payload and retries with the same intent", async () => {
    let goAttempts = 0;
    const fetchMock = registerRoute((url, payload) => {
      if (url === "/api/capabilities/execute" && payload?.capabilityId === "pos.returnSale") {
        goAttempts += 1;
        if (goAttempts === 1) throw new TypeError("network lost");
        return Response.json({ ok: true, data: { refundEntryId: "e1", refundMinor: 1250, creditedMinor: 1250, restockedLines: 1, refundMethod: "cash" } });
      }
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="actor-1" organizationId="org-1" useGoReturnSale />);

    fireEvent.click(await returnButtonForSale(41));
    let dialog = await screen.findByRole("dialog", { name: "Return sale #41" });
    const quantity = within(dialog).getByLabelText("Quantity to return for Boda bread, 1 available");
    fireEvent.change(quantity, { target: { value: "0.5" } });
    fireEvent.change(within(dialog).getByLabelText("Reason for return"), { target: { value: "damaged on arrival" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request selected return" }));

    expect(await screen.findByText("Return result is unknown")).not.toBeNull();
    dialog = screen.getByRole("dialog", { name: "Return sale #41" });
    expect(within(dialog).getByLabelText("Quantity to return for Boda bread, 1 available").hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry exact return" }));
    await waitFor(() => expect(screen.getByText("Return posted, $12.50 refunded to cash.")).not.toBeNull());
    const attempts = fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/capabilities/execute").map((call) => JSON.parse(String(call[1]?.body)));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
  });

  it("holds a credit-review sale out of the return request", async () => {
    vi.stubGlobal("fetch", registerRoute((url, payload) => url === "/api/pos" && !payload
      ? Response.json({ sessions: [openSession], sales: [{ ...sale, returnMode: "credit-review", creditedMinor: 500 }] })
      : null));
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" />);

    fireEvent.click(await returnButtonForSale(41));
    const dialog = await screen.findByRole("dialog", { name: "Return sale #41" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Ask accounting to review the sale");
    fireEvent.change(within(dialog).getByLabelText("Reason for return"), { target: { value: "damaged on arrival" } });
    expect(within(dialog).getByRole("button", { name: "Request full return" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps a queued offline sale on its original intent identity when it is sent", async () => {
    const queued = {
      id: "50000000-0000-4000-8000-000000000005",
      intentId: "40000000-0000-4000-8000-000000000006",
      sessionId,
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      method: "cash",
      tenders: [{ method: "cash", amountMinor: 2500 }],
      cashReceivedMinor: 2500,
      totalMinor: 2500,
      queuedAt: "2026-09-28T09:30:00.000Z",
      status: "queued",
      errorMessage: null,
    };
    localStorage.setItem("chaste.pos.queued-sales.v2:unresolved-org:queued-owner", JSON.stringify([queued]));
    const fetchMock = registerRoute();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="queued-owner" />);

    expect(await screen.findByText("Offline sales queue")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send sale" }));

    await waitFor(() => expect(postedPayloads(fetchMock, "sale")).toHaveLength(1));
    expect(postedPayloads(fetchMock, "sale")[0]).toEqual(expect.objectContaining({
      intentId: "40000000-0000-4000-8000-000000000006",
      action: "sale",
      sessionId,
    }));
    expect(await screen.findByText("Queued sale #41 posted for $25.00.")).not.toBeNull();
  });

  it("includes tender and change in a queued offline sale receipt", async () => {
    const queued = {
      id: "50000000-0000-4000-8000-000000000025",
      intentId: "40000000-0000-4000-8000-000000000026",
      sessionId,
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "20000000-0000-4000-8000-000000000001",
      method: "cash",
      tenders: [{ method: "cash", amountMinor: 2500 }],
      cashReceivedMinor: 3000,
      totalMinor: 2500,
      queuedAt: "2026-09-28T09:30:00.000Z",
      status: "queued",
      errorMessage: null,
    };
    localStorage.setItem("chaste.pos.queued-sales.v2:unresolved-org:queued-receipt-owner", JSON.stringify([queued]));
    const fetchMock = registerRoute((url, payload) => url === "/api/pos" && payload?.action === "sale"
      ? Response.json({
        ok: true,
        data: { invoiceId: saleId, invoiceNumber: 41, totalMinor: 2500, tenderedMinor: 3000, changeGivenMinor: 500, tenders: [{ method: "cash", amountMinor: 2500 }] },
      })
      : null);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="queued-receipt-owner" />);

    expect(await screen.findByText("Offline sales queue")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send sale" }));
    expect(await screen.findByText("Receipt ready for Amina.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview and share" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Receipt preview" }));
    const receipt = dialog.getByText(/Payment: cash \$25\.00/);
    expect(receipt.textContent).toContain("Cash received: $30.00");
    expect(receipt.textContent).toContain("Change: $5.00");
    fireEvent.click(dialog.getByRole("button", { name: "Email draft" }));
    expect(await dialog.findByText("Email draft opened for amina@example.test. Review it before sending.")).not.toBeNull();
  });

  it("retires a queued sale intent after approval so a later identical sale gets a fresh identity", async () => {
    const queued = {
      id: "50000000-0000-4000-8000-000000000015",
      intentId: "40000000-0000-4000-8000-000000000016",
      sessionId,
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      method: "cash",
      tenders: [{ method: "cash", amountMinor: 2500 }],
      cashReceivedMinor: 2500,
      totalMinor: 2500,
      queuedAt: "2026-09-28T09:30:00.000Z",
      status: "queued",
      errorMessage: null,
    };
    localStorage.setItem("chaste.pos.queued-sales.v2:unresolved-org:queued-pending-owner", JSON.stringify([queued]));
    let saleAttempts = 0;
    const fetchMock = registerRoute((url, payload) => {
      if (url !== "/api/capabilities/execute" || payload?.capabilityId !== "pos.completeSale") return null;
      saleAttempts += 1;
      if (saleAttempts === 1) return Response.json({ ok: false, pendingApproval: true, reason: "needs a manager" }, { status: 202 });
      return Response.json({ ok: true, data: { invoiceId: saleId, invoiceNumber: 43, totalMinor: 2500, tenderedMinor: 2500, changeGivenMinor: 0, tenders: [{ method: "cash", amountMinor: 2500 }] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="queued-pending-owner" useGoCompleteSale />);

    fireEvent.click(await screen.findByRole("button", { name: "Send sale" }));
    expect(await screen.findByText(/was submitted and is waiting for approval/)).not.toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("chaste.pos.queued-sales.v2:unresolved-org:queued-pending-owner") ?? "[]")).toHaveLength(0));
    expect(Object.keys(localStorage).some((key) => key.startsWith("chaste.pos.sale-intent.v1:") )).toBe(false);

    fireEvent.change(screen.getByLabelText("Search products by name, SKU, or barcode"), { target: { value: "bread" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Boda bread/ }));
    fireEvent.click(await completeSaleButton());
    await screen.findByText("Sale #43 recorded for $25.00 (cash $25.00).");
    const saleRequests = fetchMock.mock.calls
      .map((call) => call[1]?.body ? JSON.parse(String(call[1].body)) as Payload : null)
      .filter((payload): payload is Payload => payload?.capabilityId === "pos.completeSale");
    expect(saleRequests).toHaveLength(2);
    expect(saleRequests[0]!.intentId).toBe(queued.intentId);
    expect(saleRequests[1]!.intentId).not.toBe(queued.intentId);
  });

  it("keeps an uncertain queued intent until the cashier confirms discard", async () => {
    const queued = {
      id: "50000000-0000-4000-8000-000000000017",
      intentId: "40000000-0000-4000-8000-000000000018",
      sessionId,
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      method: "cash",
      tenders: [{ method: "cash", amountMinor: 2500 }],
      cashReceivedMinor: 2500,
      totalMinor: 2500,
      queuedAt: "2026-09-28T09:30:00.000Z",
      status: "queued",
      errorMessage: null,
    };
    localStorage.setItem("chaste.pos.queued-sales.v2:unresolved-org:queued-uncertain-owner", JSON.stringify([queued]));
    const fetchMock = registerRoute((url, payload) => url === "/api/capabilities/execute" && payload?.capabilityId === "pos.completeSale"
      ? (() => { throw new TypeError("connection reset"); })()
      : null);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="queued-uncertain-owner" useGoCompleteSale />);

    fireEvent.click(await screen.findByRole("button", { name: "Send sale" }));
    expect(await screen.findByText("Result unknown")).not.toBeNull();
    const retryRecord = Object.entries(localStorage).find(([key]) => key.startsWith("chaste.pos.sale-intent.v1:"));
    expect(retryRecord).toBeDefined();
    expect(JSON.parse(retryRecord![1]!).intentId).toBe(queued.intentId);

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByText(/Verify Sales and Approvals before discarding/)).not.toBeNull();
    expect(localStorage.getItem(retryRecord![0])).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard after checking" }));
    await waitFor(() => expect(localStorage.getItem(retryRecord![0])).toBeNull());
    expect(await screen.findByText(/Verify Sales and Approvals before creating a replacement/)).not.toBeNull();
  });

  it.each([
    { status: 202, body: { ok: false, pendingApproval: true, reason: 7 } },
    { status: 200, body: { ok: true, data: { invoiceNumber: "not-an-integer" } } },
  ])("keeps a queued intent when the server returns malformed HTTP $status success data", async ({ status, body }) => {
    const queued = {
      id: "50000000-0000-4000-8000-000000000019",
      intentId: "40000000-0000-4000-8000-000000000020",
      sessionId,
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      method: "cash",
      tenders: [{ method: "cash", amountMinor: 2500 }],
      cashReceivedMinor: 2500,
      totalMinor: 2500,
      queuedAt: "2026-09-28T09:30:00.000Z",
      status: "queued",
      errorMessage: null,
    };
    const queueKey = "chaste.pos.queued-sales.v2:unresolved-org:malformed-owner";
    localStorage.setItem(queueKey, JSON.stringify([queued]));
    const fetchMock = registerRoute((url, payload) => url === "/api/capabilities/execute" && payload?.capabilityId === "pos.completeSale"
      ? Response.json(body, { status })
      : null);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="malformed-owner" useGoCompleteSale />);

    fireEvent.click(await screen.findByRole("button", { name: "Send sale" }));
    expect(await screen.findByText("Queued sale result is not confirmed")).not.toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(queueKey) ?? "[]")[0]).toMatchObject({ status: "uncertain", intentId: queued.intentId }));
    const intentRecord = Object.entries(localStorage).find(([key]) => key.startsWith("chaste.pos.sale-intent.v1:"));
    expect(intentRecord).toBeDefined();
    expect(JSON.parse(intentRecord![1]!).intentId).toBe(queued.intentId);
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/capabilities/execute")).toHaveLength(1);
    expect(postedPayloads(fetchMock, "sale")).toHaveLength(0);
  });

  it("isolates the same operator's POS data across active organizations", async () => {
    const actorId = "shared-operator";
    const orgA = "60000000-0000-4000-8000-000000000001";
    const orgB = "60000000-0000-4000-8000-000000000002";
    const cartKey = `chaste.pos.cart.v2:${orgA}:${actorId}`;
    const parkedKey = `chaste.pos.parked-carts.v2:${orgA}:${actorId}`;
    const queueKey = `chaste.pos.queued-sales.v2:${orgA}:${actorId}`;
    localStorage.setItem(cartKey, JSON.stringify({
      sessionId, lines: [{ description: "Org A draft", quantity: 1000, unitPriceMinor: 2500 }], customerId: "", method: "cash", cashReceived: "", splitMode: false, splitTenders: [], awaitingApproval: false,
    }));
    localStorage.setItem(parkedKey, JSON.stringify([{
      id: "50000000-0000-4000-8000-000000000021", parkedAt: "2026-09-28T09:30:00.000Z", sessionId,
      lines: [{ description: "Org A parked", quantity: 1000, unitPriceMinor: 2500 }], customerId: "", customerName: "Walk-in", method: "cash", cashReceived: "", splitMode: false, splitTenders: [],
    }]));
    localStorage.setItem(queueKey, JSON.stringify([{
      id: "50000000-0000-4000-8000-000000000022", intentId: "40000000-0000-4000-8000-000000000023", sessionId,
      lines: [{ description: "Org A queued", quantity: 1000, unitPriceMinor: 2500 }], customerId: "", method: "cash", tenders: [{ method: "cash", amountMinor: 2500 }], cashReceivedMinor: 2500, totalMinor: 2500,
      queuedAt: "2026-09-28T09:30:00.000Z", status: "queued", errorMessage: null,
    }]));

    vi.stubGlobal("fetch", registerRoute());
    window.history.replaceState(null, "", "/pos?tab=sell");
    const otherOrg = render(<PosPage baseCurrency="USD" actorId={actorId} organizationId={orgB} />);
    await screen.findByRole("heading", { name: "Register workspace" });
    expect(screen.queryByText("Org A draft")).toBeNull();
    expect(screen.queryByText("Offline sales queue")).toBeNull();
    expect(screen.queryByRole("region", { name: "Parked carts" })).toBeNull();
    expect(localStorage.getItem(cartKey)).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(queueKey) ?? "[]")).toHaveLength(1);
    otherOrg.unmount();

    render(<PosPage baseCurrency="USD" actorId={actorId} organizationId={orgA} />);
    expect(await screen.findByText("Org A draft")).not.toBeNull();
    expect(await screen.findByText("Offline sales queue")).not.toBeNull();
    expect(await screen.findByRole("region", { name: "Parked carts" })).not.toBeNull();
  });

  it("keeps tab deep links in the URL and restores the cart saved on the device", async () => {
    localStorage.setItem("chaste.pos.cart.v2:unresolved-org:draft-owner", JSON.stringify({
      sessionId,
      lines: [{ description: "Boda bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      method: "card",
      cashReceived: "",
      splitMode: false,
      splitTenders: [],
      awaitingApproval: false,
    }));
    vi.stubGlobal("fetch", registerRoute());
    window.history.replaceState(null, "", "/pos?tab=sell");
    render(<PosPage baseCurrency="USD" actorId="draft-owner" />);

    expect(await screen.findByText("Cart · 1 line")).not.toBeNull();
    expect(screen.getByText("Cart saved on this device. You can leave and come back without losing it.")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^Sessions/ }));
    expect(window.location.search).toBe("?tab=sessions");
    fireEvent.click(screen.getByRole("tab", { name: /Sell/ }));
    expect(window.location.search).toBe("?tab=sell");
  });

  it("isolates active drafts, parked carts, and queued sales by actor and leaves global v1 records inert", async () => {
    const legacyCart = JSON.stringify({ sessionId, lines: [{ description: "Legacy owner bread", quantity: 1000, unitPriceMinor: 1000, sku: "OLD" }], customerId: "", method: "cash", cashReceived: "", splitMode: false, splitTenders: [], awaitingApproval: false });
    const legacyParked = JSON.stringify([{ id: "50000000-0000-4000-8000-000000000008" }]);
    const legacyQueued = JSON.stringify([{ id: "50000000-0000-4000-8000-000000000009" }]);
    localStorage.setItem("chaste.pos.cart.v1", legacyCart);
    localStorage.setItem("chaste.pos.parked-carts.v1", legacyParked);
    localStorage.setItem("chaste.pos.queued-sales.v1", legacyQueued);
    localStorage.setItem("chaste.pos.cart.v2:unresolved-org:operator-a", JSON.stringify({
      sessionId,
      lines: [{ description: "Operator A draft bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      method: "card",
      cashReceived: "",
      splitMode: false,
      splitTenders: [],
      awaitingApproval: false,
    }));
    localStorage.setItem("chaste.pos.parked-carts.v2:unresolved-org:operator-a", JSON.stringify([{
      id: "50000000-0000-4000-8000-000000000010",
      parkedAt: "2026-09-28T09:30:00.000Z",
      sessionId,
      lines: [{ description: "Operator A parked bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      customerName: "Operator A customer",
      method: "cash",
      cashReceived: "",
      splitMode: false,
      splitTenders: [],
    }]));
    localStorage.setItem("chaste.pos.queued-sales.v2:unresolved-org:operator-a", JSON.stringify([{
      id: "50000000-0000-4000-8000-000000000011",
      intentId: "40000000-0000-4000-8000-000000000012",
      sessionId,
      lines: [{ description: "Operator A queued bread", quantity: 1000, unitPriceMinor: 2500, sku: "BRD-001" }],
      customerId: "",
      method: "cash",
      tenders: [{ method: "cash", amountMinor: 2500 }],
      cashReceivedMinor: 2500,
      totalMinor: 2500,
      queuedAt: "2026-09-28T09:30:00.000Z",
      status: "queued",
      errorMessage: null,
    }]));

    const fetchMock = registerRoute();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/pos?tab=sell");
    const otherActor = render(<PosPage baseCurrency="USD" actorId="operator-b" />);
    await screen.findByRole("heading", { name: "Register workspace" });
    await waitFor(() => expect(screen.queryByText("Cart · 1 line")).toBeNull());
    expect(screen.queryByText("Offline sales queue")).toBeNull();
    expect(screen.queryByRole("region", { name: "Parked carts" })).toBeNull();
    expect(screen.queryByText("Operator A draft bread")).toBeNull();
    expect(localStorage.getItem("chaste.pos.cart.v1")).toBe(legacyCart);
    expect(localStorage.getItem("chaste.pos.parked-carts.v1")).toBe(legacyParked);
    expect(localStorage.getItem("chaste.pos.queued-sales.v1")).toBe(legacyQueued);
    otherActor.unmount();

    render(<PosPage baseCurrency="USD" actorId="operator-a" />);
    expect(await screen.findByText("Cart · 1 line")).not.toBeNull();
    expect(await screen.findByText("Offline sales queue")).not.toBeNull();
    expect(await screen.findByRole("region", { name: "Parked carts" })).not.toBeNull();
  });

  it("flags a closed session with a drawer variance in the session history", async () => {
    vi.stubGlobal("fetch", registerRoute());
    window.history.replaceState(null, "", "/pos?tab=sessions");
    render(<PosPage baseCurrency="USD" />);

    expect(await screen.findByRole("heading", { name: "Register history" })).not.toBeNull();
    const flagged = screen.getByRole("row", { name: /−\$2\.00/ });
    expect(flagged.className).toContain("is-variance");
    expect(within(flagged).getByText("one refund entered after the count")).not.toBeNull();
  });
});
