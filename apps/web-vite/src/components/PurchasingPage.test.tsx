import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PurchasingPage, aggregateReceiveLines, buildBillLines, buildReturnLines, formatThousandths, majorToInput, parseMinor, parseThousandths } from "./PurchasingPage";
import { PurchasingReceivingPage, aggregateReceiveLines as aggregateReceivingLines, formatThousandths as formatReceivingThousandths, prefillReceivingDraft } from "./PurchasingReceivingPage";

/* ------------------------------------------------------------------ fixtures --- */

const switchboard = { catalog: [{ id: "purchasing" }], enabledModules: ["purchasing"] };

const vendor = {
  id: "0569aacb-58c3-4a30-8afe-3554e38eb2ce",
  name: "Harbor Supplies",
  email: "hello@harbor.test",
  paymentTermDays: 30,
  deactivatedAt: null,
  createdAt: "2026-08-01T10:00:00.000Z",
};

function orderFixture(lines = [{ lineNumber: 1, description: "Canvas bag", quantity: 10000, unitPriceMinor: 5000 }]) {
  return {
    id: "1a7c1a1e-9c3a-4f1a-9b2f-3f1c2d4e5a6b",
    number: 42,
    vendorName: "Harbor Supplies",
    status: "ordered",
    memo: null,
    orderedMinor: 50000,
    lines,
  };
}

function workspaceFixture(overrides: Record<string, unknown> = {}) {
  return {
    baseCurrency: "USD",
    vendors: [vendor],
    orders: [orderFixture()],
    bills: [],
    requests: [],
    ...overrides,
  };
}

function billFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f",
    number: 7,
    vendorName: "Harbor Supplies",
    vendorRef: "INV-9",
    memo: null,
    totalMinor: 12500,
    currency: "USD",
    paidMinor: 0,
    creditedMinor: 0,
    status: "open",
    dueMinor: 12500,
    createdAt: "2026-08-12T09:30:00.000Z",
    ...overrides,
  };
}

type Overrides = {
  modules?: unknown;
  workspace?: unknown;
  inventory?: unknown;
  tax?: unknown;
  post?: (body: Record<string, unknown>) => unknown;
};

function resolve(value: unknown): Response {
  return value instanceof Response ? value : Response.json(value);
}

/**
 * One router for both pages: the module gate, the workspace read, and the
 * governed POST seam that every write funnels through.
 */
function purchasingFetch(overrides: Overrides = {}) {
  const post = (body: Record<string, unknown>) => resolve(overrides.post ? overrides.post(body) : { ok: true, data: {} });
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/modules") return resolve(overrides.modules ?? switchboard);
    if (url === "/api/inventory") return resolve(overrides.inventory ?? { items: [] });
    if (url === "/api/accounting/tax") return resolve(overrides.tax ?? { codes: [] });
    if (url === "/api/purchasing") {
      if (method === "GET") return resolve(overrides.workspace ?? workspaceFixture());
      return post(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    }
    if (url === "/api/capabilities/execute" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        capabilityId?: string;
        input?: Record<string, unknown>;
        intentId?: string;
      };
      if (body.capabilityId !== "purchasing.createVendor" || !body.input) {
        throw new TypeError(`unrouted capability ${body.capabilityId ?? "unknown"}`);
      }
      return post({ ...body.input, action: "createVendor", intentId: body.intentId });
    }
    throw new TypeError(`unrouted ${method} ${url}`);
  });
}

function postedActions(fetchMock: { mock: { calls: unknown[][] } }, action: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST" && Boolean((init as RequestInit).body))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    .filter((body) => body.action === action);
}

function postsTo(fetchMock: ReturnType<typeof purchasingFetch>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    .map((body) => body.capabilityId === "purchasing.createVendor"
      ? { ...(body.input as Record<string, unknown>), action: "createVendor", intentId: body.intentId }
      : body);
}

function capabilityPosts(fetchMock: ReturnType<typeof purchasingFetch>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url) === "/api/capabilities/execute" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

