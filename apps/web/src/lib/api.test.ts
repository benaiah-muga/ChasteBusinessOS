import { afterEach, describe, expect, it, vi } from "vitest";
import { postApi } from "./api";

/**
 * B02 client identity proof: the single UI/API seam stamps every mutating
 * request with an intentId unless the caller brought one, so kernel receipts
 * can reconcile retries; explicit identities win; non-object bodies pass
 * through untouched.
 */

const sentBodies: unknown[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sentBodies.length = 0;
});

describe("postApi intent identity", () => {
  it("stamps an object body with a fresh intentId and varies it per call", async () => {
    stubFetch();
    await postApi("/api/x", { action: "createInvoice", customerId: "c1" });
    await postApi("/api/x", { action: "createInvoice", customerId: "c1" });
    const [first, second] = sentBodies as [{ intentId?: string }, { intentId?: string }];
    expect(first.intentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.intentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.intentId).not.toEqual(first.intentId);
  });

  it("preserves an explicit caller intentId", async () => {
    stubFetch();
    await postApi("/api/x", { action: "payBill", intentId: "fixed-intent" });
    expect((sentBodies[0] as { intentId: string }).intentId).toBe("fixed-intent");
  });

  it("leaves non-object bodies untouched", async () => {
    stubFetch();
    await postApi("/api/x", null);
    await postApi("/api/x", "raw");
    await postApi("/api/x", ["a"]);
    expect(sentBodies[0]).toBeNull();
    expect(sentBodies[1]).toBe("raw");
    expect(sentBodies[2]).toEqual(["a"]);
  });
});
