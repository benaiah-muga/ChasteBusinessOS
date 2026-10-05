import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPrintInvoice, dueDate, formatMoney, issueDate, lineAmountMinor, subtotalMinor, taxMinor } from "./print-invoice";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const validInvoice = {
  order: {
    number: 1042,
    status: "sent",
    note: null,
    createdAt: "2026-03-04T10:00:00.000Z",
    customerName: "Acme",
    customerEmail: null,
    paymentTermDays: 30,
    orgName: "Acme Trading",
  },
  lines: [
    { description: "Widget", quantity: 2000, unitPriceMinor: 1250, taxMinor: 100 },
    { description: "Service", quantity: 1000, unitPriceMinor: 5000, taxMinor: 200 },
  ],
  branding: { logoDataUrl: null, accentColor: "#112233", invoiceFooter: "Thanks", layout: "modern" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invoice math", () => {
  it("derives a line amount from thousandths quantity and minor unit price", () => {
    expect(lineAmountMinor(validInvoice.lines[0]!)).toBe(2500);
    expect(lineAmountMinor(validInvoice.lines[1]!)).toBe(5000);
  });

  it("sums subtotal and tax independently, keeping money in minor units", () => {
    expect(subtotalMinor(validInvoice.lines)).toBe(7500);
    expect(taxMinor(validInvoice.lines)).toBe(300);
  });

  it("rounds each line the same way as invoice posting", () => {
    const halfMinorLines = [
      { description: "A", quantity: 1, unitPriceMinor: 500, taxMinor: 0 },
      { description: "B", quantity: 1, unitPriceMinor: 500, taxMinor: 0 },
    ];
    expect(lineAmountMinor(halfMinorLines[0]!)).toBe(1);
    expect(subtotalMinor(halfMinorLines)).toBe(2);
  });

  it("treats an absent payment term as due on issue", () => {
    expect(dueDate("2026-03-04T10:00:00.000Z", null)).toBe("On issue");
    expect(dueDate("2026-03-04T10:00:00.000Z", 0)).toBe("On issue");
    expect(dueDate("2026-03-04T10:00:00.000Z", 30)).toBe("2026-04-03");
  });

  it("formats minor units with two decimals and grouping", () => {
    expect(formatMoney(7500)).toBe("75.00");
    expect(formatMoney(1234567)).toBe("12,345.67");
  });

  it("reads the issue date as a plain day", () => {
    expect(issueDate("2026-03-04T10:00:00.000Z")).toBe("2026-03-04");
  });
});

describe("fetchPrintInvoice", () => {
  it("requests the org-scoped order projection", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(validInvoice));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPrintInvoice("order-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/sales/order-1", expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
    }));
    expect(result.status).toBe("ok");
  });

  it("encodes order ids as one path segment", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(validInvoice));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPrintInvoice("order/with space");

    expect(fetchMock).toHaveBeenCalledWith("/api/sales/order%2Fwith%20space", expect.any(Object));
  });

  it("maps an unauthenticated response to a sign-in prompt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("unauthorized");
  });

  it("maps the legacy not-found envelope to not-found on a 200", async () => {
    // The legacy print page answered 200 with this body as page text, so the
    // wire contract must keep working that way.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Invoice not found." }, 200)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("not-found");
  });

  it("maps a 404 status to not-found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Invoice not found." }, 404)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("not-found");
  });

  it("refuses an empty order id without calling the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchPrintInvoice("")).status).toBe("not-found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed body rather than rendering partial money", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ order: { number: 1 }, lines: [] })));
    const result = await fetchPrintInvoice("order-1");
    expect(result.status).toBe("error");
  });

  it("fails closed on a fractional money value", async () => {
    const broken = structuredClone(validInvoice);
    broken.lines[0]!.unitPriceMinor = 12.5;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(broken)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("error");
  });

  it("fails closed when quantity or a total is outside the safe integer range", async () => {
    const unsafeQuantity = structuredClone(validInvoice);
    unsafeQuantity.lines[0]!.quantity = Number.MAX_SAFE_INTEGER + 1;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(unsafeQuantity)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("error");

    const unsafeTotal = structuredClone(validInvoice);
    unsafeTotal.lines = [{
      description: "Large amount",
      quantity: Number.MAX_SAFE_INTEGER,
      unitPriceMinor: Number.MAX_SAFE_INTEGER,
      taxMinor: 0,
    }];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(unsafeTotal)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("error");
  });

  it("fails closed on invalid issue dates and branding CSS values", async () => {
    const invalidDate = structuredClone(validInvoice);
    invalidDate.order.createdAt = "not-a-date";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(invalidDate)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("error");

    const invalidAccent = structuredClone(validInvoice);
    invalidAccent.branding.accentColor = "red; background-image: url(javascript:alert(1))";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(invalidAccent)));
    expect((await fetchPrintInvoice("order-1")).status).toBe("error");
  });

  it("fails closed when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    expect((await fetchPrintInvoice("order-1")).status).toBe("error");
  });
});