beforeEach(() => {
  window.history.replaceState(null, "", "/purchasing");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* --------------------------------------------------------------- pure money --- */

describe("money stays in integer minor units", () => {
  it("scales by the currency exponent rather than a hardcoded 100", () => {
    expect(parseMinor("USD", "12.34")).toBe(1234);
    expect(parseMinor("BHD", "12.345")).toBe(12345);
    expect(parseMinor("BHD", "12.34")).toBe(12340);
    expect(parseMinor("JPY", "1234")).toBe(1234);
    expect(parseMinor("JPY", "1234.4")).toBe(1234);
  });

  it("rounds from the typed digits so a half cent does not drift down", () => {
    expect(parseMinor("USD", "1.005")).toBe(101);
    expect(parseMinor("USD", "1.004")).toBe(100);
    expect(parseMinor("BHD", "0.0005")).toBe(1);
  });

  it("refuses anything that is not a plain non-negative decimal", () => {
    expect(parseMinor("USD", "")).toBeNull();
    expect(parseMinor("USD", "-5")).toBeNull();
    expect(parseMinor("USD", "1,5")).toBeNull();
    expect(parseMinor("USD", "abc")).toBeNull();
  });

  it("round-trips a due balance into the pay box", () => {
    expect(majorToInput(12345, "BHD")).toBe("12.345");
    expect(majorToInput(12500, "USD")).toBe("125.00");
    expect(parseMinor("BHD", majorToInput(12345, "BHD"))).toBe(12345);
  });

  it("reads quantities as thousandths of a whole unit", () => {
    expect(parseThousandths("2.5")).toBe(2500);
    expect(parseThousandths("")).toBe(0);
    expect(parseThousandths("nope")).toBe(0);
    expect(formatThousandths(2500)).toBe("2.5");
  });
});

/* ------------------------------------------------------------ pure line logic --- */

describe("duplicate line references spend one ordered quantity", () => {
  it("folds repeats of one line into a single summed line", () => {
    expect(aggregateReceiveLines([
      { lineNumber: 1, quantity: 6000 },
      { lineNumber: 1, quantity: 4000 },
    ])).toEqual([{ lineNumber: 1, quantity: 10000 }]);
  });

  it("drops empty lines and returns them in line order", () => {
    expect(aggregateReceiveLines([
      { lineNumber: 3, quantity: 0 },
      { lineNumber: 1, quantity: 500 },
      { lineNumber: 2, quantity: 0 },
      { lineNumber: 3, quantity: 250 },
    ])).toEqual([{ lineNumber: 1, quantity: 500 }, { lineNumber: 3, quantity: 250 }]);
  });

  it("keeps the first stated rejection reason when a line repeats", () => {
    expect(aggregateReceivingLines([
      { lineNumber: 1, quantity: 100, rejected: 0, rejectionNote: "" },
      { lineNumber: 1, quantity: 0, rejected: 50, rejectionNote: "torn stitching" },
    ])).toEqual([{ lineNumber: 1, quantity: 100, rejected: 50, rejectionNote: "torn stitching" }]);
  });
});

describe("three-way matching on a vendor bill", () => {
  it("claims no PO line reference when no PO number is set", () => {
    const { lines, invalid } = buildBillLines([
      { description: "Canvas bags", quantity: "2", unitPrice: "62.50", poLineNumber: "1", taxCodeId: "" },
    ], "USD", false);
    expect(invalid).toBe(0);
    expect(lines).toEqual([{ description: "Canvas bags", quantity: 2000, unitPriceMinor: 6250, poLineNumber: undefined, taxCodeId: undefined }]);
  });

  it("requires a PO line number on every line once a PO is matched", () => {
    const matched = buildBillLines([
      { description: "Canvas bags", quantity: "2", unitPrice: "62.50", poLineNumber: "1", taxCodeId: "" },
    ], "USD", true);
    expect(matched.invalid).toBe(0);
    expect(matched.lines[0]!.poLineNumber).toBe(1);

    const missing = buildBillLines([
      { description: "Canvas bags", quantity: "2", unitPrice: "62.50", poLineNumber: "", taxCodeId: "" },
    ], "USD", true);
    expect(missing.invalid).toBe(1);
    expect(missing.lines[0]!.poLineNumber).toBeUndefined();
  });

  it("treats a zero or non-numeric PO line as no reference", () => {
    const { invalid } = buildBillLines([
      { description: "A", quantity: "1", unitPrice: "1", poLineNumber: "0", taxCodeId: "" },
    ], "USD", true);
    expect(invalid).toBe(1);
  });
});

describe("returns need a stated reason", () => {
  const order = orderFixture([{ lineNumber: 1, description: "Canvas bag", quantity: 10000, unitPriceMinor: 5000 }]);

  it("keeps a line only when it has both a quantity and a reason", () => {
    expect(buildReturnLines({
      1: { qty: "2", reason: "cracked" },
    }, order)).toEqual([{ lineNumber: 1, quantity: 2000, reason: "cracked" }]);

    expect(buildReturnLines({ 1: { qty: "2", reason: "" } }, order)).toEqual([]);
    expect(buildReturnLines({ 1: { qty: "0", reason: "cracked" } }, order)).toEqual([]);
  });
});

describe("receiving prefills from the aggregated rollup", () => {
  it("fills every ordered line with what is still outstanding and no rejection", () => {
    const draft = prefillReceivingDraft(orderFixture([
      { lineNumber: 1, description: "Canvas bag", quantity: 2500, unitPriceMinor: 5000 },
      { lineNumber: 2, description: "Strap", quantity: 1000, unitPriceMinor: 5000 },
    ]), [
      { position: 1, description: "Canvas bag", orderedThousandths: 2500, acceptedThousandths: 1500, rejectedThousandths: 500, returnedThousandths: 0, remainingThousandths: 500 },
      { position: 2, description: "Strap", orderedThousandths: 1000, acceptedThousandths: 0, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1000 },
    ]);

    expect(draft[1]).toEqual({ accepted: "500", rejected: "0", rejectionNote: "" });
    expect(draft[2]).toEqual({ accepted: "1000", rejected: "0", rejectionNote: "" });
  });

  it("starts an untouched line at zero remaining", () => {
    expect(prefillReceivingDraft(orderFixture(), [])[1]).toEqual({ accepted: "0", rejected: "0", rejectionNote: "" });
    expect(formatReceivingThousandths(1500)).toBe("1.5");
  });
});

/* --------------------------------------------------------------- PurchasingPage --- */

describe("PurchasingPage", () => {
  it("opens the tab named in the URL and keeps it shareable", async () => {
    window.history.replaceState(null, "", "/purchasing?tab=bills");
    vi.stubGlobal("fetch", purchasingFetch());
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /Bills & payments/ }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("heading", { name: "Record vendor bill" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /^Vendors/ }));
    expect(window.location.search).toBe("?tab=vendors");
    expect(screen.getByRole("heading", { name: "Vendors" })).toBeTruthy();
  });

  it("falls back to the overview for a tab it does not recognise", async () => {
    window.history.replaceState(null, "", "/purchasing?tab=bogus");
    vi.stubGlobal("fetch", purchasingFetch());
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /^Overview/ }).getAttribute("aria-selected")).toBe("true"));
  });

  it("surfaces a governed 202 as pending, never as a completed write", async () => {
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", true);
    const fetchMock = purchasingFetch({
      post: () => Response.json({ pendingApproval: true, reason: "Over the payment threshold." }, { status: 202 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Vendors/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Harbor Supplies" } });
    fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));

    const pending = await screen.findByText(/is waiting for approval: Over the payment threshold\./);
    expect(pending.closest("[role=status]")).toBeTruthy();
    expect(screen.queryByText(/done\.$/)).toBeNull();
    expect(postsTo(fetchMock)[0]).toMatchObject({ action: "createVendor", name: "Harbor Supplies" });
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.createVendor",
      input: { name: "Harbor Supplies" },
      intentId: expect.any(String),
    });
  });

  it("reports a failed write as an error and keeps the typed draft", async () => {
    vi.stubGlobal("__GO_PURCHASING_VENDOR_SLICE__", true);
    const fetchMock = purchasingFetch({
      post: (body) => (body.action === "createVendor"
        ? Response.json({ error: "Vendor is deactivated." }, { status: 400 })
        : { ok: true, data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Vendors/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Harbor Supplies" } });
    fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Vendor is deactivated.")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Harbor Supplies");
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.createVendor",
      input: { name: "Harbor Supplies" },
      intentId: expect.any(String),
    });
  });

  it("blocks a matched bill that has no PO line reference", async () => {
    const fetchMock = purchasingFetch({ workspace: workspaceFixture({ bills: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));

    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: vendor.id } });
    fireEvent.change(screen.getByLabelText("PO number"), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Canvas bags" } });
    fireEvent.click(screen.getByRole("button", { name: "Record bill" }));

    expect(await screen.findByText(/needs a PO line number on every line/)).toBeTruthy();
    expect(postsTo(fetchMock)).toHaveLength(0);
  });

  it("sends the PO line reference once three-way matching is satisfied", async () => {
    const fetchMock = purchasingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));

    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: vendor.id } });
    fireEvent.change(screen.getByLabelText("PO number"), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Canvas bags" } });
    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "62.50" } });
    fireEvent.change(screen.getByLabelText("PO line #"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Record bill" }));

    await waitFor(() => expect(postsTo(fetchMock)).toHaveLength(1));
    expect(postsTo(fetchMock)[0]).toMatchObject({
      action: "createBill",
      poNumber: 42,
      lines: [{ description: "Canvas bags", quantity: 2000, unitPriceMinor: 6250, poLineNumber: 1 }],
    });
  });

  it("sends one aggregated entry per order line and drops the lines left blank", async () => {
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({
        orders: [orderFixture([
          { lineNumber: 1, description: "Canvas bag", quantity: 10000, unitPriceMinor: 5000 },
          { lineNumber: 2, description: "Strap", quantity: 10000, unitPriceMinor: 5000 },
          { lineNumber: 3, description: "Buckle", quantity: 10000, unitPriceMinor: 5000 },
        ])],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Orders/ }));

    fireEvent.change(screen.getByLabelText("Receive quantity for line 1 of purchase order 42"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Receive quantity for line 2 of purchase order 42"), { target: { value: "4.5" } });
    // Line 3 is deliberately left blank and must not reach the executor.
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    await waitFor(() => expect(postsTo(fetchMock)).toHaveLength(1));
    expect(postsTo(fetchMock)[0]).toMatchObject({
      action: "receiveGoods",
      poNumber: 42,
      lines: [
        { lineNumber: 1, quantity: 6000 },
        { lineNumber: 2, quantity: 4500 },
      ],
    });
  });

  it("refuses to pay more than a bill owes and sends integer minor units", async () => {
    const fetchMock = purchasingFetch({ workspace: workspaceFixture({ bills: [billFixture()] }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));

    const pay = screen.getByRole("button", { name: "Pay" });
    const amount = screen.getByLabelText("Pay amount for bill 7");
    expect((amount as HTMLInputElement).placeholder).toBe("125.00");
    expect((pay as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(amount, { target: { value: "200" } });
    expect((pay as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(amount, { target: { value: "50" } });
    expect((pay as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pay);

    await waitFor(() => expect(postsTo(fetchMock)).toHaveLength(1));
    expect(postsTo(fetchMock)[0]).toMatchObject({ action: "payBill", billNumber: 7, amountMinor: 5000 });
  });

  it("points at the ported reports instead of rebuilding them", async () => {
    vi.stubGlobal("fetch", purchasingFetch());
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    const reports = screen.getByRole("navigation", { name: "Purchasing reports" });
    for (const [label, path] of [
      ["Payment runs", "/purchasing/payment-runs"],
      ["Payables aging", "/purchasing/ap-aging"],
      ["Receipt history", "/purchasing/receipts"],
      ["Receiving desk", "/purchasing/receiving"],
    ] as const) {
      expect(within(reports).getByRole("link", { name: label }).getAttribute("href")).toContain(path);
    }

    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));
    expect(screen.getByRole("link", { name: "Open the full aging report" }).getAttribute("href")).toContain("/purchasing/ap-aging");
    expect(screen.getByRole("link", { name: "Open payment runs" }).getAttribute("href")).toContain("/purchasing/payment-runs");
    // The aging bands and payment runs themselves are not repeated here.
    expect(screen.queryByRole("heading", { name: /31-60 days/ })).toBeNull();
  });

  it("reports an unreachable workspace and retries", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/modules") {
        attempt += 1;
        return attempt === 1
          ? Response.json({ error: "boom" }, { status: 503 })
          : Response.json(switchboard);
      }
      if (url === "/api/purchasing") return Response.json(workspaceFixture());
      if (url === "/api/inventory") return Response.json({ items: [] });
      return Response.json({ codes: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    expect(await screen.findByRole("heading", { name: "Could not load Purchasing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
  });

  it("does not request the workspace when Purchasing is turned off", async () => {
    const fetchMock = purchasingFetch({ modules: { catalog: [{ id: "purchasing" }], enabledModules: [] } });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    expect(await screen.findByRole("heading", { name: "Purchasing is turned off" })).toBeTruthy();
    expect(postsTo(fetchMock)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a real empty state when nothing has been purchased yet", async () => {
    vi.stubGlobal("fetch", purchasingFetch({ workspace: workspaceFixture({ orders: [], vendors: [], bills: [], requests: [] }) }));
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Orders/ }));
    expect(screen.getByRole("heading", { name: "No purchase orders yet" })).toBeTruthy();
  });
});

/* -------------------------------------------------------- PurchasingReceivingPage --- */

describe("PurchasingReceivingPage", () => {
  const receivingOrders = {
    baseCurrency: "USD",
    orders: [orderFixture([
      { lineNumber: 1, description: "Canvas bag", quantity: 2500, unitPriceMinor: 5000 },
      { lineNumber: 2, description: "Strap", quantity: 1000, unitPriceMinor: 5000 },
    ])],
  };

  const rollup = {
    receipts: [],
    orderLines: [
      { position: 1, description: "Canvas bag", orderedThousandths: 2500, acceptedThousandths: 2000, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 500 },
      { position: 2, description: "Strap", orderedThousandths: 1000, acceptedThousandths: 0, rejectedThousandths: 0, returnedThousandths: 0, remainingThousandths: 1000 },
    ],
  };

  function receivingFetch(post?: (body: Record<string, unknown>) => unknown) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json(switchboard);
      if (url === "/api/purchasing" && (init?.method ?? "GET") === "GET") return Response.json(receivingOrders);
      if (url === "/api/purchasing") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.action === "receiptDetail") return Response.json({ ok: true, data: rollup });
        return resolve(post ? post(body) : { ok: true, data: { received: true, fullyReceived: false, receiptNumber: 4 } });
      }
      throw new TypeError(`unrouted ${url}`);
    });
  }

  async function openOrder(fetchMock: ReturnType<typeof receivingFetch>) {
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingReceivingPage />);
    fireEvent.change(await screen.findByLabelText("PO number"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Open order" }));
    await screen.findByRole("heading", { name: /PO 42/ });
  }

  it("prefills every line from the aggregated rollup so partial work resumes", async () => {
    const fetchMock = receivingFetch();
    await openOrder(fetchMock);

    expect((screen.getByLabelText("accepted on line 1") as HTMLInputElement).value).toBe("500");
    expect((screen.getByLabelText("rejected on line 1") as HTMLInputElement).value).toBe("0");
    expect(screen.getByLabelText("accepted on line 2")).toHaveProperty("value", "1000");
    expect(screen.getByText(/accepted so far 2/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No receipts yet" })).toBeTruthy();
  });

  it("refuses to send a receipt with nothing entered", async () => {
    const fetchMock = receivingFetch();
    await openOrder(fetchMock);

    fireEvent.change(screen.getByLabelText("accepted on line 1"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("accepted on line 2")!, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    expect(await screen.findByText(/Nothing to receive/)).toBeTruthy();
    expect(postedActions(fetchMock, "receiveGoods")).toHaveLength(0);
  });

  it("demands a reason before refused goods are recorded", async () => {
    const fetchMock = receivingFetch();
    await openOrder(fetchMock);

    fireEvent.change(screen.getByLabelText("rejected on line 1"), { target: { value: "250" } });
    const reason = await screen.findByLabelText(/rejection reason/i);
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    expect(await screen.findByText(/Line 1 needs a rejection reason/)).toBeTruthy();

    fireEvent.change(reason, { target: { value: "torn stitching" } });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    await waitFor(() => {
      const receipt = postedActions(fetchMock, "receiveGoods")[0];
      expect(receipt).toMatchObject({
        action: "receiveGoods",
        poNumber: 42,
        lines: [
          { lineNumber: 1, quantity: 500, rejected: 250, rejectionNote: "torn stitching" },
          { lineNumber: 2, quantity: 1000, rejected: 0 },
        ],
      });
    });
  });

  it("gates over-receipt on a named authority", async () => {
    const fetchMock = receivingFetch();
    await openOrder(fetchMock);

    fireEvent.change(screen.getByLabelText("tolerance %"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("authorized by"), { target: { value: "site manager, in writing" } });
    fireEvent.change(screen.getByLabelText("accepted on line 1"), { target: { value: "2750" } });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    await waitFor(() => {
      const receipt = postedActions(fetchMock, "receiveGoods")[0];
      expect(receipt).toMatchObject({ overreceiptTolerancePct: 10, authorityReason: "site manager, in writing" });
    });
  });

  it("surfaces a 202 as pending rather than a recorded receipt", async () => {
    const fetchMock = receivingFetch(() => Response.json({ pendingApproval: true, reason: "Overreceipt needs a second approver." }, { status: 202 }));
    await openOrder(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    expect(await screen.findByText(/Overreceipt needs a second approver/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Receipt \d+$/ })).toBeNull();
  });

  it("confirms a recorded receipt and says what is still expected", async () => {
    const fetchMock = receivingFetch(() => ({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 4 } }));
    await openOrder(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    expect(await screen.findByText(/Receipt 4 recorded\. Everything ordered is now on the books\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Receipt 4" })).toBeTruthy();
  });

  it("refuses an order number that is not one of this team's", async () => {
    const fetchMock = receivingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingReceivingPage />);

    fireEvent.change(await screen.findByLabelText("PO number"), { target: { value: "999" } });
    fireEvent.click(screen.getByRole("button", { name: "Open order" }));

    expect(await screen.findByText(/No order number 999/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /PO 999/ })).toBeNull();
  });

  it("does not request orders when Purchasing is turned off", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ catalog: [{ id: "purchasing" }], enabledModules: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingReceivingPage />);

    expect(await screen.findByRole("heading", { name: "Purchasing is turned off" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
