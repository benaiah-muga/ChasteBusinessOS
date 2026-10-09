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
  const post = async (body: Record<string, unknown>) => resolve(await (overrides.post ? overrides.post(body) : { ok: true, data: {} }));
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
      if ((body.capabilityId !== "purchasing.createVendor" && body.capabilityId !== "purchasing.createPurchaseOrder" && body.capabilityId !== "purchasing.returnGoods" && body.capabilityId !== "purchasing.closePurchaseOrder" && body.capabilityId !== "purchasing.createBill" && body.capabilityId !== "purchasing.payBill" && body.capabilityId !== "purchasing.billCreditNote" && body.capabilityId !== "purchasing.createPurchaseRequest" && body.capabilityId !== "purchasing.decidePurchaseRequest" && body.capabilityId !== "purchasing.createRfq" && body.capabilityId !== "purchasing.recordQuote" && body.capabilityId !== "purchasing.selectWinningQuote" && body.capabilityId !== "purchasing.supplierStatement") || !body.input) {
        throw new TypeError(`unrouted capability ${body.capabilityId ?? "unknown"}`);
      }
      const action = body.capabilityId === "purchasing.createVendor" ? "createVendor"
        : body.capabilityId === "purchasing.createPurchaseOrder" ? "createPurchaseOrder"
          : body.capabilityId === "purchasing.returnGoods" ? "returnGoods"
            : body.capabilityId === "purchasing.closePurchaseOrder" ? "closePurchaseOrder"
              : body.capabilityId === "purchasing.createBill" ? "createBill"
                : body.capabilityId === "purchasing.billCreditNote" ? "billCreditNote"
                  : body.capabilityId === "purchasing.createPurchaseRequest" ? "createPurchaseRequest"
                    : body.capabilityId === "purchasing.decidePurchaseRequest" ? "decidePurchaseRequest"
                      : body.capabilityId === "purchasing.createRfq" ? "createRfq"
                        : body.capabilityId === "purchasing.recordQuote" ? "recordQuote"
                          : body.capabilityId === "purchasing.selectWinningQuote" ? "selectWinningQuote"
                            : body.capabilityId === "purchasing.supplierStatement" ? "supplierStatement" : "payBill";
      return post({ ...body.input, action, intentId: body.intentId });
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
      : body.capabilityId === "purchasing.createPurchaseOrder"
        ? { ...(body.input as Record<string, unknown>), action: "createPurchaseOrder", intentId: body.intentId }
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
  it("loads the selected supplier statement through the Go capability", async () => {
    vi.stubGlobal("__GO_PURCHASING_SUPPLIER_STATEMENT_READS__", true);
    const fetchMock = purchasingFetch({
      post: (body) => body.action === "supplierStatement"
        ? { ok: true, data: {
          closingBalanceMinor: 12500,
          rows: [{ date: "2026-08-12T09:30:00.000Z", kind: "bill", ref: "Bill #7", amountMinor: 12500, balanceMinor: 12500 }],
        } }
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-statement" organizationId="org-statement" />);

    fireEvent.click(await screen.findByRole("tab", { name: /^Prices & statements/ }));
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: vendor.id } });
    fireEvent.click(screen.getByRole("button", { name: "Load statement" }));
    expect(await screen.findByText("Bill #7")).toBeTruthy();
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.supplierStatement",
      input: { vendorId: vendor.id },
      intentId: expect.any(String),
    });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/purchasing" && init?.method === "POST")).toBe(false);
  });

  it("keeps the purchase request draft when Go returns an approval pending response", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const fetchMock = purchasingFetch({
      post: (body) => body.action === "createPurchaseRequest"
        ? Response.json({ pendingApproval: true, reason: "Reviewer approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-sourcing-page" organizationId="org-sourcing-page" />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    fireEvent.change(screen.getByLabelText("What needs buying"), { target: { value: "Packaging stock" } });
    fireEvent.change(screen.getByLabelText("Justification"), { target: { value: "Stock will run out before confirmed orders ship." } });
    fireEvent.change(screen.getByLabelText("Estimate (optional, USD)"), { target: { value: "42.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));

    expect(await screen.findByText(/is waiting for approval: Reviewer approval required\./)).toBeTruthy();
    expect((screen.getByLabelText("What needs buying") as HTMLInputElement).value).toBe("Packaging stock");
    expect((screen.getByLabelText("Justification") as HTMLTextAreaElement).value).toBe("Stock will run out before confirmed orders ship.");
    expect((screen.getByLabelText("Estimate (optional, USD)") as HTMLInputElement).value).toBe("42.00");
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.createPurchaseRequest",
      input: { title: "Packaging stock", justification: "Stock will run out before confirmed orders ship.", estimatedAmountMinor: 4200 },
      intentId: expect.any(String),
    });
  });

  it("restores the exact scoped sourcing draft and intent after a pending request reload", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const fetchMock = purchasingFetch({
      post: (body) => body.action === "createPurchaseRequest"
        ? Response.json({ pendingApproval: true, reason: "Reviewer approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: "actor-sourcing-reload", organizationId: "org-sourcing-reload" };
    const firstPage = render(<PurchasingPage {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    fireEvent.change(screen.getByLabelText("What needs buying"), { target: { value: "Packaging stock" } });
    fireEvent.change(screen.getByLabelText("Justification"), { target: { value: "Stock will run out before confirmed orders ship." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await screen.findByText(/is waiting for approval/);
    const originalIntent = capabilityPosts(fetchMock)[0]?.intentId;
    firstPage.unmount();

    render(<PurchasingPage {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    expect((screen.getByLabelText("What needs buying") as HTMLInputElement).value).toBe("Packaging stock");
    expect((screen.getByLabelText("Justification") as HTMLTextAreaElement).value).toBe("Stock will run out before confirmed orders ship.");
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(capabilityPosts(fetchMock)).toHaveLength(2));
    expect(capabilityPosts(fetchMock)[1]?.intentId).toBe(originalIntent);
  });

  it("restores a pending quote amount and notes with the original intent after reload", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Packaging stock",
      justification: "Stock is low before the next shipment.",
      estimatedAmountMinor: null,
      status: "approved",
      decisionReason: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      rfqs: [{ id: "22222222-2222-4222-8222-222222222222", vendorName: "Harbor Supplies", status: "sent", quoteAmountMinor: null, quoteLeadTimeDays: null, quoteNotes: null }],
    };
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ requests: [request] }),
      post: (body) => body.action === "recordQuote"
        ? Response.json({ pendingApproval: true, reason: "Quote approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { actorId: "actor-quote-reload", organizationId: "org-quote-reload" };
    const firstPage = render(<PurchasingPage {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    fireEvent.change(screen.getByLabelText("Quote amount from Harbor Supplies"), { target: { value: "42.50" } });
    fireEvent.change(screen.getByLabelText("Quote notes from Harbor Supplies"), { target: { value: "Freight included" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Quote approval required\./);
    const originalIntent = capabilityPosts(fetchMock)[0]?.intentId;
    firstPage.unmount();

    render(<PurchasingPage {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    expect((screen.getByLabelText("Quote amount from Harbor Supplies") as HTMLInputElement).value).toBe("42.50");
    expect((screen.getByLabelText("Quote notes from Harbor Supplies") as HTMLInputElement).value).toBe("Freight included");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(capabilityPosts(fetchMock)).toHaveLength(2));
    expect(capabilityPosts(fetchMock)[1]).toMatchObject({
      intentId: originalIntent,
      input: { amountMinor: 4250, notes: "Freight included" },
    });
  });

  it("clears sourcing drafts when scope is unavailable and hashes scope storage keys", async () => {
    const fetchMock = purchasingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const page = render(<PurchasingPage actorId="scope-secret-actor" organizationId="scope-secret-org-a" />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    fireEvent.change(screen.getByLabelText("What needs buying"), { target: { value: "Private draft" } });
    await waitFor(() => expect(Object.keys(window.localStorage).some((key) => key.includes("scope-secret-actor") || key.includes("scope-secret-org-a"))).toBe(false));
    page.rerender(<PurchasingPage actorId="scope-secret-actor" organizationId={null} />);
    await waitFor(() => expect((screen.getByLabelText("What needs buying") as HTMLInputElement).value).toBe(""));
    page.rerender(<PurchasingPage actorId="scope-secret-actor" organizationId="scope-secret-org-b" />);
    await waitFor(() => expect((screen.getByLabelText("What needs buying") as HTMLInputElement).value).toBe(""));
  });

  it("blocks Go sourcing writes until the scope hash and saved draft are hydrated", async () => {
    const props = { actorId: "actor-hydration-gate", organizationId: "org-hydration-gate" };
    const scopeIdentity = JSON.stringify(props);
    const storedDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scopeIdentity));
    const digestHex = Array.from(new Uint8Array(storedDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(`chaste.purchasing.sourcing.draft.v1:${digestHex}`, JSON.stringify({
      requestForm: { title: "Restored request", justification: "Saved justification for the migration gate.", estimate: "" },
      rfqPick: {},
      quoteDraft: {},
      rejectFor: null,
      rejectReason: "",
    }));
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const fetchMock = purchasingFetch({
      post: (body) => body.action === "createPurchaseRequest"
        ? Response.json({ pendingApproval: true, reason: "Approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    let resolveDigest: ((value: ArrayBuffer) => void) | undefined;
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(() => new Promise((resolve) => { resolveDigest = resolve; }));
    window.history.replaceState(null, "", "/purchasing?tab=requests");
    render(<PurchasingPage {...props} />);
    const submit = await screen.findByRole("button", { name: "Submit request" });
    expect((screen.getByLabelText("What needs buying") as HTMLInputElement).disabled).toBe(true);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(capabilityPosts(fetchMock)).toHaveLength(0);

    resolveDigest?.(new Uint8Array(storedDigest).slice().buffer);
    digestSpy.mockRestore();
    await waitFor(() => expect((screen.getByLabelText("What needs buying") as HTMLInputElement).value).toBe("Restored request"));
    expect((screen.getByLabelText("What needs buying") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Submit request" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(capabilityPosts(fetchMock)).toHaveLength(1));
  });

  it("fails closed when scoped sourcing draft persistence fails", async () => {
    const props = { actorId: "actor-storage-failure", organizationId: "org-storage-failure" };
    const scopeDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(props)));
    const hex = Array.from(new Uint8Array(scopeDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const draftKey = `chaste.purchasing.sourcing.draft.v1:${hex}`;
    window.localStorage.setItem(draftKey, JSON.stringify({
      requestForm: { title: "Saved request", justification: "Enough detail to submit this request.", estimate: "" },
      rfqPick: {},
      quoteDraft: {},
      rejectFor: null,
      rejectReason: "",
    }));
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const fetchMock = purchasingFetch();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/purchasing?tab=requests");
    render(<PurchasingPage {...props} />);
    await waitFor(() => expect((screen.getByLabelText("What needs buying") as HTMLInputElement).value).toBe("Saved request"));
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("chaste.purchasing.sourcing.draft.v1:")) throw new DOMException("Storage full", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });
    fireEvent.change(screen.getByLabelText("What needs buying"), { target: { value: "Changed while storage is full" } });
    await screen.findByText(/Browser storage could not retain this scoped sourcing draft/);
    const submit = screen.getByRole("button", { name: "Submit request" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(capabilityPosts(fetchMock)).toHaveLength(0);
    setItemSpy.mockRestore();
  });

  it("shows invalid estimate input instead of silently omitting it", async () => {
    const fetchMock = purchasingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    fireEvent.change(screen.getByLabelText("What needs buying"), { target: { value: "Packaging stock" } });
    fireEvent.change(screen.getByLabelText("Justification"), { target: { value: "Stock will run out before confirmed orders ship." } });
    fireEvent.change(screen.getByLabelText("Estimate (optional, USD)"), { target: { value: "12,5" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a valid non-negative estimate");
    expect(postedActions(fetchMock, "createPurchaseRequest")).toHaveLength(0);
  });

  it("uses the workspace currency and carries optional quote notes", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Packaging stock",
      justification: "Stock is low before the next shipment.",
      estimatedAmountMinor: 1200,
      status: "approved",
      decisionReason: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      rfqs: [{ id: "22222222-2222-4222-8222-222222222222", vendorName: "Harbor Supplies", status: "sent", quoteAmountMinor: null, quoteLeadTimeDays: null, quoteNotes: null }],
    };
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ baseCurrency: "JPY", requests: [request] }),
      post: (body) => body.action === "recordQuote" ? { ok: true, data: { status: "quoted" } } : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-sourcing-currency" organizationId="org-sourcing-currency" />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    expect(screen.getByText(/Estimated/).textContent).toContain("¥");
    fireEvent.change(screen.getByLabelText("Quote amount from Harbor Supplies"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Quote notes from Harbor Supplies"), { target: { value: "Freight included" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.recordQuote",
      input: { amountMinor: 12, notes: "Freight included" },
    }));
  });

  it("caps RFQ selection at ten and clears the selection after success", async () => {
    vi.stubGlobal("__GO_PURCHASING_SOURCING_WRITES__", true);
    const vendors = Array.from({ length: 11 }, (_, index) => ({
      ...vendor,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `Supplier ${index + 1}`,
    }));
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Packaging stock",
      justification: "Stock is low before the next shipment.",
      estimatedAmountMinor: null,
      status: "approved",
      decisionReason: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      rfqs: [],
    };
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ vendors, requests: [request] }),
      post: (body) => body.action === "createRfq" ? { ok: true, data: { rfqIds: ["22222222-2222-4222-8222-222222222222"] } } : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-sourcing-rfq" organizationId="org-sourcing-rfq" />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Requests & RFQs/ }));
    for (let index = 1; index <= 10; index += 1) fireEvent.click(screen.getByLabelText(`Supplier ${index}`));
    expect((screen.getByLabelText("Supplier 11") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send RFQs (10)" }));
    await waitFor(() => expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.createRfq",
      input: { vendorIds: vendors.slice(0, 10).map((entry) => entry.id) },
    }));
    await waitFor(() => expect((screen.getByLabelText("Supplier 1") as HTMLInputElement).checked).toBe(false));
    expect(screen.getByRole("button", { name: "Send RFQs (0)" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps the PO draft and stable Go intent while approval is pending, then clears on success", async () => {
    vi.stubGlobal("__GO_PURCHASING_CREATE_ORDER__", true);
    let attempt = 0;
    const fetchMock = purchasingFetch({ post: () => {
      attempt += 1;
      return attempt === 1
        ? Response.json({ pendingApproval: true, reason: "Manager approval required." }, { status: 202 })
        : Response.json({ ok: true, data: { poNumber: 42 } });
    } });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-1" organizationId="org-1" />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Orders/ }));
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: vendor.id } });
    fireEvent.change(screen.getByLabelText("Memo (optional)"), { target: { value: "March stock" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Canvas bag" } });
    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    expect(await screen.findByText(/is waiting for approval: Manager approval required\./)).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Canvas bag");
    const pendingPost = capabilityPosts(fetchMock)[0]!;
    expect(pendingPost).toMatchObject({
      capabilityId: "purchasing.createPurchaseOrder",
      input: { vendorId: vendor.id, memo: "March stock", lines: [{ description: "Canvas bag", quantity: 2500, unitPriceMinor: 0 }] },
      intentId: expect.any(String),
    });

    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    await screen.findByText(/Draft order done\./);
    expect(capabilityPosts(fetchMock)[1]?.intentId).toBe(pendingPost.intentId);
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("");
  });

  it("blocks zero quantities and malformed prices before sending a purchase order", async () => {
    const fetchMock = purchasingFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Orders/ }));
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: vendor.id } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Canvas bag" } });
    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    expect((await screen.findByRole("alert")).textContent).toContain("quantity greater than zero");
    expect(postsTo(fetchMock).filter((body) => body.action === "createPurchaseOrder")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    expect((await screen.findByRole("alert")).textContent).toContain("valid non-negative unit price");
    expect(postsTo(fetchMock).filter((body) => body.action === "createPurchaseOrder")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));
    expect((await screen.findByRole("alert")).textContent).toContain("valid non-negative unit price");
    expect(postsTo(fetchMock).filter((body) => body.action === "createPurchaseOrder")).toHaveLength(0);
  });

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
    render(<PurchasingPage actorId="actor-1" organizationId="org-1" />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Open POs/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Vendors/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Harbor Supplies" } });
    fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));

    const pending = await screen.findByText(/is waiting for approval: Over the payment threshold\./);
    expect(pending.closest("[role=status]")).toBeTruthy();
    expect(screen.queryByText(/done\.$/)).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Harbor Supplies");
    expect(postsTo(fetchMock)[0]).toMatchObject({ action: "createVendor", name: "Harbor Supplies" });
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.createVendor",
      input: { name: "Harbor Supplies" },
      intentId: expect.any(String),
    });
  });

  it("retains vendor and bill form drafts while finance capabilities await approval", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const fetchMock = purchasingFetch({
      post: (body) => body.action === "createBill"
        ? Response.json({ pendingApproval: true, reason: "Bill approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-finance" organizationId="org-finance" />);
    await screen.findByRole("button", { name: /Open POs/ });
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: vendor.id } });
    fireEvent.change(screen.getByLabelText("Their ref"), { target: { value: "INV-FA-8" } });
    fireEvent.change(screen.getByPlaceholderText("Line 1 description"), { target: { value: "Replacement part" } });
    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "25.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Record bill" }));

    expect(await screen.findByText(/is waiting for approval: Bill approval required\./)).toBeTruthy();
    expect((screen.getByLabelText("Vendor") as HTMLSelectElement).value).toBe(vendor.id);
    expect((screen.getByLabelText("Their ref") as HTMLInputElement).value).toBe("INV-FA-8");
    expect((screen.getByPlaceholderText("Line 1 description") as HTMLInputElement).value).toBe("Replacement part");
    expect((screen.getByLabelText("Qty") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Unit price") as HTMLInputElement).value).toBe("25.00");
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.createBill",
      input: { vendorId: vendor.id, vendorRef: "INV-FA-8", lines: [{ description: "Replacement part", quantity: 1000, unitPriceMinor: 2500 }] },
      intentId: expect.any(String),
    });
  });

  it("retains the payment amount while Go approval is pending", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ bills: [billFixture()] }),
      post: (body) => body.action === "payBill"
        ? Response.json({ pendingApproval: true, reason: "Payment approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-finance" organizationId="org-finance" />);
    await screen.findByRole("button", { name: /Open POs/ });
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));
    const amount = screen.getByLabelText("Pay amount for bill 7");
    fireEvent.change(amount, { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));

    expect(await screen.findByText(/is waiting for approval: Payment approval required\./)).toBeTruthy();
    expect((screen.getByLabelText("Pay amount for bill 7") as HTMLInputElement).value).toBe("50");
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.payBill",
      input: { billNumber: 7, amountMinor: 5000 },
      intentId: expect.any(String),
    });
  });

  it("retains the credit target and form while a Go bill credit awaits approval", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ bills: [billFixture()] }),
      post: (body) => body.action === "billCreditNote"
        ? Response.json({ pendingApproval: true, reason: "Credit approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-finance" organizationId="org-finance" />);
    await screen.findByRole("button", { name: /Open POs/ });
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Credit" }));
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "50" } });
    const reason = screen.getByPlaceholderText("e.g. damaged goods on delivery");
    fireEvent.change(reason, { target: { value: "Damaged delivery" } });
    expect((reason as HTMLInputElement).maxLength).toBe(500);
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));

    expect(await screen.findByText(/is waiting for approval: Credit approval required\./)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Credit bill #7" })).toBeTruthy();
    expect((screen.getByLabelText("Amount (USD)") as HTMLInputElement).value).toBe("50");
    expect((screen.getByPlaceholderText("e.g. damaged goods on delivery") as HTMLInputElement).value).toBe("Damaged delivery");
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.billCreditNote",
      input: { billId: billFixture().id, amountMinor: 5000, reason: "Damaged delivery" },
      intentId: expect.any(String),
    });
  });

  it("restores and retries the exact unresolved credit after closing and reopening its dialog", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const entryId = "2b8d2b2f-0d4b-4a2b-8c3a-4a2b3c4d5e6f";
    let creditCalls = 0;
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ bills: [billFixture()] }),
      post: (body) => {
        if (body.action !== "billCreditNote") return { ok: true, data: {} };
        creditCalls += 1;
        return creditCalls === 1
          ? Response.json({ pendingApproval: true, reason: "Credit approval required." }, { status: 202 })
          : Response.json({ ok: true, data: { entryId, creditedMinor: 5000, billBalanceMinor: 7500 } });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-credit-reopen" organizationId="org-credit-reopen" />);
    await screen.findByRole("button", { name: /Open POs/ });
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Credit" }));
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. damaged goods on delivery"), { target: { value: "Damaged delivery" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));
    expect(await screen.findByText(/is waiting for approval: Credit approval required\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Credit bill #7" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Credit" }));
    expect((screen.getByLabelText("Amount (USD)") as HTMLInputElement).value).toBe("50");
    expect((screen.getByPlaceholderText("e.g. damaged goods on delivery") as HTMLInputElement).value).toBe("Damaged delivery");
    expect((screen.getByLabelText("Amount (USD)") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));

    expect(await screen.findByText("Credit bill #7 done.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Credit bill #7" })).toBeNull();
    const attempts = capabilityPosts(fetchMock).filter((body) => body.capabilityId === "purchasing.billCreditNote");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ input: { billId: billFixture().id, amountMinor: 5000, reason: "Damaged delivery" } });
    expect(attempts[1]).toMatchObject({ input: attempts[0]?.input, intentId: attempts[0]?.intentId });
  });

  it("keeps a scope preflight failure editable because no request was sent", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    const fetchMock = purchasingFetch({ workspace: workspaceFixture({ bills: [billFixture()] }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId={null} organizationId="org-credit-preflight" />);
    await screen.findByRole("button", { name: /Open POs/ });
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Credit" }));
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. damaged goods on delivery"), { target: { value: "Damaged delivery" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));

    expect(await screen.findByText(/Wait for your account and organization to finish loading/)).toBeTruthy();
    const amount = screen.getByLabelText("Amount (USD)") as HTMLInputElement;
    const reason = screen.getByPlaceholderText("e.g. damaged goods on delivery") as HTMLInputElement;
    expect(amount.disabled).toBe(false);
    expect(reason.disabled).toBe(false);
    fireEvent.change(reason, { target: { value: "Wrong item received" } });
    expect(reason.value).toBe("Wrong item received");
    expect(capabilityPosts(fetchMock)).toHaveLength(0);
  });

  it("keeps the submitted credit snapshot when a response is delayed", async () => {
    vi.stubGlobal("__GO_PURCHASING_FINANCE_WRITES__", true);
    let resolveCredit!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { resolveCredit = resolve; });
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ bills: [billFixture()] }),
      post: (body) => body.action === "billCreditNote"
        ? delayed
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-credit-delay" organizationId="org-credit-delay" />);
    await screen.findByRole("button", { name: /Open POs/ });
    fireEvent.click(screen.getByRole("tab", { name: /Bills & payments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Credit" }));
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. damaged goods on delivery"), { target: { value: "Damaged delivery" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply credit" }));

    const amount = screen.getByLabelText("Amount (USD)") as HTMLInputElement;
    const reason = screen.getByPlaceholderText("e.g. damaged goods on delivery") as HTMLInputElement;
    await waitFor(() => expect(amount.disabled).toBe(true));
    expect(amount.disabled).toBe(true);
    expect(reason.disabled).toBe(true);
    fireEvent.change(amount, { target: { value: "99" } });
    fireEvent.change(reason, { target: { value: "Changed during submission" } });
    resolveCredit(Response.json({ pendingApproval: true, reason: "Credit approval required." }, { status: 202 }));

    expect(await screen.findByText(/is waiting for approval: Credit approval required\./)).toBeTruthy();
    expect(amount.value).toBe("50");
    expect(reason.value).toBe("Damaged delivery");
    const attempt = capabilityPosts(fetchMock)[0];
    expect(attempt).toMatchObject({ input: { amountMinor: 5000, reason: "Damaged delivery" }, capabilityId: "purchasing.billCreditNote" });
  });

  it("retains the return dialog and exact draft while Go approval is pending", async () => {
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", true);
    const receivedOrder = { ...orderFixture(), status: "received" };
    const fetchMock = purchasingFetch({
      workspace: workspaceFixture({ orders: [receivedOrder] }),
      post: (body) => body.action === "returnGoods"
        ? Response.json({ pendingApproval: true, reason: "Approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-1" organizationId="org-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Orders/ }));
    await screen.findByText("Canvas bag");
    fireEvent.click(screen.getAllByRole("button", { name: "Return goods" })[0]!);
    expect((screen.getByLabelText("Reason for line 1") as HTMLInputElement).maxLength).toBe(500);
    fireEvent.change(screen.getByLabelText("Return quantity for line 1"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Reason for line 1"), { target: { value: "damaged" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Return goods" })[1]!);

    expect(await screen.findByText(/is waiting for approval: Approval required\./)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Return goods against PO #42" })).toBeTruthy();
    expect((screen.getByLabelText("Return quantity for line 1") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Reason for line 1") as HTMLInputElement).value).toBe("damaged");
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.returnGoods",
      input: { poNumber: 42, lines: [{ lineNumber: 1, quantity: 1000, reason: "damaged" }] },
      intentId: expect.any(String),
    });
  });

  it("retains the close confirmation while Go approval is pending", async () => {
    vi.stubGlobal("__GO_PURCHASING_RETURN_CLOSE__", true);
    const fetchMock = purchasingFetch({
      post: (body) => body.action === "closePurchaseOrder"
        ? Response.json({ pendingApproval: true, reason: "Manager approval required." }, { status: 202 })
        : { ok: true, data: {} },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingPage actorId="actor-2" organizationId="org-2" />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Orders/ }));
    await screen.findByText("Canvas bag");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close order" }));

    expect(await screen.findByText(/is waiting for approval: Manager approval required\./)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Close PO #42?" })).toBeTruthy();
    expect(capabilityPosts(fetchMock)[0]).toMatchObject({
      capabilityId: "purchasing.closePurchaseOrder",
      input: { poNumber: 42 },
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
    render(<PurchasingPage actorId="actor-vendor" organizationId="org-vendor" />);

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
    let latestRollup = rollup;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/modules") return Response.json(switchboard);
      if (url === "/api/purchasing" && (init?.method ?? "GET") === "GET") return Response.json(receivingOrders);
      if (url === "/api/capabilities/execute" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { capabilityId?: string; input?: Record<string, unknown>; intentId?: string };
        if (body.capabilityId !== "purchasing.receiveGoods" || !body.input) throw new TypeError(`unrouted capability ${body.capabilityId ?? "unknown"}`);
        return resolve(post ? post({ ...body.input, action: "receiveGoods", intentId: body.intentId }) : { ok: true, data: { received: true, fullyReceived: false, receiptNumber: 4 } });
      }
      if (url === "/api/purchasing") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.action === "receiptDetail") return Response.json({ ok: true, data: latestRollup });
        const response = resolve(post ? post(body) : { ok: true, data: { received: true, fullyReceived: false, receiptNumber: 4 } });
        if (body.action === "receiveGoods" && response.status !== 202 && Array.isArray(body.lines)) {
          const acceptedByLine = new Map((body.lines as Array<{ lineNumber: number; quantity: number }>).map((line) => [line.lineNumber, line.quantity]));
          latestRollup = {
            ...rollup,
            orderLines: rollup.orderLines.map((line) => ({
              ...line,
              acceptedThousandths: line.acceptedThousandths + (acceptedByLine.get(line.position) ?? 0),
              remainingThousandths: Math.max(0, line.remainingThousandths - (acceptedByLine.get(line.position) ?? 0)),
            })),
          };
        }
        return response;
      }
      throw new TypeError(`unrouted ${url}`);
    });
  }

  async function openOrder(fetchMock: ReturnType<typeof receivingFetch>, scope?: { actorId: string; organizationId: string }) {
    vi.stubGlobal("fetch", fetchMock);
    render(<PurchasingReceivingPage actorId={scope?.actorId} organizationId={scope?.organizationId} />);
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

  it("keeps the receipt draft and Go intent while approval is pending, then retries with that intent", async () => {
    vi.stubGlobal("__GO_PURCHASING_RECEIVE_GOODS__", true);
    let attempt = 0;
    const fetchMock = receivingFetch(() => {
      attempt += 1;
      return attempt === 1
        ? Response.json({ pendingApproval: true, reason: "Manager approval required." }, { status: 202 })
        : { ok: true, data: { received: true, fullyReceived: false, receiptNumber: 5 } };
    });
    await openOrder(fetchMock, { actorId: "actor-1", organizationId: "org-1" });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    expect(await screen.findByText(/Manager approval required/)).toBeTruthy();
    expect((screen.getByLabelText("accepted on line 1") as HTMLInputElement).value).toBe("500");
    const capabilityPosts = () => fetchMock.mock.calls
      .filter(([url, init]) => String(url) === "/api/capabilities/execute" && (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    const first = capabilityPosts()[0]!;
    expect(first).toMatchObject({
      capabilityId: "purchasing.receiveGoods",
      input: { poNumber: 42, lines: [{ lineNumber: 1, quantity: 500, rejected: 0 }, { lineNumber: 2, quantity: 1000, rejected: 0 }] },
      intentId: expect.any(String),
    });

    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    expect(await screen.findByText(/Receipt 5 recorded/)).toBeTruthy();
    expect(capabilityPosts()[1]?.intentId).toBe(first.intentId);
  });

  it("blocks out-of-range quantities and too-short overreceipt reasons before submission", async () => {
    const fetchMock = receivingFetch();
    await openOrder(fetchMock);
    fireEvent.change(screen.getByLabelText("accepted on line 1"), { target: { value: "2147483648" } });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    expect(await screen.findByText(/supported range/)).toBeTruthy();
    expect(postedActions(fetchMock, "receiveGoods")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("accepted on line 1"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("tolerance %"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("authorized by"), { target: { value: "manager" } });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    expect(await screen.findByText(/authority reason between 10 and 500/)).toBeTruthy();
    expect(postedActions(fetchMock, "receiveGoods")).toHaveLength(0);
  });

  it("confirms a recorded receipt and says what is still expected", async () => {
    const fetchMock = receivingFetch(() => ({ ok: true, data: { received: true, fullyReceived: true, receiptNumber: 4 } }));
    await openOrder(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));

    expect(await screen.findByText(/Receipt 4 recorded\. Everything ordered is now on the books\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Receipt 4" })).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("accepted on line 1") as HTMLInputElement).value).toBe("0"));
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    expect(await screen.findByText(/Nothing to receive/)).toBeTruthy();
    expect(postedActions(fetchMock, "receiveGoods")).toHaveLength(1);
  });

  it("does not resubmit a partial receipt after success until the quantity is deliberately entered again", async () => {
    const fetchMock = receivingFetch(() => ({ ok: true, data: { received: true, fullyReceived: false, receiptNumber: 6 } }));
    await openOrder(fetchMock);

    fireEvent.change(screen.getByLabelText("accepted on line 1"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    expect(await screen.findByText(/Receipt 6 recorded/)).toBeTruthy();
    expect((screen.getByLabelText("accepted on line 1") as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText("rejected on line 1") as HTMLInputElement).value).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    expect(await screen.findByText(/Nothing to receive/)).toBeTruthy();
    expect(postedActions(fetchMock, "receiveGoods")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("accepted on line 1"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }));
    await waitFor(() => expect(postedActions(fetchMock, "receiveGoods")).toHaveLength(2));
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
